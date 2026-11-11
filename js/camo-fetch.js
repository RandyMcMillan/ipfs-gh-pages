// Camo's fetch rulebook (docs/ipfs-rehost-service.md), shared by the node
// service (scripts/rehost-service.mjs) and the browser bridge
// (js/ipfs-node.js 'rehost' op). Environment-agnostic: plain fetch +
// AbortSignal, so the exact same rules run in node and in the webview.
//
// Rules (ported from camo's server.coffee): image MIME whitelist, 5 MB
// cap (declared AND streamed), 4-redirect depth, 10 s per-try timeout,
// cookies stripped, Via self-guard token, SSRF guard (private/loopback/
// link-local refused unless REHOST_ALLOW_PRIVATE=1 — tests/local only).

export const MIME_WHITELIST = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'image/svg+xml', 'image/x-icon', 'image/bmp', 'image/tiff'
]);
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 4;
export const TIMEOUT_MS = 10000;
export const VIA = 'ipfs-rehost/1.0';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|f[cd])/i;

export class RehostError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function assertFetchable(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RehostError(400, `unsupported protocol: ${u.protocol}`);
  }
  if (!process.env.REHOST_ALLOW_PRIVATE && PRIVATE_HOST.test(u.hostname)) {
    throw new RehostError(403, `refusing private/loopback host: ${u.hostname}`);
  }
  return u;
}

// Fetch with camo's rules. Returns { bytes, contentType, finalUrl }.
export async function fetchAsset(url, fetchImpl = fetch) {
  let current = assertFetchable(url).toString();
  for (let redirects = 0; ; redirects++) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      headers: { Accept: 'image/*', 'Accept-Encoding': 'identity', Via: VIA },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status >= 301 && res.status <= 308) {
      const loc = res.headers.get('location');
      if (!loc) throw new RehostError(502, 'redirect with no location');
      if (redirects >= MAX_REDIRECTS) throw new RehostError(508, 'redirect depth exceeded');
      current = new URL(loc, current).toString();
      assertFetchable(current);
      continue;
    }
    if (!res.ok) throw new RehostError(502, `origin HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!MIME_WHITELIST.has(contentType)) {
      throw new RehostError(415, `non-image content-type: ${contentType || 'none'}`);
    }
    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared > MAX_BYTES) throw new RehostError(413, `content-length ${declared} > ${MAX_BYTES}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_BYTES) throw new RehostError(413, `streamed size > ${MAX_BYTES}`);
      chunks.push(chunk);
    }
    // Plain Uint8Array concat — Buffer does not exist in the webview.
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    return { bytes, contentType, finalUrl: current };
  }
}
