// ipfs-gh-pages bridge backend — runs in the ratzilla page beside the
// ratzilla wasm TUI. This module OWNS the IPFS/Helia functionality; the TUI
// (and later the desktop chrome) drives it over two channels:
//
//   STATE:   window.__ipfsState  — plain JSON, polled by Rust every frame
//   COMMAND: window.__ipfsCmd(id, op, arg) — async ops, results keyed by id
//            in __ipfsState.results[id] = { ok: true, value } | { ok: false, error }
//
// Backend protocol parity with main.js (the vite app) is a hard contract —
// the two surfaces MUST interoperate:
//   - repoFullName derivation: Pages origin, then build-time identity
//     (esbuild --define, same resolution order as vite's repo-identity
//     plugin), then the gnostr fallback main.js uses.
//   - identity key: localStorage `ipns-branch-key:<repoFullName>`, Ed25519
//     raw bytes base64 — notes/chat signed here verify in main.js and
//     vice versa (P7 envelope scheme).
//   - gossipsub topics: `repo-gossip:<repo>` and `:chat` subtopic,
//     emitSelf off, self-render own messages.
//   - blocklist: localStorage `blocked-peers`, enforced on connection:open
//     (inbound included).
//   - bootstrap: bootstrap.libp2p.io peers (main.js list).
//   - shareable multiaddr preference: webrtc > wss > circuit > first.
//
// Optional services (docs/optional-services.md): registry in localStorage
// `ipfs-services`, empty by default; resolution order is configured
// services -> public defaults -> the p2p path. Nothing here REQUIRES a
// service.
//
// Git server advertisement (docs/git-over-ipfs.md): signed `serve` envelopes
// on the repo topic. The /ipfs-gh-pages/git/1 stream handler lands in a
// later phase; advertisement is wired now.

import { createHelia, libp2pDefaults } from 'helia';
import { createLibp2p } from 'libp2p';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { strings } from '@helia/strings';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';
import * as dagJson from '@ipld/dag-json';
import { sha256 } from 'multiformats/hashes/sha2';
import {
  generateKeyPair,
  privateKeyFromRaw,
  publicKeyFromProtobuf,
  publicKeyToProtobuf
} from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id';
import { zipSync } from 'fflate';
import { GitStore } from './git-objects.js';
import { makeSmartHttp } from './git-smart.js';
import { classifyIndexSync } from './index-merge.js';

// ---- repo identity (parity: main.js lines 27-41) ---------------------------

const repoIdentity = { owner: REPO_OWNER, name: REPO_NAME, version: REPO_VERSION };
const { repoOwner, repoName } = (() => {
  const host = window.location.hostname;
  const m = host.match(/^([^.]+)\.github\.io$/);
  if (m) {
    const seg = window.location.pathname.split('/').filter(Boolean)[0];
    return { repoOwner: m[1], repoName: seg || m[1] };
  }
  if (repoIdentity.owner && repoIdentity.name) {
    return { repoOwner: repoIdentity.owner, repoName: repoIdentity.name };
  }
  return { repoOwner: 'gnostr', repoName: 'gnostr-repo' };
})();
const repoFullName = `${repoOwner}/${repoName}`;

const GOSSIP_TOPIC = `repo-gossip:${repoFullName}`;
const CHAT_TOPIC = `${GOSSIP_TOPIC}:chat`;

// ---- base64 (parity: lib/shared.mjs) ---------------------------------------

function uint8ArrayToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---- optional service registry (docs/optional-services.md) -----------------

const SERVICES_KEY = 'ipfs-services';
const PUBLIC_DEFAULTS = {
  gateways: ['https://ipfs.io'],
  delegatedRouting: ['https://delegated-ipfs.dev'],
  pinning: []
};

function loadServices() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SERVICES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s === 'object') : [];
  } catch {
    return [];
  }
}

// Resolution order: configured services in user order, then public
// defaults. The p2p path needs no endpoint and is always available.
function resolveEndpoints(field) {
  const out = [];
  for (const svc of loadServices()) {
    for (const url of svc[field] || []) if (typeof url === 'string') out.push(url);
  }
  for (const url of PUBLIC_DEFAULTS[field] || []) out.push(url);
  return out;
}

// ---- state (JS -> Rust) -----------------------------------------------------

const state = {
  repo: { owner: repoOwner, name: repoName, fullName: repoFullName, version: repoIdentity.version },
  node: { status: 'starting', peerId: null, multiaddrs: [], protocols: [], connections: [] },
  chat: { inbox: [] }, // { signer, verified, text, timestamp } — newest first, cap 50
  issues: [], // { cid, title, timestamp } — newest first (local index view)
  git: { serving: null, seen: [] }, // serve envelopes: ours + heard from gossip
  kubo: { status: 'unknown', endpoint: null, peerId: null, addresses: [] },
  services: { configured: [], endpoints: {} },
  results: {} // command results keyed by id
};
window.__ipfsState = state;

// ---- footer status (written into the ratzilla footer) -----------------------

let statusEl = null;
let pendingStatus = null;

function statusLine(text) {
  const value = `IPFS: ${text}`;
  const el = statusEl ?? document.getElementById('ratzilla-ipfs-status');
  if (el) {
    statusEl = el;
    el.textContent = value;
  } else {
    pendingStatus = value;
  }
}

