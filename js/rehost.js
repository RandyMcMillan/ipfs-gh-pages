// Browser-side rehost helper (docs/ipfs-rehost-service.md phase 2): given a
// remote image URL, ask a rehost service for its CID once and use the
// content-addressed URL forever after. The renderer calls this when the
// image policy is "rehost"; on any failure it returns null so the caller
// can fall back to the policy's other mode.
//
// Pure decision logic lives here (unit-tested); fetch/cache side effects
// are injectable.

// Which URLs are worth rehosting: plain remote http(s) only. ipfs:// and
// gateway URLs are already content-addressed; data: is already inline;
// relative URLs resolve against the repo bundle (no third party to hide).
export function shouldRehost(rawUrl) {
  try {
    const u = new URL(rawUrl, 'https://placeholder.invalid');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname !== 'placeholder.invalid';
    }
    return false;
  } catch {
    return false;
  }
}

// Map a rehost service response onto the URL the <img> should carry.
// Order: ipfs:// is NOT img-compatible everywhere, so the https gateway
// form wins for src; the ipfs:// URI rides along for the affordances.
export function rehostedSrc(response, gatewayBase = 'https://ipfs.io') {
  if (!response || !response.cid) return null;
  return `${gatewayBase.replace(/\/$/, '')}/ipfs/${response.cid}`;
}

// The full operation, injectable for tests. Returns { cid, src } or null.
export async function rehostAndRewrite(rawUrl, { endpoint, fetchImpl = fetch, cache, gatewayBase } = {}) {
  if (!shouldRehost(rawUrl)) return null;
  if (!endpoint) return null;
  const cacheKey = `rehost:${rawUrl}`;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }
  try {
    const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}/rehost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: rawUrl }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const out = await res.json();
    const src = rehostedSrc(out, gatewayBase);
    if (!src) return null;
    const result = { cid: out.cid, src, ipfsUri: `ipfs://${out.cid}` };
    if (cache) cache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}
