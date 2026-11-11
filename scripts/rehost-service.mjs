// IPFS rehost service (docs/ipfs-rehost-service.md, tier 1) — the
// decentralized camo: fetch an http(s) asset ONCE with camo's safety
// rulebook and re-host it on IPFS, so rendered content can use
// content-addressed URLs instead of live third-party embeds.
//
//   POST /rehost            { "url": "https://…/img.png" }   → { cid, … }
//   GET  /rehost?url=…      (same, for <img> tags)
//   GET  /status
//
// Camo rules (ported from server.coffee): MIME whitelist (images), 5 MB
// cap, 4-redirect depth, 10 s timeout, cookies stripped, Via self-guard,
// SSRF guard (private/loopback/link-local hosts refused unless
// REHOST_ALLOW_PRIVATE=1 — tests/local only), optional HMAC minting:
// with CAMO_KEY set, requests must carry ?digest=<hmac-sha256-hex of url>.
//
// The CID is computed in-process (@helia/unixfs, raw-leaf CIDv1 — the same
// bytes an `ipfs add` of the file produces); with KUBO_RPC set the result
// is also pinned there (best effort — optional service).
//
// Env: PORT (default 8081), HOST (default 127.0.0.1), CAMO_KEY (optional),
// KUBO_RPC (optional), REHOST_CACHE (default .rehost-cache.json),
// REHOST_ALLOW_PRIVATE=1 (tests/local only).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';

const MIME_WHITELIST = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'image/svg+xml', 'image/x-icon', 'image/bmp', 'image/tiff'
]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10000;
const VIA = 'ipfs-rehost/1.0';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|f[cd])/i;

export class RehostError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertFetchable(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RehostError(400, `unsupported protocol: ${u.protocol}`);
  }
  if (!process.env.REHOST_ALLOW_PRIVATE && PRIVATE_HOST.test(u.hostname)) {
    throw new RehostError(403, `refusing private/loopback host: ${u.hostname}`);
  }
  return u;
}

// Fetch with camo's rules: manual redirects (bounded), per-try timeout,
// cookies stripped, image Accept, size cap (declared AND streamed), MIME
// whitelist. Returns { bytes, contentType, finalUrl }.
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
    return { bytes: Buffer.concat(chunks), contentType, finalUrl: current };
  }
}

// In-process UnixFS add (raw-leaf CIDv1 — same bytes `ipfs add` yields).
export async function addBytes(bytes, helia) {
  const node = helia || await createHelia();
  const cid = await unixfs(node).addBytes(bytes);
  return cid.toString();
}

async function pinOnKubo(cid) {
  const KUBO_RPC = (process.env.KUBO_RPC || '').replace(/\/$/, '');
  if (!KUBO_RPC) return null;
  const res = await fetch(`${KUBO_RPC}/api/v0/pin/add?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new RehostError(502, `kubo pin/add HTTP ${res.status}`);
  return 'pinned';
}

const loadCache = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};

export function createRehostServer({ cacheFile = process.env.REHOST_CACHE || '.rehost-cache.json', helia } = {}) {
  const cache = loadCache(cacheFile);
  const save = () => {
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); } catch {}
  };

  return http.createServer(async (req, res) => {
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/status') return send(200, { ok: true, via: VIA, cached: Object.keys(cache).length });
      if (u.pathname !== '/rehost') return send(404, { error: 'not found' });
      // Camo's Via self-guard: a request already carrying our Via is a loop.
      if ((req.headers.via || '').includes(VIA)) return send(508, { error: 'rehost loop' });

      let target = u.searchParams.get('url');
      if (req.method === 'POST') {
        const body = await new Promise((resolve) => {
          let b = '';
          req.on('data', (c) => { b += c; });
          req.on('end', () => resolve(b));
        });
        try { target = target || JSON.parse(body).url; } catch {}
      }
      if (!target) return send(400, { error: 'url required' });

      const key = process.env.CAMO_KEY || '';
      if (key) {
        const digest = u.searchParams.get('digest') || '';
        const expect = crypto.createHmac('sha256', key).update(target, 'utf8').digest('hex');
        if (digest !== expect) return send(403, { error: 'digest mismatch' });
      }

      if (cache[target]) return send(200, { ...cache[target], cached: true });

      const { bytes, contentType, finalUrl } = await fetchAsset(target);
      const cid = await addBytes(bytes, helia);
      const pinned = await pinOnKubo(cid).catch(() => null);
      const out = {
        cid,
        url: target,
        finalUrl,
        size: bytes.length,
        contentType,
        pinned: Boolean(pinned),
        gateways: [`ipfs://${cid}`, `https://ipfs.io/ipfs/${cid}`, `https://${cid}.ipfs.dweb.link`]
      };
      cache[target] = out;
      save();
      send(200, out);
    } catch (e) {
      send(e.status || 500, { error: e.message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const port = parseInt(process.env.PORT || '8081', 10);
  const host = process.env.HOST || '127.0.0.1';
  createRehostServer().listen(port, host, () => {
    console.log(`ipfs-rehost listening on http://${host}:${port} (camo rules; ${process.env.CAMO_KEY ? 'HMAC minting ON' : 'open (set CAMO_KEY to gate)'})`);
  });
}