new MutationObserver((mutations, observer) => {
  if (statusEl) {
    observer.disconnect();
    return;
  }
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.id === 'ratzilla-ipfs-status') statusEl = node;
      else if (node.querySelector) {
        statusEl = node.querySelector('#ratzilla-ipfs-status') ?? statusEl;
      }
      if (statusEl) break;
    }
    if (statusEl) break;
  }
  if (statusEl && pendingStatus) {
    statusEl.textContent = pendingStatus;
    pendingStatus = null;
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// ---- identity key (parity: main.js getIpnsBranchKey) ------------------------

let ipnsBranchKeyPromise = null;
function getIpnsBranchKey() {
  if (!ipnsBranchKeyPromise) {
    ipnsBranchKeyPromise = (async () => {
      const storageKey = `ipns-branch-key:${repoFullName}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          return privateKeyFromRaw(base64ToUint8Array(stored));
        } catch {
          // corrupted entry — regenerate below
        }
      }
      const key = await generateKeyPair('Ed25519');
      localStorage.setItem(storageKey, uint8ArrayToBase64(key.raw));
      return key;
    })();
  }
  return ipnsBranchKeyPromise;
}

// P7 envelope scheme (parity: main.js signNote/verifyNote).
async function signFields(fields) {
  const key = await getIpnsBranchKey();
  const signer = peerIdFromPrivateKey(key).toString();
  const signed = { ...fields, signer };
  const signature = await key.sign(dagJson.encode(signed));
  return {
    ...signed,
    signature: uint8ArrayToBase64(signature),
    publicKey: uint8ArrayToBase64(publicKeyToProtobuf(key.publicKey))
  };
}

async function verifyEnvelope(envelope) {
  const { signature, publicKey, ...signed } = envelope;
  const pub = publicKeyFromProtobuf(base64ToUint8Array(publicKey));
  const signer = peerIdFromPublicKey(pub).toString();
  const ok = await pub.verify(dagJson.encode(signed), base64ToUint8Array(signature));
  return { ok, signed, signer };
}

// ---- node boot ---------------------------------------------------------------

const BOOTSTRAP_PEERS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8'
];

const BLOCKED_KEY = 'blocked-peers';
function getBlockedPeers() {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]');
  } catch {
    return [];
  }
}
function setBlockedPeers(list) {
  localStorage.setItem(BLOCKED_KEY, JSON.stringify(list));
}

let heliaNode = null;
let heliaStrings = null;
let heliaUnixfs = null;
const chatSeen = new Set();
// CLI-injected config (served as config.json by the embedded server;
// absent under trunk dev serve -> defaults).
const config = { kubo: null, repo: null };

async function loadConfig() {
  try {
    const res = await fetch('config.json');
    if (!res.ok) return;
    const parsed = await res.json();
    if (typeof parsed.kubo === 'string' && parsed.kubo) config.kubo = parsed.kubo;
    if (typeof parsed.repo === 'string' && parsed.repo) config.repo = parsed.repo;
  } catch {}
}

// Publish our identity bundle to the rust app's interop server
// (docs/interop.md, src/wry_app.rs INTEROP_PORT) so other local origins —
// the GitHub Pages app, npm dev — can detect this node and adopt the same
// Ed25519 identity. Loopback only; failures are silent. Retried: the rust
// app may start its interop listener after the page boots.
const INTEROP_BASE = 'http://127.0.0.1:5050';

async function publishIdentity() {
  try {
    const key = await getIpnsBranchKey();
    const peerId = peerIdFromPrivateKey(key).toString();
    const bundle = {
      repo: repoFullName,
      peerId,
      publicKey: uint8ArrayToBase64(publicKeyToProtobuf(key.publicKey)),
      key: uint8ArrayToBase64(key.raw),
      publishedAt: new Date().toISOString()
    };
    await fetch(`${INTEROP_BASE}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle)
    });
  } catch {
    // rust app not running or not ready — the next retry covers it
  }
}

async function boot() {
  statusLine('starting...');
  await loadConfig();
  state.issues = loadIssues();
  state.services.configured = loadServices().map((s) => s.name || '(unnamed)');
  state.services.endpoints = {
    gateways: resolveEndpoints('gateways'),
    delegatedRouting: resolveEndpoints('delegatedRouting'),
    pinning: resolveEndpoints('pinning')
  };

  const lpDefaults = libp2pDefaults();
  const libp2p = await createLibp2p({
    ...lpDefaults,
    peerDiscovery: [
      ...lpDefaults.peerDiscovery,
      pubsubPeerDiscovery({ topics: [GOSSIP_TOPIC] })
    ],
    services: {
      ...lpDefaults.services,
      pubsub: gossipsub({ emitSelf: false })
    }
  });
  heliaNode = await createHelia({ libp2p });
  heliaStrings = strings(heliaNode);
  heliaUnixfs = unixfs(heliaNode);
  window.__heliaNode = heliaNode;

  // Blocklist gate, inbound included (parity: main.js).
  libp2p.addEventListener('connection:open', (evt) => {
    if (getBlockedPeers().includes(evt.detail.remotePeer.toString())) {
      evt.detail.close().catch(() => {});
    }
    refreshNodeState();
  });
  libp2p.addEventListener('connection:close', refreshNodeState);

  const pubsub = libp2p.services?.pubsub;
  if (pubsub) {
    try { pubsub.subscribe(GOSSIP_TOPIC); } catch {}
    try {
      pubsub.subscribe(CHAT_TOPIC);
      pubsub.addEventListener('message', (evt) => {
        if (evt.detail.topic === CHAT_TOPIC) onChatMessage(evt.detail.data);
        else if (evt.detail.topic === GOSSIP_TOPIC) onGossipMessage(evt.detail.data);
      });
    } catch {}
  }

  statusLine(`peer ${libp2p.peerId} — dialing bootstrap peers...`);
  refreshNodeState();
  await Promise.allSettled(BOOTSTRAP_PEERS.map((addr) => libp2p.dial(addr)));
  refreshNodeState();

  // Identity -> interop server, now and periodically (it may come up later).
  publishIdentity();
  setInterval(publishIdentity, 30_000);
}

