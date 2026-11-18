#!/usr/bin/env node
// AI-assisted CI review via the NVIDIA build API (OpenAI-compatible
// chat completions; shared client in scripts/lib/nvidia-chat.mjs).
//
// Usage (CI):
//   node scripts/nvidia-ai.mjs
//
// Env:
//   NVIDIA_API_KEY    required; missing -> ::warning:: and exit 0 (never fails the build)
//   NVIDIA_MODEL      default moonshotai/kimi-k3.1-pro
//   NVIDIA_API_URL    default https://integrate.api.nvidia.com/v1/chat/completions
//   GH_EVENT          github.event_name; "pull_request" diffs against the base ref
//   GH_BASE_REF       github.base_ref (PR target branch)
//   AI_PROMPT         override the review prompt entirely
//   AI_DIFF_MAX_CHARS truncate the diff fed to the model (default 20000)
//   VERBOSE=1         log model/endpoint/diff size, HTTP status + latency, usage

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { nvidiaChat, DEFAULT_MODEL } from './lib/nvidia-chat.mjs';

const MODEL = process.env.NVIDIA_MODEL || DEFAULT_MODEL;
const DIFF_MAX = Number(process.env.AI_DIFF_MAX_CHARS || 20000);
const apiKey = process.env.NVIDIA_API_KEY;

function warn(message) {
  console.log(`::warning::${message}`);
}

// VERBOSE=1 (matching npm run test:verbose) logs request details — never
// the API key.
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';
function verbose(...args) {
  if (VERBOSE) console.log('[nvidia-ai]', ...args);
}

if (!apiKey) {
  warn('NVIDIA_API_KEY is not set; skipping AI review. Add it as a repository secret to enable.');
  process.exit(0);
}

function gitDiff() {
  try {
    if (process.env.GH_EVENT === 'pull_request' && process.env.GH_BASE_REF) {
      execFileSync('git', ['fetch', '--depth=1', 'origin', process.env.GH_BASE_REF], { stdio: 'pipe' });
      return execFileSync('git', ['diff', `origin/${process.env.GH_BASE_REF}...HEAD`], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
    }
    return execFileSync('git', ['diff', 'HEAD~1..HEAD'], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (err) {
    warn(`could not compute git diff: ${err.message}; sending prompt without diff`);
    return '';
  }
}

const diff = gitDiff().slice(0, DIFF_MAX);
verbose(`model=${MODEL} endpoint=${process.env.NVIDIA_API_URL || 'default'} event=${process.env.GH_EVENT || 'local'} diff_chars=${diff.length}`);

const prompt = process.env.AI_PROMPT || [
  'You are reviewing a commit in a CI pipeline for the ipfs-gh-pages project.',
  'Briefly review the following git diff: flag bugs, regressions, and missing tests.',
  'Answer in short Markdown (headings + bullets), at most 400 words.',
  diff ? `## git diff\n\`\`\`diff\n${diff}\n\`\`\`` : '(no diff available — review the repository state generally)',
].join('\n\n');

// 'high' reasoning effort on a multi-kilobyte diff exceeds the default
// 120s client timeout (seen on the v4.0.0 push: timed out, job stayed
// green via warn-and-continue but produced no review); 'medium' with a
// 5-minute bound completes reliably.
const result = await nvidiaChat({ prompt, apiKey, model: MODEL, maxTokens: 1024, reasoningEffort: 'medium', timeoutMs: 300_000 });
if (!result.ok) {
  warn(result.warning);
  process.exit(0);
}
verbose(`HTTP 200 in ${result.statusMs}ms`);

console.log(`## AI review (NVIDIA · ${MODEL})\n`);
console.log(result.content);
if (result.usage) {
  verbose(`usage: prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} total=${result.usage.total_tokens}`);
  console.log(`\n<!-- usage: prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} total=${result.usage.total_tokens} -->`);
}

// Hand the Markdown to the workflow's PR-comment step.
try {
  writeFileSync('ai-review.md', `### AI review (NVIDIA · ${MODEL})\n\n${result.content}\n`);
} catch (err) {
  warn(`could not write ai-review.md: ${err.message}`);
}
