#!/usr/bin/env node
// AI-assisted CI review via the NVIDIA build API (OpenAI-compatible
// chat completions endpoint, model moonshotai/kimi-k3.1-pro — the kimi
// model currently on the NVIDIA catalog; kimi-k2.8-preview returns 404).
//
// Usage (CI):
//   node scripts/nvidia-ai.mjs
//
// Env:
//   NVIDIA_API_KEY    required; missing -> ::warning:: and exit 0 (never fails the build)
//   NVIDIA_MODEL      default moonshotai/kimi-k2.8-preview
//   NVIDIA_API_URL    default https://integrate.api.nvidia.com/v1/chat/completions
//   GH_EVENT          github.event_name; "pull_request" diffs against the base ref
//   GH_BASE_REF       github.base_ref (PR target branch)
//   AI_PROMPT         override the review prompt entirely
//   AI_DIFF_MAX_CHARS truncate the diff fed to the model (default 20000)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const INVOKE_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NVIDIA_MODEL || 'moonshotai/kimi-k3.1-pro';
const DIFF_MAX = Number(process.env.AI_DIFF_MAX_CHARS || 20000);
const REQUEST_TIMEOUT_MS = 120_000;
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
verbose(`model=${MODEL} endpoint=${INVOKE_URL} event=${process.env.GH_EVENT || 'local'} diff_chars=${diff.length}`);
const prompt = process.env.AI_PROMPT || [
  'You are reviewing a commit in a CI pipeline for the ipfs-gh-pages project.',
  'Briefly review the following git diff: flag bugs, regressions, and missing tests.',
  'Answer in short Markdown (headings + bullets), at most 400 words.',
  diff ? `## git diff\n\`\`\`diff\n${diff}\n\`\`\`` : '(no diff available — review the repository state generally)',
].join('\n\n');

const payload = {
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  model: MODEL,
  max_tokens: 1024,
  seed: 0,
  stream: true,
  stream_options: { include_usage: true },
  reasoning_effort: 'high',
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
const startedAt = Date.now();
let response;
try {
  response = await fetch(INVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  verbose(`HTTP ${response.status} in ${Date.now() - startedAt}ms`);
} catch (err) {
  warn(`NVIDIA API request failed (${err.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message}); continuing without AI review`);
  process.exit(0);
} finally {
  clearTimeout(timer);
}

if (!response.ok) {
  const body = (await response.text().catch(() => '')).slice(0, 500);
  warn(`NVIDIA API returned HTTP ${response.status}${body ? `: ${body}` : ''}; continuing without AI review`);
  process.exit(0);
}

const data = await response.json().catch(() => null);
const content = data?.choices?.[0]?.message?.content;
if (!content) {
  warn('NVIDIA API response had no choices; continuing without AI review');
  process.exit(0);
}

console.log(`## AI review (NVIDIA · ${MODEL})\n`);
console.log(content);
if (data.usage) {
  verbose(`usage: prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens} total=${data.usage.total_tokens}`);
  console.log(`\n<!-- usage: prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens} total=${data.usage.total_tokens} -->`);
}

// Hand the Markdown to the workflow's PR-comment step.
try {
  writeFileSync('ai-review.md', `### AI review (NVIDIA · ${MODEL})\n\n${content}\n`);
} catch (err) {
  warn(`could not write ai-review.md: ${err.message}`);
}