function refreshNodeState() {
  if (!heliaNode) return;
  const libp2p = heliaNode.libp2p;
  state.node.status = 'online';
  state.node.peerId = libp2p.peerId.toString();
  state.node.multiaddrs = libp2p.getMultiaddrs().map((a) => a.toString());
  try {
    state.node.protocols = [...libp2p.getProtocols()];
  } catch {
    state.node.protocols = [];
  }
  state.node.connections = libp2p.getConnections().map((conn) => ({
    peer: conn.remotePeer.toString(),
    addr: conn.remoteAddr.toString(),
    direction: conn.stat?.direction || 'unknown',
    status: conn.stat?.status || 'unknown'
  }));
  statusLine(
    `peer ${state.node.peerId} — ${state.node.connections.length} connection(s)`
  );
}

// ---- gossip: chat + git serve envelopes ---------------------------------------

async function onChatMessage(data) {
  let envelope;
  try { envelope = dagJson.decode(data); } catch { return; }
  const { signature, publicKey, ...signed } = envelope;
  if (!signature || !publicKey || typeof signed.text !== 'string') return;
  const key = `${signed.signer}:${signed.timestamp}:${signed.text.slice(0, 32)}`;
  if (chatSeen.has(key)) return;
  chatSeen.add(key);
  let verified = false;
  let signer = signed.signer;
  try {
    const result = await verifyEnvelope(envelope);
    verified = result.ok;
    signer = result.signer;
  } catch {}
  state.chat.inbox.unshift({ signer, verified, text: signed.text, timestamp: signed.timestamp });
  if (state.chat.inbox.length > 50) state.chat.inbox.length = 50;
}

async function onGossipMessage(data) {
  let envelope;
  try { envelope = dagJson.decode(data); } catch { return; }
  if (envelope.op !== 'serve' || !envelope.signature) return;
  try {
    const result = await verifyEnvelope(envelope);
    if (!result.ok) return;
  } catch { return; }
  const key = `${envelope.signer}:${envelope.repo}:${envelope.ts}`;
  if (state.git.seen.some((s) => `${s.signer}:${s.repo}:${s.ts}` === key)) return;
  state.git.seen.unshift({
    signer: envelope.signer,
    repo: envelope.repo,
    head: envelope.head || null,
    rootCid: envelope.rootCid || null,
    addrs: Array.isArray(envelope.addrs) ? envelope.addrs : [],
    ts: envelope.ts
  });
  if (state.git.seen.length > 100) state.git.seen.length = 100;
}

// ---- git clone ----------------------------------------------------------------
//
// Browser libp2p nodes cannot listen, so the /ipfs-gh-pages/git/1
// upload-pack handler from docs/git-over-ipfs.md cannot serve inbound here
// — that transport lands with a listening node. What works through this app
// today: fetch a bare-repo-shaped CID tree from IPFS and hand back a zip
// that materializes a real git repo (the tree goes in as .git/), plus the
// serve-envelope advertisement so peers learn the clone address.

async function collectTree(cid, prefix, files) {
  const stat = await heliaUnixfs.stat(cid);
  if (stat.type === 'file') {
    const chunks = [];
    for await (const chunk of heliaUnixfs.cat(cid)) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    files.set(prefix, bytes);
    return;
  }
  for await (const entry of heliaUnixfs.ls(cid)) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;
    await collectTree(entry.cid, child, files);
  }
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function opGitClone(arg) {
  const cidStr = String(arg?.cid || '');
  if (!cidStr) throw new Error('empty cid');
  const name = String(arg?.text || '').trim() || `repo-${cidStr.slice(0, 8)}`;
  const files = new Map();
  await collectTree(CID.parse(cidStr), '', files);
  if (files.size === 0) throw new Error('empty tree');
  // Bare-repo shape (docs.ipfs.tech host-git-repo layout): HEAD + refs.
  const isBare = files.has('HEAD') &&
    (files.has('packed-refs') || [...files.keys()].some((k) => k.startsWith('refs/')));
  const entries = {};
  for (const [path, bytes] of files) {
    entries[`${name}/${isBare ? '.git/' : ''}${path}`] = bytes;
  }
  const zipped = zipSync(entries);
  const zipName = `${name}.zip`;
  downloadBytes(zipped, zipName);
  return { fileCount: files.size, zipName, bytes: zipped.length, bareRepo: isBare };
}

// Phase 9 step 1 (docs/git-over-ipfs.md): inspect a git repo published as
// a bare-repo-shaped CID tree. Stores are cached per CID; cap the cache
// so long sessions don't hold every cloned repo in memory.
const gitStores = new Map();

