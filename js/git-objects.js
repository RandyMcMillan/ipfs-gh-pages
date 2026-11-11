// Pure git object-store reading over an in-memory bare-repo tree
// (docs/git-over-ipfs.md phase 9 step 1). No browser APIs, no Helia
// imports: the bridge feeds this a Map from its unixfs walk; node tests
// feed it a fixture repo built with the git CLI. Covers loose objects,
// packfiles with OFS/REF deltas, refs (loose + packed-refs), and
// commit/tree/blob/tag materialization.

import { unzlibSync } from 'fflate';

const textDecoder = new TextDecoder();

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sha1Hex(bytes) {
  // SHA-1 in ~15 lines (FIPS 180-1) — avoids pulling a crypto dep into
  // the browser bundle just for REF_DELTA base resolution.
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const ml = bytes.length * 8;
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 8, Math.floor(ml / 0x100000000));
  view.setUint32(withPad.length - 4, ml >>> 0);
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  const w = new Uint32Array(80);
  for (let block = 0; block < withPad.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = rol(a, 5) + f + e + k + w[i];
      e = d; d = c; c = rol(b, 30); b = a; a = tmp | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export function parseLooseObject(bytes) {
  const raw = unzlibSync(bytes);
  const nul = raw.indexOf(0);
  const header = textDecoder.decode(raw.subarray(0, nul));
  const sp = header.indexOf(' ');
  return { type: header.slice(0, sp), data: raw.subarray(nul + 1) };
}

// ---- packfiles ---------------------------------------------------------------

// Parse a pack .idx v2 into { shas: [hex...], offsetOf: Map<hex, offset> }.
export function parsePackIdx(idxBytes) {
  const view = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
  if (view.getUint32(0) !== 0xff744f63) throw new Error('not a pack idx v2 (bad magic)');
  if (view.getUint32(4) !== 2) throw new Error('unsupported pack idx version');
  const fanoutBase = 8;
  const count = view.getUint32(fanoutBase + 255 * 4);
  const shaBase = fanoutBase + 256 * 4;
  const crcBase = shaBase + count * 20;
  const offBase = crcBase + count * 4;
  const largeBase = offBase + count * 4;
  const shas = [];
  const offsetOf = new Map();
  for (let i = 0; i < count; i++) {
    const sha = hex(idxBytes.subarray(shaBase + i * 20, shaBase + i * 20 + 20));
    let off = view.getUint32(offBase + i * 4);
    if (off & 0x80000000) {
      off = view.getUint32(largeBase + (off & 0x7fffffff) * 8) * 0x100000000
          + view.getUint32(largeBase + (off & 0x7fffffff) * 8 + 4);
    }
    shas.push(sha);
    offsetOf.set(sha, off);
  }
  return { shas, offsetOf };
}

function readVarintSize(pack, offset) {
  // First byte: type in bits 4-6, size low 4 bits, MSB continuation.
  let b = pack[offset];
  let type = (b >> 4) & 7;
  let size = b & 15;
  let shift = 4;
  let pos = offset + 1;
  while (b & 0x80) {
    b = pack[pos++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, dataStart: pos };
}

// Read the object at pack offset; resolves delta chains recursively.
export function readPackObject(pack, offset, idx, cache = new Map()) {
  if (cache.has(offset)) return cache.get(offset);
  const { type, size, dataStart } = readVarintSize(pack, offset);
  let result;
  if (type >= 1 && type <= 4) {
    const data = unzlibSync(pack.subarray(dataStart));
    if (data.length !== size) throw new Error(`pack entry size mismatch: header ${size}, got ${data.length}`);
    const types = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
    result = { type: types[type], data };
  } else if (type === 6) {
    // OFS_DELTA: negative offset varint (offset-encoding, not standard varint)
    let b = pack[dataStart];
    let baseDist = b & 0x7f;
    let pos = dataStart + 1;
    while (b & 0x80) {
      b = pack[pos++];
      baseDist = ((baseDist + 1) << 7) | (b & 0x7f);
    }
    const base = readPackObject(pack, offset - baseDist, idx, cache);
    const delta = unzlibSync(pack.subarray(pos));
    if (delta.length !== size) throw new Error(`delta size mismatch: header ${size}, got ${delta.length}`);
    result = { type: base.type, data: applyDelta(base.data, delta) };
  } else if (type === 7) {
    const baseSha = hex(pack.subarray(dataStart, dataStart + 20));
    const baseOffset = idx.offsetOf.get(baseSha);
    if (baseOffset === undefined) throw new Error(`REF_DELTA base ${baseSha} not in pack idx`);
    const base = readPackObject(pack, baseOffset, idx, cache);
    const delta = unzlibSync(pack.subarray(dataStart + 20));
    if (delta.length !== size) throw new Error(`delta size mismatch: header ${size}, got ${delta.length}`);
    result = { type: base.type, data: applyDelta(base.data, delta) };
  } else {
    throw new Error(`unknown pack entry type ${type} at offset ${offset}`);
  }
  // For delta entries, `size` was the DELTA size (checked above), not the
  // result size — only undeltified entries were verified against it.
  cache.set(offset, result);
  return result;
}

export function applyDelta(base, delta) {
  let pos = 0;
  const readVarint = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) return v;
    }
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error(`delta base size mismatch: ${srcSize} vs ${base.length}`);
  const outSize = readVarint();
  const chunks = [];
  let outLen = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let copyOff = 0;
      let copyLen = 0;
      for (let i = 0; i < 4; i++) if (cmd & (1 << i)) copyOff |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (cmd & (0x10 << i)) copyLen |= delta[pos++] << (8 * i);
      if (copyLen === 0) copyLen = 0x10000;
      chunks.push(base.subarray(copyOff, copyOff + copyLen));
      outLen += copyLen;
    } else if (cmd !== 0) {
      chunks.push(delta.subarray(pos, pos + cmd));
      outLen += cmd;
      pos += cmd;
    } else {
      throw new Error('delta cmd 0 is reserved');
    }
  }
  if (outLen !== outSize) throw new Error(`delta result size mismatch: ${outLen} vs ${outSize}`);
  const out = new Uint8Array(outLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---- refs --------------------------------------------------------------------

function parseRefsFileTree(files) {
  // files keys look like "refs/heads/main" relative to the repo root.
  const refs = new Map();
  for (const [path, bytes] of files) {
    if (!path.startsWith('refs/')) continue;
    const sha = textDecoder.decode(bytes).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) refs.set(path, sha);
  }
  const packed = files.get('packed-refs');
  if (packed) {
    for (const line of textDecoder.decode(packed).split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const sp = line.indexOf(' ');
      if (sp > 0) {
        const sha = line.slice(0, sp).trim();
        const name = line.slice(sp + 1).trim();
        if (/^[0-9a-f]{40}$/.test(sha) && !refs.has(name)) refs.set(name, sha);
      }
    }
  }
  return refs;
}

