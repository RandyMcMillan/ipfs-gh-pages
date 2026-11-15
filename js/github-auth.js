// GitHub OAuth DEVICE flow — secretless auth for the issues bridge
// (js/github-issues.js). Right for a GitHub Pages plugin: no client secret
// to leak, no per-consumer redirect URI to register (the web flow would
// need one callback per deployed Pages URL — impossible for a plugin).
// The user enters a code at github.com/login/device; this module polls and
// returns their token. Pure + injectable for tests; no network outside the
// injectable fetchImpl.
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// Minimal scopes: public_repo covers issue/comment read+write on public
// repos. (Private repos = user opts into `repo` later.)
// Endpoints are injectable because github.com/login/* sends no CORS headers
// — a browser page cannot call it directly (verified: fetch fails with a
// network error, not a GitHub response). Deploy a tiny relay on an origin
// you control (it only forwards these two requests; the token passes
// through at auth time, same trust as this app) and pass its base URL.
export async function startDeviceFlow(clientId, { scope = 'public_repo', fetchImpl = fetch, baseUrl = '' } = {}) {
  const codeUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/device/code` : DEVICE_CODE_URL;
  const res = await fetchImpl(codeUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope })
  });
  if (!res.ok) throw new Error(`device code HTTP ${res.status}`);
  return res.json(); // {device_code, user_code, verification_uri, expires_in, interval}
}

// Poll until authorized/denied/expired. Resolves {token} — the app stores
// it under the same localStorage key as the PAT fallback.
export async function pollDeviceToken(clientId, deviceCode, { interval = 5, fetchImpl = fetch, signal, baseUrl = '' } = {}) {
  const tokenUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/oauth/access_token` : ACCESS_TOKEN_URL;
  for (;;) {
    await new Promise((r) => setTimeout(r, Math.max(1, interval) * 1000));
    if (signal?.aborted) throw new Error('authorization cancelled');
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT })
    });
    if (!res.ok) throw new Error(`token poll HTTP ${res.status}`);
    const out = await res.json();
    if (out.access_token) return { token: out.access_token, scope: out.scope || '' };
    if (out.error === 'authorization_pending') continue;
    if (out.error === 'slow_down') { interval += 5; continue; }
    if (out.error === 'access_denied') throw new Error('authorization denied');
    if (out.error === 'expired_token') throw new Error('device code expired — start again');
    throw new Error(`device flow error: ${out.error || 'unknown'}`);
  }
}