async function gitStoreForCid(cidStr) {
  const cached = gitStores.get(cidStr);
  if (cached) return cached;
  const files = new Map();
  await collectTree(CID.parse(cidStr), '', files);
  const store = new GitStore(files);
  if (gitStores.size > 8) gitStores.delete(gitStores.keys().next().value);
  gitStores.set(cidStr, store);
  return store;
}

async function opGitRefs(arg) {
  const cid = String(arg?.cid || '');
  if (!cid) throw new Error('empty cid');
  const store = await gitStoreForCid(cid);
  return store.refs();
}

async function opGitCatFile(arg) {
  const cid = String(arg?.cid || '');
  const sha = String(arg?.sha || arg?.text || '').trim();
  if (!cid || !sha) throw new Error('usage: git.catFile <cid> <sha>');
  const store = await gitStoreForCid(cid);
  return store.catFile(sha);
}

// Live clone (docs/git-over-ipfs.md phase 9 step 3): isomorphic-git over
// lightning-fs (IndexedDB), with the smart-HTTP transport routed to the
// in-process upload-pack for the fetched store. The clone persists in the
// browser across sessions; git.pullSmart(cid) after a re-publish fetches
// incrementally (the haves path proven in step 2).
let isoGit = null;
let LightningFS = null;
async function isoGitModules() {
  if (!isoGit) {
    [isoGit, LightningFS] = await Promise.all([
      import('isomorphic-git'),
      import('@isomorphic-git/lightning-fs')
    ]);
  }
  return { git: isoGit.default || isoGit, LightningFS: LightningFS.default || LightningFS };
}

const CLONES_KEY = 'git-clones';
function loadClones() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLONES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function recordClone(entry) {
  const list = loadClones().filter((c) => c.name !== entry.name);
  list.unshift({ ...entry, updatedAt: new Date().toISOString() });
  localStorage.setItem(CLONES_KEY, JSON.stringify(list.slice(0, 20)));
}

function cloneName(arg) {
  return (String(arg?.text || '').trim() || `repo-${String(arg?.cid || '').slice(0, 8)}`).split(/\s+/)[0];
}

async function opGitCloneSmart(arg) {
  const cid = String(arg?.cid || '');
  if (!cid) throw new Error('empty cid');
  const name = cloneName(arg);
  const store = await gitStoreForCid(cid);
  const { git, LightningFS: LFS } = await isoGitModules();
  const fs = new LFS(name);
  await git.clone({
    fs,
    http: makeSmartHttp(store),
    url: `http://ipfs.local/${cid}.git`, // decorative; the store is the remote
    dir: '/repo',
    corsProxy: undefined,
    tags: true
  });
  const branches = await git.listBranches({ fs, dir: '/repo' });
  const tags = await git.listTags({ fs, dir: '/repo' });
  recordClone({ name, cid, branches, tags });
  return { cid, name, branches, tags };
}

async function opGitPullSmart(arg) {
  const cid = String(arg?.cid || '');
  if (!cid) throw new Error('empty cid');
  const name = cloneName(arg);
  const { git, LightningFS: LFS } = await isoGitModules();
  const fs = new LFS(name);
  try {
    await fs.promises.stat('/repo/HEAD');
  } catch {
    throw new Error(`no clone named "${name}" — run git.cloneSmart <cid> first`);
  }
  const store = await gitStoreForCid(cid);
  const before = await git.resolveRef({ fs, dir: '/repo', ref: 'HEAD' }).catch(() => null);
  await git.pull({
    fs,
    http: makeSmartHttp(store),
    dir: '/repo',
    url: `http://ipfs.local/${cid}.git`,
    corsProxy: undefined,
    singleBranch: false,
    author: { name: 'ipfs-gh-pages', email: 'pull@ipfs-gh-pages.local' }
  });
  const after = await git.resolveRef({ fs, dir: '/repo', ref: 'HEAD' });
  recordClone({ name, cid });
  return { name, cid, before, after, advanced: before !== after };
}

function opGitClones() {
  return { clones: loadClones() };
}

// ---- issues (docs/issues-car.md) — same scheme as main.js: P7 envelopes,
// hash-chained index, dedicated index IPNS name. Parity across surfaces is
// the contract: an issue filed here verifies and syncs in the web app.

const ISSUES_KEY = 'repo-issues';
const CHAIN_KEY = 'repo-index-chain';
const LAMPORT_KEY = 'repo-index-lamport';

function loadIssues() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ISSUES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadChainTip() {
  try { return JSON.parse(localStorage.getItem(CHAIN_KEY) || 'null'); } catch { return null; }
}

function nextLamport(parentLamports = []) {
  let l = 0;
  try { l = parseInt(localStorage.getItem(LAMPORT_KEY) || '0', 10) || 0; } catch {}
  const next = Math.max(l, ...parentLamports) + 1;
  try { localStorage.setItem(LAMPORT_KEY, String(next)); } catch {}
  return next;
}

