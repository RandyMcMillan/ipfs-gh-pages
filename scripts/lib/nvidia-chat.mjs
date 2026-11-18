// Shared minimal client for the NVIDIA build API (OpenAI-compatible
// chat completions). Used by scripts/nvidia-ai.mjs and scripts/nvidia-ai-triage.mjs.
//
// kimi-k2.8-preview is not on the catalog and 404s; kimi-k3.1-pro is the
// kimi model currently available there.
//
// Every network await is bounded (120s). Returns either
//   { ok: true, content, usage, statusMs, model }
// or
//   { ok: false, warning }
// — callers decide how to degrade (repo idiom: print ::warning:: and
// continue, never fail the build). The API key is never logged.

export const DEFAULT_MODEL = 'moonshotai/kimi-k3.1-pro';
export const DEFAULT_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const REQUEST_TIMEOUT_MS = 120_000;

export async function nvidiaChat({
  prompt,
  apiKey,
  model = DEFAULT_MODEL,
  apiUrl = process.env.NVIDIA_API_URL || DEFAULT_API_URL,
  maxTokens = 1024,
  reasoningEffort = 'high',
  seed = 0,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!apiKey) {
    return { ok: false, warning: 'NVIDIA_API_KEY is not set; skipping AI call. Add it as a repository secret to enable.' };
  }

  const payload = {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    model,
    max_tokens: maxTokens,
    seed,
    stream: false,
    reasoning_effort: reasoningEffort,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, warning: `NVIDIA API request failed (${err.name === 'AbortError' ? `timeout after ${timeoutMs / 1000}s` : err.message}); continuing without AI review` };
  }
  clearTimeout(timer);
  const statusMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 500);
    return { ok: false, warning: `NVIDIA API returned HTTP ${response.status}${body ? `: ${body}` : ''}; continuing without AI review` };
  }

  const data = await response.json().catch(() => null);
  const message = data?.choices?.[0]?.message;
  // kimi reasoning models may answer in reasoning_content when content is empty
  const content = message?.content || message?.reasoning_content;
  if (!content) {
    return { ok: false, warning: 'NVIDIA API response had no choices; continuing without AI review' };
  }

  return { ok: true, content, usage: data.usage || null, statusMs, model };
}
