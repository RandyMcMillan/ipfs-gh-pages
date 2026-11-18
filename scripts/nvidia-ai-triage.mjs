#!/usr/bin/env node
// AI failure triage: reads a failed workflow run's job logs, asks the
// NVIDIA build API for a diagnosis, and comments it on the associated PR.
//
// Triggered by .github/workflows/ai-triage.yml (workflow_run: completed
// with conclusion=failure). Also runnable locally against any failed run:
//
//   WORKFLOW_RUN_ID=<id> node scripts/nvidia-ai-triage.mjs
//
// gh CLI provides auth (GH_TOKEN / GITHUB_TOKEN in CI; local gh login
// otherwise). The diagnosis is advisory: API/key errors print ::warning::
// and exit 0, never failing the triage job.
//
// Env:
//   WORKFLOW_RUN_ID   run to triage; defaults to github.event.workflow_run.id
//   GITHUB_EVENT_PATH workflow_run event payload (set by the runner)
//   GITHUB_REPOSITORY owner/repo; defaults to the origin remote
//   NVIDIA_API_KEY    required; missing -> ::warning:: and exit 0
//   NVIDIA_MODEL      default moonshotai/kimi-k3.1-pro
//   LOG_MAX_CHARS     total log excerpt budget fed to the model (default 12000)
//   VERBOSE=1         log run id, PR, log sizes, HTTP latency, usage

import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nvidiaChat, DEFAULT_MODEL } from './lib/nvidia-chat.mjs';

const MODEL = process.env.NVIDIA_MODEL || DEFAULT_MODEL;
const LOG_MAX = Number(process.env.LOG_MAX_CHARS || 12000);
const MAX_JOBS = 8;
const TAIL_LINES = 150;
const apiKey = process.env.NVIDIA_API_KEY;
const GH_TIMEOUT_MS = 60_000;

function warn(message) {
  console.log(`::warning::${message}`);
}

const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';
function verbose(...args) {
  if (VERBOSE) console.log('[ai-triage]', ...args);
}

function die(message) {
  console.error(`ai-triage: ${message}`);
  process.exit(1);
}

function gh(args, { json = true, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const out = execFileSync('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = out.toString();
  return json ? JSON.parse(text) : text;
}

// --- resolve the run -------------------------------------------------------

let runId = process.env.WORKFLOW_RUN_ID;
if (!runId && process.env.GITHUB_EVENT_PATH) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    runId = event.workflow_run?.id;
  } catch (err) {
    die(`could not read ${process.env.GITHUB_EVENT_PATH}: ${err.message}`);
  }
}
if (!runId) die('no run id: set WORKFLOW_RUN_ID or run from a workflow_run event');

let repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match) die(`could not determine repository from origin remote: ${remote}`);
  repo = match[1];
}

verbose(`repo=${repo} run=${runId}`);

const run = gh(['api', `repos/${repo}/actions/runs/${runId}`]);
if (run.conclusion !== 'failure') {
  console.log(`run ${runId} conclusion is '${run.conclusion}', not 'failure' — nothing to triage`);
  process.exit(0);
}

// run.pull_requests is often empty (GitHub only fills it for
// pull_request events), so fall back to looking up PRs by head SHA.
let prNumber = run.pull_requests?.[0]?.number || null;
if (!prNumber) {
  try {
    const prs = gh(['api', `repos/${repo}/commits/${run.head_sha}/pulls`, '-H', 'Accept: application/vnd.github.v3+json']);
    prNumber = prs[0]?.number || null;
  } catch {
    // no associated PRs — diagnosis goes to the step summary only
  }
}
const marker = `<!-- ai-triage run=${run.id} attempt=${run.run_attempt} -->`;
verbose(`workflow=${run.name} attempt=${run.run_attempt} pr=${prNumber ?? 'none'}`);

// --- gather failing log excerpts -------------------------------------------

// Pre-filter each failed job's log down to error windows (matching lines
// plus context) BEFORE sending anything to the model — raw log tails make
// the request slow, expensive, and can return empty completions. gh
// fetches; the filtering happens here so it is testable and shell-safe.
const ERROR_RE = /::error::|error:|Error|FAIL|failed|panicked/;