let ipnsIndexKeyPromise = null;
function getIpnsIndexKey() {
  if (!ipnsIndexKeyPromise) {
    ipnsIndexKeyPromise = (async () => {
      const storageKey = `ipns-index-key:${repoFullName}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try { return privateKeyFromRaw(base64ToUint8Array(stored)); } catch {}
      }
      const key = await generateKeyPair('Ed25519');
      localStorage.setItem(storageKey, uint8ArrayToBase64(key.raw));
      return key;
    })();
  }
  return ipnsIndexKeyPromise;
}

function publishIndexTip(tipCid) {
  if (!heliaNode || !tipCid) return;
  (async () => {
    try {
      const key = await getIpnsIndexKey();
      await ipns(heliaNode).publish(key, CID.parse(String(tipCid)));
    } catch {}
  })();
}

async function opIssuesCreate(arg) {
  const title = String(arg?.text || '').trim();
  if (!title) throw new Error('empty title');
  const envelope = await signFields({
    ns: 'issues',
    type: 'issue',
    title,
    body: String(arg?.body || ''),
    anchors: [],
    timestamp: new Date().toISOString()
  });
  const { cid: noteCid } = await opDagPut({ obj: envelope });
  heliaNode?.routing?.provide?.(CID.parse(noteCid)).catch(() => {});

  // Extend the index chain (height/lamport fork-choice scheme).
  const prevTip = loadChainTip();
  let parentHeight = 0;
  let parentLamport = 0;
  if (prevTip) {
    try {
      const prevEntry = await opDagGet({ cid: prevTip.cid });
      parentHeight = Number(prevEntry.obj?.height) || 0;
      parentLamport = Number(prevEntry.obj?.lamport) || 0;
    } catch {}
  }
  const indexEnvelope = await signFields({
    type: 'index-entry',
    added: [noteCid],
    prev: prevTip ? [prevTip.cid] : [],
    height: parentHeight + 1,
    lamport: nextLamport([parentLamport]),
    timestamp: new Date().toISOString()
  });
  const { cid: tipCid } = await opDagPut({ obj: indexEnvelope });
  localStorage.setItem(CHAIN_KEY, JSON.stringify({
    cid: tipCid, height: parentHeight + 1,
    lamport: Number(indexEnvelope.lamport) || 0, added: 1
  }));
  publishIndexTip(tipCid);

  const issues = loadIssues();
  issues.unshift({ cid: noteCid, title, timestamp: envelope.timestamp });
  state.issues = issues.slice(0, 200);
  localStorage.setItem(ISSUES_KEY, JSON.stringify(state.issues));
  return { cid: noteCid, tip: tipCid };
}

async function opIssuesSync() {
  if (!heliaNode) throw new Error('helia not ready');
  const key = await getIpnsIndexKey();
  const name = `/ipns/${peerIdFromPrivateKey(key)}`;
  const result = await ipns(heliaNode).resolve(name, { timeout: 8000 }).catch(() => null);
  if (!result) return { synced: false, reason: 'index name not resolvable' };
  const remoteStr = (result.value || result.path || result).toString().replace(/^\/ipfs\//, '');
  const local = loadChainTip();
  if (!remoteStr || (local && remoteStr === local.cid)) {
    return { synced: true, merged: false, issues: state.issues.length, tip: local?.cid || null, name };
  }
  const { obj: remoteEntry } = await opDagGet({ cid: remoteStr });

  // Merge semantics (docs/issues-car.md chronology): fast-forward when one
  // side descends from the other; otherwise a MERGE entry with both
  // parents and the union of missing notes — never loser-deleted data.
  const descendsFrom = async (tipCid, ancestorCid, maxSteps = 50) => {
    let cursor = tipCid;
    for (let i = 0; i < maxSteps && cursor; i++) {
      if (cursor === ancestorCid) return true;
      try {
        const { obj } = await opDagGet({ cid: cursor });
        cursor = Array.isArray(obj?.prev) ? obj.prev[0] : null;
      } catch { break; }
    }
    return false;
  };

  // Collect the remote chain's notes missing locally (bounded walk) —
  // needed both for the issues view AND as the merge entry's `added`.
  const missingNotes = [];
  {
    const known = new Set(loadIssues().map((i) => i.cid));
    let cursor = remoteEntry;
    let walked = 0;
    while (cursor && walked < 50) {
      for (const noteCid of cursor.added || []) {
        if (known.has(noteCid)) continue;
        try {
          const { obj: note } = await opDagGet({ cid: noteCid });
          if (note && note.ns === 'issues' && note.type === 'issue' && note.title) {
            missingNotes.push({ cid: noteCid, title: note.title, timestamp: note.timestamp });
            known.add(noteCid);
          }
        } catch {}
      }
      const prev = Array.isArray(cursor.prev) ? cursor.prev[0] : null;
      if (!prev) break;
      try { cursor = (await opDagGet({ cid: prev })).obj; } catch { break; }
      walked++;
    }
  }

  let merged = false;
  let newTip = null;
  const decision = classifyIndexSync(
    local,
    { cid: remoteStr, height: Number(remoteEntry?.height) || 0, lamport: Number(remoteEntry?.lamport) || 0 },
    local ? await descendsFrom(remoteStr, local.cid) : false,
    local ? await descendsFrom(local.cid, remoteStr) : false
  );
  if (decision.action === 'noop') {
    return { synced: true, merged: false, issues: state.issues.length, tip: local.cid, name };
  }
  if (decision.action === 'adopt-remote') {
    localStorage.setItem(CHAIN_KEY, JSON.stringify({
      cid: remoteStr,
      height: Number(remoteEntry.height) || 0,
      lamport: Number(remoteEntry.lamport) || 0,
      added: Array.isArray(remoteEntry.added) ? remoteEntry.added.length : 0
    }));
    try { localStorage.setItem(LAMPORT_KEY, String(Number(remoteEntry.lamport) || 0)); } catch {}
    newTip = remoteStr;
    merged = true;
  } else {
    // Divergence: merge entry with both parents and the union of missing
    // notes as `added` — add-wins, nobody's data is dropped.
    const envelope = await signFields({
      type: 'index-entry',
      added: missingNotes.map((n) => n.cid),
      prev: [local.cid, remoteStr],
      height: decision.height,
      lamport: decision.lamport,
      timestamp: new Date().toISOString()
    });
    const { cid: tipCid } = await opDagPut({ obj: envelope });
    localStorage.setItem(CHAIN_KEY, JSON.stringify({ cid: tipCid, height: decision.height, lamport: decision.lamport, added: missingNotes.length }));
    publishIndexTip(tipCid);
    newTip = tipCid;
    merged = true;
  }

  // Merge missing notes into the local view.
  const issues = loadIssues();
  const before = issues.length;
  if (missingNotes.length) {
    issues.unshift(...missingNotes);
    state.issues = issues.slice(0, 200);
    localStorage.setItem(ISSUES_KEY, JSON.stringify(state.issues));
  }

  return {
    synced: true,
    merged,
    newNotes: issues.length - before,
    issues: state.issues.length,
    tip: newTip || loadChainTip()?.cid,
    name
  };
}

async function opIssueCreate(arg) { return opIssuesCreate(arg); }

async function advertiseServe(arg) {
  const libp2p = heliaNode?.libp2p;
  const pubsub = libp2p?.services?.pubsub;
  if (!pubsub) throw new Error('pubsub unavailable');
  const envelope = await signFields({
    op: 'serve',
    repo: repoFullName,
    repoPath: config.repo || undefined,
    head: arg?.head || null,
    rootCid: arg?.rootCid || null,
    addrs: arg?.addrs || [],
    ts: new Date().toISOString()
  });
  state.git.serving = {
    signer: envelope.signer,
    repo: repoFullName,
    repoPath: config.repo || null,
    head: envelope.head,
    rootCid: envelope.rootCid,
    addrs: envelope.addrs,
    ts: envelope.ts
  };
  await pubsub.publish(GOSSIP_TOPIC, dagJson.encode(envelope));
  return state.git.serving;
}

// ---- ops ----------------------------------------------------------------------

function result(id, promise) {
  promise
    .then((value) => { state.results[id] = { ok: true, value }; })
    .catch((error) => { state.results[id] = { ok: false, error: String(error?.message || error) }; });
}

async function opFetch(arg) {
  const cid = CID.parse(String(arg?.cid || ''));
  const stat = await heliaUnixfs.stat(cid);
  if (stat.type === 'directory') {
    const entries = [];
    for await (const entry of heliaUnixfs.ls(cid)) {
      entries.push({ name: entry.name, type: entry.type, size: Number(entry.size || 0), cid: entry.cid.toString() });
    }
    const display = entries.length
      ? entries.map((e) => `${e.type === 'directory' ? '📁' : '📄'} ${e.name} ${e.cid} (${e.size} B)`).join('\n')
      : '(empty directory)';
    return { type: 'directory', cid: cid.toString(), entries, display };
  }
  const chunks = [];
  for await (const chunk of heliaUnixfs.cat(cid)) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  const text = new TextDecoder().decode(bytes);
  return { type: 'file', cid: cid.toString(), text, size: total, display: text };
}

async function opPublish(arg) {
  const text = String(arg?.text || '');
  if (!text) throw new Error('empty text');
  const cid = await heliaStrings.add(text);
  const cidStr = cid.toString();
  const gateway = resolveEndpoints('gateways')[0];
  return {
    cid: cidStr,
    gatewayUrl: `${gateway}/ipfs/${cidStr}`,
    pinCmd: `ipfs pin add ${cidStr}`
  };
}

async function opDagPut(arg) {
  const bytes = dagJson.encode(arg?.obj);
  const cid = CID.create(1, dagJson.code, await sha256.digest(bytes));
  await heliaNode.blockstore.put(cid, bytes);
  return { cid: cid.toString() };
}

async function opDagGet(arg) {
  const bytes = await heliaNode.blockstore.get(CID.parse(String(arg?.cid)));
  return { obj: dagJson.decode(bytes) };
}

async function opChatSend(arg) {
  const text = String(arg?.text || '').trim();
  if (!text) throw new Error('empty message');
  const pubsub = heliaNode?.libp2p?.services?.pubsub;
  if (!pubsub) throw new Error('pubsub unavailable');
  const envelope = await signFields({ text, timestamp: new Date().toISOString() });
  const data = dagJson.encode(envelope);
  await pubsub.publish(CHAT_TOPIC, data);
  // emitSelf is off — render our own post so the sender sees it immediately.
  await onChatMessage(data);
  return { sent: true };
}

async function opConnect(arg) {
  const addr = String(arg?.addr || '').trim();
  if (!addr) throw new Error('empty multiaddr');
  const timeoutMs = Number(arg?.timeoutMs || 8000);
  await Promise.race([
    heliaNode.libp2p.dial(addr),
    new Promise((_, reject) => setTimeout(() => reject(new Error('dial timeout')), timeoutMs))
  ]);
  refreshNodeState();
  return { connected: addr };
}

async function opDisconnect(arg) {
  const peer = String(arg?.peer || '');
  await heliaNode.libp2p.hangUp(peer);
  refreshNodeState();
  return { disconnected: peer };
}

function opBlock(arg) {
  const peer = String(arg?.peer || '');
  const list = getBlockedPeers();
  if (!list.includes(peer)) list.push(peer);
  setBlockedPeers(list);
  heliaNode?.libp2p
    .getConnections()
    .filter((c) => c.remotePeer.toString() === peer)
    .forEach((c) => c.close().catch(() => {}));
  refreshNodeState();
  return { blocked: peer };
}

function opUnblock(arg) {
  const peer = String(arg?.peer || '');
  setBlockedPeers(getBlockedPeers().filter((p) => p !== peer));
  return { unblocked: peer };
}

// Kubo RPC detection (parity: main.js tryKuboRpc — probes /api/v0/id on
// 127.0.0.1, ports 5001-5010 by default).
async function opKuboDetect(arg) {
  const host = String(arg?.host || '127.0.0.1');
  const portStart = Number(arg?.portStart || 5001);
  const portEnd = Number(arg?.portEnd || 5010);
  // CLI-configured endpoint wins; probe the range only if it fails.
  const candidates = [];
  if (config.kubo) candidates.push(config.kubo);
  for (let port = portStart; port <= portEnd; port++) {
    candidates.push(`http://${host}:${port}`);
  }
  for (const endpoint of candidates) {
    try {
      const res = await fetch(`${endpoint}/api/v0/id?stream-channels=true`, { method: 'POST' });
      if (!res.ok) continue;
      const data = await res.json();
      state.kubo = {
        status: 'online',
        endpoint,
        peerId: data.ID || null,
        addresses: Array.isArray(data.Addresses) ? data.Addresses : []
      };
      return state.kubo;
    } catch {
      // not on this endpoint
    }
  }
  state.kubo = { status: 'offline', endpoint: null, peerId: null, addresses: [] };
  return state.kubo;
}

// Generic Kubo RPC passthrough — this one op is the ENTIRE Kubo API
// surface: any /api/v0/<method> with positional args. Full API support
// without a per-method wrapper.
async function opKuboRpc(arg) {
  if (state.kubo.status !== 'online') throw new Error('kubo not detected — run kuboDetect first');
  const method = String(arg?.method || '').replace(/^\/+|\/+$/g, '');
  if (!method) throw new Error('empty method');
  const args = Array.isArray(arg?.args) ? arg.args.map((a) => String(a)) : [];
  const query = args.map((a) => `arg=${encodeURIComponent(a)}`).join('&');
  const res = await fetch(
    `${state.kubo.endpoint}/api/v0/${method}?stream-channels=true${query ? `&${query}` : ''}`,
    { method: 'POST' }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`kubo ${method}: HTTP ${res.status}: ${text}`);
  return { method, response: text };
}

async function opKuboPin(arg) {
  const cid = String(arg?.cid || '');
  if (!cid) throw new Error('empty cid');
  if (state.kubo.status !== 'online') throw new Error('kubo not detected — run kuboDetect first');
  const res = await fetch(`${state.kubo.endpoint}/api/v0/pin/add?stream-channels=true&arg=${encodeURIComponent(cid)}`, { method: 'POST' });
  if (!res.ok) throw new Error(`kubo pin failed: HTTP ${res.status}`);
  return await res.json();
}

// Provider lookup via configured delegated routing endpoints, then the
// public default. Pure HTTP — a service answer is an optimization, the p2p
// path remains available regardless.
async function opProviders(arg) {
  const cid = String(arg?.cid || '');
  if (!cid) throw new Error('empty cid');
  const endpoints = resolveEndpoints('delegatedRouting');
  const providers = [];
  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}/routing/v1/providers/${cid}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const p of data.Providers || []) {
        providers.push({ id: p.ID, addrs: p.Addrs || [], schema: p.Schema, endpoint: base });
      }
      if (providers.length) break; // first success wins
    } catch {
      // try next endpoint
    }
  }
  return { providers };
}

