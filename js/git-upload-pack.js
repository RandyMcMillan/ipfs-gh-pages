// In-process git upload-pack (docs/git-over-ipfs.md phase 9 step 2).
// Pure: given a GitStore, produce the smart-protocol responses a git
// client expects — the info/refs advertisement and a (delta-free, since
// undeltified packs are legal) packfile for want/have negotiation.
// Tests clone from this with the real git CLI over a node HTTP stub.

import { zlibSync } from 'fflate';
import { sha1Hex } from './git-objects.js';

const encoder = new TextEncoder();

export function pktLine(payload) {
  const bytes = encoder.encode(payload);
  const len = bytes.length + 4;
  return `${len.toString(16).padStart(4, '0')}${payload}`;
}

export const FLUSH_PKT = '0000';

const CAPABILITIES = 'multi_ack_detailed multi_ack thin-pack ofs-delta side-band-64k';

// GET /info/refs?service=git-upload-pack response body.
export function uploadPackRefs(store) {
  const { head, refs } = store.refs();
  const lines = [pktLine('# service=git-upload-pack\n'), FLUSH_PKT];
  const headSha = head.sha || (refs[0] && refs[0].sha);
  if (headSha) {
    let firstCaps = CAPABILITIES;
    if (head.ref) firstCaps += ` symref=HEAD:${head.ref}`;
    lines.push(pktLine(`${headSha} HEAD\0${firstCaps}\n`));
  }
  for (const { name, sha } of refs) lines.push(pktLine(`${sha} ${name}\n`));
  lines.push(FLUSH_PKT);
  return encoder.encode(lines.join(''));
}

// Reachable-object closure: everything reachable from `tips` (commits,
// their trees/blobs, tags + targets), minus `exclude` (already-have
// closure) and anything visited.
export function closure(store, tips, exclude = new Set()) {
  const objects = new Map(); // sha -> {type, data}
  const visit = (sha) => {
    if (!sha || objects.has(sha) || exclude.has(sha)) return;
    const raw = store.readRaw(sha);
    if (!raw) throw new Error(`missing object ${sha}`);
    objects.set(sha, raw);
    if (raw.type === 'commit') {
      const text = new TextDecoder().decode(raw.data);
      const tree = text.split('\n').find((l) => l.startsWith('tree '))?.slice(5);
      visit(tree);
      for (const line of text.split('\n')) {
        if (line.startsWith('parent ')) visit(line.slice(7));
      }
    } else if (raw.type === 'tag') {
      const text = new TextDecoder().decode(raw.data);
      const target = text.split('\n').find((l) => l.startsWith('object '))?.slice(7);
      visit(target);
    } else if (raw.type === 'tree') {
      for (const entry of store.catFile(sha).entries) {
        if (entry.type !== 'commit') visit(entry.sha); // skip submodules
      }
    }
  };
  for (const tip of tips) visit(tip);
  return objects;
}

// Parse a /git-upload-pack request body into wants/haves/done. Stateless
// RPC bodies look like: want-lines, flush, have-lines, flush, "done" —
// flush-pkts SEPARATE the sections, so skip them, never stop at them.
export function parseUploadPackRequest(body) {
  const wants = [];
  const haves = [];
  let done = false;
  let caps = [];
  let pos = 0;
  // Normalize: callers hand us strings, byte buffers, or arrays of chunks
  // (isomorphic-git builds its request body as an array of pkt-lines).
  let text;
  if (typeof body === 'string') {
    text = body;
  } else if (Array.isArray(body)) {
    const parts = body.map((c) => (typeof c === 'string' ? c : new TextDecoder().decode(c)));
    text = parts.join('');
  } else {
    text = new TextDecoder().decode(body);
  }
  while (pos + 4 <= text.length) {
    const len = parseInt(text.slice(pos, pos + 4), 16);
    if (Number.isNaN(len)) break;
    pos += 4;
    if (len === 0) continue; // flush-pkt
    const line = text.slice(pos, pos + len - 4);
    pos += len - 4;
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim().split(' ');
      wants.push(rest[0]);
      if (rest.length > 1 && caps.length === 0) caps = rest.slice(1);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('done')) {
      done = true;
    }
    // deepen/capability lines we don't support are ignored
  }
  return { wants, haves, done, caps };
}

const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packEntryHeader(type, size) {
  const bytes = [];
  let first = (TYPE_CODES[type] << 4) | (size & 15);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

// Serialize objects into a packfile (undeltified; legal per the pack spec).
export function writePack(objects) {
  const chunks = [];
  const header = encoder.encode(`PACK${String.fromCharCode(0, 0, 0, 2)}`);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, objects.size);
  chunks.push(header, count);
  for (const [, raw] of objects) {
    chunks.push(packEntryHeader(raw.type, raw.data.length));
    chunks.push(zlibSync(raw.data));
  }
  const body = concat(chunks);
  // Pack checksum: sha1 over everything before the trailer.
  const digest = hexToBytes(sha1Hex(body));
  const out = new Uint8Array(body.length + 20);
  out.set(body, 0);
  out.set(digest, body.length);
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// POST /git-upload-pack response. Without "done" this is a negotiation
// round: answer NAK so the client continues. With "done": when the client
// negotiated multi_ack, the final ACK precedes the pack; sideband the rest.
// `objects` returned for introspection/tests.
export function uploadPack(store, wants, haves = [], { done = true, caps = [] } = {}) {
  if (!done) {
    return { pack: null, body: encoder.encode(pktLine('NAK\n')), objectCount: 0 };
  }
  const exclude = closure(store, haves, new Set());
  const objects = closure(store, wants, new Set([...exclude.keys()]));
  const pack = writePack(objects);

  const ack = caps.some((c) => c.startsWith('multi_ack'))
    ? pktLine(`ACK ${haves[0] || wants[0]}\n`)
    : '';

  // Side-band-64k framing: channel 1 = pack data, channel 2 = progress.
  // Lengths are ASCII pkt-line headers (4 hex chars + 1 channel byte).
  const frame = (channel, payload) => {
    const out = [];
    for (let off = 0; off < payload.length; off += 65519) {
      const chunk = payload.subarray(off, Math.min(off + 65519, payload.length));
      const head = encoder.encode((chunk.length + 5).toString(16).padStart(4, '0'));
      out.push(head, new Uint8Array([channel]), chunk);
    }
    return out;
  };
  const chunks = [
    encoder.encode(ack),
    ...frame(2, encoder.encode(`packing ${objects.size} objects\n`)),
    ...frame(1, pack),
    encoder.encode('0000'),
  ];
  return { pack, body: concat(chunks), objectCount: objects.size };
}