function parseTree(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const mode = textDecoder.decode(data.subarray(pos, sp));
    const nul = data.indexOf(0, sp + 1);
    const name = textDecoder.decode(data.subarray(sp + 1, nul));
    const sha = hex(data.subarray(nul + 1, nul + 21));
    const type = mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    entries.push({ mode, type, sha, name });
    pos = nul + 21;
  }
  return entries;
}

// ---- the store ----------------------------------------------------------------

export class GitStore {
  constructor(files) {
    this.files = files; // Map<repo-relative path, Uint8Array>
    this.packs = [];
    this.looseCache = new Map();
    for (const [path] of files) {
      if (path.endsWith('.idx')) {
        const packBytes = files.get(`${path.slice(0, -4)}.pack`);
        if (packBytes) this.packs.push({ idx: parsePackIdx(files.get(path)), pack: packBytes });
      }
    }
  }

  readRaw(sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a sha1: ${sha}`);
    if (this.looseCache.has(sha)) return this.looseCache.get(sha);
    const loose = this.files.get(`objects/${sha.slice(0, 2)}/${sha.slice(2)}`);
    let result = null;
    if (loose) {
      result = parseLooseObject(loose);
    } else {
      for (const p of this.packs) {
        const offset = p.idx.offsetOf.get(sha);
        if (offset !== undefined) {
          result = readPackObject(p.pack, offset, p.idx);
          break;
        }
      }
    }
    this.looseCache.set(sha, result);
    return result;
  }

  // { head: { ref, sha }, refs: [{ name, sha }], detached: bool }
  refs() {
    const headBytes = this.files.get('HEAD');
    if (!headBytes) throw new Error('not a git repo: HEAD missing');
    const headText = textDecoder.decode(headBytes).trim();
    let headRef = null;
    let headSha = null;
    if (headText.startsWith('ref:')) {
      headRef = headText.slice(4).trim();
      headSha = this.resolveRef(headRef);
    } else if (/^[0-9a-f]{40}$/.test(headText)) {
      headSha = headText;
    }
    const refs = [...parseRefsFileTree(this.files)].map(([name, sha]) => ({ name, sha })).sort((a, b) => a.name.localeCompare(b.name));
    return { head: { ref: headRef, sha: headSha }, refs, detached: !headRef };
  }

  resolveRef(name) {
    const loose = this.files.get(name);
    if (loose) {
      const sha = textDecoder.decode(loose).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    }
    const packed = this.files.get('packed-refs');
    if (packed) {
      for (const line of textDecoder.decode(packed).split('\n')) {
        if (line.endsWith(` ${name}`)) return line.slice(0, 40);
      }
    }
    return null;
  }

  // { type, size, text?, entries? } for commit/tag/tree/blob
  catFile(sha) {
    const raw = this.readRaw(sha);
    if (!raw) throw new Error(`object not found: ${sha}`);
    const out = { type: raw.type, size: raw.data.length };
    if (raw.type === 'commit' || raw.type === 'tag') {
      out.text = textDecoder.decode(raw.data);
    } else if (raw.type === 'tree') {
      out.entries = parseTree(raw.data);
    } else if (raw.type === 'blob') {
      out.text = textDecoder.decode(raw.data);
    }
    return out;
  }
}