function opShareAddr() {
  const addrs = state.node.multiaddrs;
  const pick =
    addrs.find((a) => a.includes('/p2p-circuit') && a.includes('/webrtc')) ||
    addrs.find((a) => a.includes('/p2p-circuit') && a.includes('/wss')) ||
    addrs.find((a) => a.includes('/p2p-circuit')) ||
    addrs[0] ||
    null;
  return { multiaddr: pick };
}

function opServicesSet(arg) {
  const list = Array.isArray(arg?.services) ? arg.services : [];
  localStorage.setItem(SERVICES_KEY, JSON.stringify(list));
  state.services.configured = list.map((s) => s?.name || '(unnamed)');
  state.services.endpoints = {
    gateways: resolveEndpoints('gateways'),
    delegatedRouting: resolveEndpoints('delegatedRouting'),
    pinning: resolveEndpoints('pinning')
  };
  return { configured: state.services.configured, endpoints: state.services.endpoints };
}

// Publish the whole repo tree: fetch the build-emitted file set
// (scripts/build-repo-files.mjs -> assets/repo-files.json, same content
// set as the vite plugin's virtual:repo-files), add it as a wrapped unixfs
// directory, and advertise it as a git serve envelope. Mirrors main.js
// addAllRepoFiles + the Clone bar's root CID.
async function opRepoPublishAll() {
  const res = await fetch('./assets/repo-files.json');
  if (!res.ok) throw new Error(`repo-files.json: HTTP ${res.status} — run scripts/build-repo-files.mjs`);
  const entries = await res.json();
  const candidates = Object.entries(entries).map(([path, rec]) => ({
    path,
    content: base64ToUint8Array(rec.content)
  }));
  let rootCid = null;
  for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
    rootCid = entry.cid.toString(); // last entry = the wrapping directory
  }
  if (!rootCid) throw new Error('addAll produced no entries');
  const gateway = resolveEndpoints('gateways')[0];
  let head = null;
  try {
    head = (await (await fetch('./assets/repo-head.txt')).text()).trim() || null;
  } catch {}
  await advertiseServe({ head, rootCid }).catch(() => {});
  return {
    rootCid,
    fileCount: candidates.length,
    gatewayUrl: `${gateway}/ipfs/${rootCid}`,
    pinCmd: `ipfs pin add ${rootCid}`,
    importCmd: `ipfs dag import ${rootCid}.car`
  };
}