function extractErrorWindows(text, { context = 5, maxLines = 200 } = {}) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (ERROR_RE.test(line)) hits.push(i);
  });
  if (!hits.length) return null; // caller falls back to a plain tail
  const keep = new Set();
  for (const i of hits) {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
  }
  const out = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (out.length >= maxLines) break;
    if (prev >= 0 && i > prev + 1) out.push('---');
    out.push(lines[i]);
    prev = i;
  }
  return out.join('\n');
}

let excerptParts = [];
try {
  const pages = gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs`, '--paginate']);
  const jobs = (Array.isArray(pages) ? pages : [pages])
    .flatMap((page) => page.jobs || [])
    .filter((j) => j.conclusion === 'failure');
  verbose(`failed jobs=${jobs.length}`);
  const scored = jobs.slice(0, MAX_JOBS).map((job) => {
    const text = execFileSync('gh', ['run', 'view', String(run.id), '--job', String(job.id), '--log', '--repo', repo], {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const filtered = extractErrorWindows(text);
    const tail = (filtered ?? text.split('\n').slice(-TAIL_LINES).join('\n'));
    return { entry: job.name, tail, score: (tail.match(ERROR_RE) || []).length };
  }).sort((a, b) => b.score - a.score);

  let budget = LOG_MAX;
  for (const { entry, tail } of scored) {
    if (budget <= 0) break;
    const part = tail.length > budget ? tail.slice(0, budget) : tail;
    budget -= part.length;
    excerptParts.push(`### ${entry}\n\`\`\`\n${part}\n\`\`\``);
  }
} catch (err) {
  warn(`could not fetch run logs: ${err.message}; triaging without logs`);
}
const excerpts = excerptParts.length ? excerptParts.join('\n\n') : '(no log excerpts available)';
verbose(`excerpt_chars=${excerpts.length}`);

// --- ask the model ---------------------------------------------------------

if (!apiKey) {
  warn('NVIDIA_API_KEY is not set; skipping AI triage. Add it as a repository secret to enable.');
  process.exit(0);
}

const prompt = [
  `You are triaging a failed GitHub Actions run in the ${repo} project.`,
  `Workflow: "${run.name}" · branch: ${run.head_branch} · commit: ${run.head_sha} · attempt: ${run.run_attempt}.`,
  '',
  '1. Identify the most likely root cause (one short paragraph).',
  '2. List concrete fix steps (numbered).',
  '3. Name the file or area to look at first.',
  '',
  'Answer in Markdown, at most 300 words. If the excerpts are insufficient, say what log context you need.',
  '',
  '## Failed log excerpts',
  excerpts,
].join('\n');

// 'high' reasoning effort on multi-kilobyte log tails regularly exceeds
// 5 minutes on this model; 'medium' reliably answers inside the timeout.
const result = await nvidiaChat({ prompt, apiKey, model: MODEL, maxTokens: 2048, reasoningEffort: 'medium', timeoutMs: 240_000 });
if (!result.ok) {
  warn(result.warning);
  process.exit(0);
}
verbose(`HTTP 200 in ${result.statusMs}ms`);
if (result.finishReason && result.finishReason !== 'stop') {
  warn(`triage may be truncated (finish_reason=${result.finishReason})`);
}

const usageComment = result.usage
  ? `\n<!-- usage: prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} total=${result.usage.total_tokens} -->`
  : '';

const body = [
  `### 🤖 AI triage: ${run.name} failed`,
  '',
  `Run: [${run.head_sha}](${run.html_url}) (attempt ${run.run_attempt}) · branch \`${run.head_branch}\``,
  '',
  result.content,
  '',
  marker,
  usageComment,
].join('\n');

console.log(body);

// --- deliver: PR comment when possible, step summary always ----------------

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
}

if (!prNumber) {
  console.log('(no PR associated with this run; diagnosis printed above only)');
  process.exit(0);
}

// Skip if this exact run+attempt was already triaged (re-run protection).
const comments = gh(['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate'], { maxBuffer: 16 * 1024 * 1024 });
if (comments.some((c) => typeof c.body === 'string' && c.body.includes(marker))) {
  console.log(`PR #${prNumber} already has a triage comment for this run+attempt; skipping`);
  process.exit(0);
}

const commentFile = join(mkdtempSync(join(tmpdir(), 'ai-triage-comment-')), 'body.md');
writeFileSync(commentFile, body);
gh(['api', `repos/${repo}/issues/${prNumber}/comments`, '-F', `body=@${commentFile}`], { json: false });
console.log(`posted triage comment to PR #${prNumber}`);