// Pinning services resolution (docs/ipfs-uri-providers.md): registry
// pinning entries may be bare endpoint URLs or {endpoint, token} objects
// (Pinning Services API uses Bearer auth).
function resolvePinningServices() {
  const out = [];
  for (const svc of loadServices()) {
    for (const p of svc.pinning || []) {
      if (typeof p === 'string') {
        out.push({ service: svc.name || '(unnamed)', endpoint: p, token: null });
      } else if (p && typeof p.endpoint === 'string') {
        out.push({ service: svc.name || '(unnamed)', endpoint: p.endpoint, token: p.token || null });
      }
    }
  }
  return out;
}

async function pinningRequest(svc, path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (svc.token) headers.authorization = `Bearer ${svc.token}`;
  const res = await fetch(`${svc.endpoint}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${svc.service}: HTTP ${res.status}: ${text}`);
  return text;
}

async function opPinRemoteList() {
  const services = resolvePinningServices();
  if (!services.length) throw new Error('no pinning services configured — :services [{...,"pinning":[...]}]');
  const results = [];
  for (const svc of services) {
    try {
      results.push({ service: svc.service, pins: await pinningRequest(svc, '/pins') });
    } catch (err) {
      results.push({ service: svc.service, error: String(err.message || err) });
    }
  }
  return { results };
}

async function opPinRemoteAdd(arg) {
  const cid = String(arg?.cid || '');
  if (!cid) throw new Error('empty cid');
  const services = resolvePinningServices();
  if (!services.length) throw new Error('no pinning services configured');
  const body = JSON.stringify({ cid, name: arg?.text || undefined });
  const results = [];
  for (const svc of services) {
    try {
      results.push({ service: svc.service, result: await pinningRequest(svc, '/pins', { method: 'POST', headers: { 'content-type': 'application/json' }, body }) });
    } catch (err) {
      results.push({ service: svc.service, error: String(err.message || err) });
    }
  }
  return { cid, results };
}

async function opIdentityExport() {
  const key = await getIpnsBranchKey();
  return {
    repo: repoFullName,
    peerId: peerIdFromPrivateKey(key).toString(),
    publicKey: uint8ArrayToBase64(publicKeyToProtobuf(key.publicKey)),
    key: uint8ArrayToBase64(key.raw)
  };
}

// Import a base64 Ed25519 raw key (the 'key' field of an identity.export
// bundle or the interop well-known payload) as this surface's identity.
async function opIdentityImport(arg) {
  const b64 = String(arg?.text || arg?.key || '').trim();
  if (!b64) throw new Error('empty key — pass the base64 key');
  privateKeyFromRaw(base64ToUint8Array(b64)); // validates before storing
  localStorage.setItem(`ipns-branch-key:${repoFullName}`, b64);
  ipnsBranchKeyPromise = null; // force re-read
  const key = await getIpnsBranchKey();
  return { imported: peerIdFromPrivateKey(key).toString() };
}

const ops = {
  refresh: async () => { refreshNodeState(); return state.node; },
  fetch: opFetch,
  publish: opPublish,
  dagPut: opDagPut,
  dagGet: opDagGet,
  chatSend: opChatSend,
  connect: opConnect,
  disconnect: opDisconnect,
  block: async (a) => opBlock(a),
  unblock: async (a) => opUnblock(a),
  kuboDetect: opKuboDetect,
  kuboPin: opKuboPin,
  'kubo.rpc': opKuboRpc,
  providers: opProviders,
  shareAddr: async () => opShareAddr(),
  'services.set': async (a) => opServicesSet(a),
  'git.advertise': advertiseServe,
  'git.clone': opGitClone,
  'git.refs': opGitRefs,
  'git.catFile': opGitCatFile,
  'git.cloneSmart': opGitCloneSmart,
  'git.pullSmart': opGitPullSmart,
  'git.clones': opGitClones,
  'repo.publishAll': opRepoPublishAll,
  'pin.remote.list': opPinRemoteList,
  'pin.remote.add': opPinRemoteAdd,
  'identity.export': opIdentityExport,
  'identity.import': opIdentityImport,
  'issues.create': opIssueCreate,
  'issues.sync': opIssuesSync
};

// ---- command channel (Rust -> JS) --------------------------------------------

window.__ipfsCmd = (id, op, arg) => {
  const fn = ops[op];
  if (!fn) {
    state.results[id] = { ok: false, error: `unknown op: ${op}` };
    return false;
  }
  result(id, fn(arg));
  return true;
};

// ---- boot ----------------------------------------------------------------------

if (typeof window !== 'undefined' && window.document) {
  boot().catch((err) => {
    state.node.status = 'error';
    statusLine(`node failed: ${err.message || err}`);
  });
}
