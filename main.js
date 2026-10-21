import { createHelia } from 'helia';
import { strings } from '@helia/strings';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';
import repoFiles from 'virtual:repo-files';
import { zipSync } from 'fflate';
import { multiaddr } from '@multiformats/multiaddr';

let heliaNode = null;
let heliaStrings = null;
let heliaUnixfs = null;
const repoTreeCids = new Map();
let lastFetchedBytes = null;
let lastFetchedName = 'ipfs-content';
let lastFetchedCid = null;
let lastFetchedIsDir = false;
let rootCidForProvide = null;
let selectedFileCid = null;
let selectedFileName = null;
let selectedFileEl = null;
let connectedPeerAddr = null;

const statusEl = document.getElementById('node-status');
const peerIdEl = document.getElementById('peer-id');
const multiaddrsEl = document.getElementById('multiaddrs');
const connectBtn = document.getElementById('btn-connect');
const bootstrapBtn = document.getElementById('btn-bootstrap');
const inputMultiaddr = document.getElementById('input-multiaddr');
const connectStatus = document.getElementById('connect-status');
const publishBtn = document.getElementById('btn-publish');
const fetchBtn = document.getElementById('btn-fetch');
const downloadBtn = document.getElementById('btn-download');
const inputContent = document.getElementById('input-content');
const outputCid = document.getElementById('output-cid');
const inputCid = document.getElementById('input-cid');
const outputContent = document.getElementById('output-content');
const fileTreeEl = document.getElementById('file-tree');
const detectKuboBtn = document.getElementById('btn-detect-kubo');
const settingsRpcHost = document.getElementById('settings-rpc-host');
const settingsRpcPort = document.getElementById('settings-rpc-port');
const settingsRpcProxyPort = document.getElementById('settings-rpc-proxy-port');
const settingsKuboStatus = document.getElementById('settings-kubo-status');
const settingsKuboResult = document.getElementById('settings-kubo-result');
const settingsKuboPeerId = document.getElementById('settings-kubo-peer-id');
const settingsKuboAddresses = document.getElementById('settings-kubo-addresses');
const settingsCurrentOrigin = document.getElementById('settings-current-origin');
const settingsCorsCommand = document.getElementById('settings-cors-command');
const copyCorsBtn = document.getElementById('btn-copy-cors');
const fileSelectedEl = document.getElementById('file-selected');
const fetchSelectedBtn = document.getElementById('btn-fetch-selected');
const downloadSelectedBtn = document.getElementById('btn-download-selected');
const fetchRepoBtn = document.getElementById('btn-fetch-repo');
const downloadRepoBtn = document.getElementById('btn-download-repo');
const fileActionStatus = document.getElementById('file-action-status');

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildRepoTree(paths) {
  const root = { name: '', children: {}, isDir: true };
  for (const p of paths) {
    const parts = p.split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!cur.children[name]) {
        cur.children[name] = { name, children: {}, isDir: i < parts.length - 1 };
      } else if (i < parts.length - 1) {
        cur.children[name].isDir = true;
      }
      cur = cur.children[name];
    }
  }
  return root;
}

function selectFile(cid, name, element) {
  selectedFileCid = cid;
  selectedFileName = name;
  if (selectedFileEl) {
    selectedFileEl.style.backgroundColor = '';
    selectedFileEl.style.borderRadius = '';
  }
  selectedFileEl = element;
  if (selectedFileEl) {
    selectedFileEl.style.backgroundColor = '#2a2a2a';
    selectedFileEl.style.borderRadius = '4px';
  }
  if (fileSelectedEl) {
    fileSelectedEl.textContent = `Selected: ${name} (${cid})`;
    fileSelectedEl.style.color = '#fff';
  }
  if (fetchSelectedBtn) fetchSelectedBtn.disabled = false;
  if (downloadSelectedBtn) downloadSelectedBtn.disabled = false;
  if (fileActionStatus) fileActionStatus.textContent = '';
}

function renderRepoTree() {
  if (!fileTreeEl) return;
  fileTreeEl.innerHTML = '';
  const paths = Object.keys(repoFiles);
  const tree = buildRepoTree(paths);
  const rootUl = document.createElement('ul');

  function renderNode(node, parentPath) {
    const ul = document.createElement('ul');
    const names = Object.keys(node.children).sort((a, b) => {
      const aDir = node.children[a].isDir;
      const bDir = node.children[b].isDir;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const name of names) {
      const child = node.children[name];
      const childPath = parentPath ? parentPath + '/' + name : name;
      const li = document.createElement('li');

      const cid = repoTreeCids.get(childPath);

      if (child.isDir) {
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = '📁 ' + name;
        if (cid) {
          const cidEl = document.createElement('span');
          cidEl.textContent = '  ' + cid;
          cidEl.style.cursor = 'pointer';
          cidEl.style.color = '#4da3ff';
          cidEl.title = 'Click to select this CID';
          cidEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            selectFile(cid, name, cidEl);
          });
          summary.appendChild(cidEl);
        }
        details.appendChild(summary);
        if (Object.keys(child.children).length > 0) {
          details.appendChild(renderNode(child, childPath));
        }
        li.appendChild(details);
      } else {
        const span = document.createElement('span');
        span.textContent = '📄 ' + name;
        if (cid) {
          const cidEl = document.createElement('span');
          cidEl.textContent = '  ' + cid;
          cidEl.style.cursor = 'pointer';
          cidEl.style.color = '#4da3ff';
          cidEl.title = 'Click to select this CID';
          cidEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            selectFile(cid, name, cidEl);
          });
          span.appendChild(cidEl);
        }
        li.appendChild(span);
      }
      ul.appendChild(li);
    }
    return ul;
  }

  const rendered = renderNode(tree, '');
  // promote children of root into the top-level list
  while (rendered.firstChild) {
    rootUl.appendChild(rendered.firstChild);
  }
  fileTreeEl.appendChild(rootUl);
}

async function addAllRepoFiles() {
  if (!heliaUnixfs) return;
  statusEl.textContent = 'Adding all repository files to IPFS...';

  const candidates = Object.entries(repoFiles).map(([p, b64]) => ({
    path: p,
    content: base64ToUint8Array(b64)
  }));

  let rootCid = null;
  try {
    for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
      rootCid = entry.cid;
      repoTreeCids.set(entry.path == null ? '' : entry.path, entry.cid.toString());
    }
    if (rootCid) {
      outputCid.textContent = rootCid.toString();
      inputCid.value = rootCid.toString();
      rootCidForProvide = rootCid;
      if (fetchRepoBtn) fetchRepoBtn.disabled = false;
      if (downloadRepoBtn) downloadRepoBtn.disabled = false;
      statusEl.textContent = 'Online & All repository files added to IPFS';

      // Announce the root CID to the IPFS network so other peers
      // (e.g. Kubo Desktop) can discover and retrieve it.
      if (heliaNode && heliaNode.routing && typeof heliaNode.routing.provide === 'function') {
        const cidStr = rootCid.toString();
        statusEl.textContent = `Online & Publishing root CID ${cidStr} to IPFS network...`;
        heliaNode.routing.provide(rootCid)
          .then(() => {
            statusEl.textContent = `Online & Root CID ${cidStr} published to IPFS network`;
          })
          .catch((err) => {
            statusEl.textContent = `Online & Added files (publish ${cidStr}: ${err.message})`;
          });
        // Best-effort announce individual file CIDs
        for (const cidStr of repoTreeCids.values()) {
          heliaNode.routing.provide(CID.parse(cidStr)).catch(() => {});
        }
      } else {
        statusEl.textContent = 'Online & All repository files added to IPFS';
      }

      renderRepoTree();
    }
  } catch (err) {
    statusEl.textContent = `Error adding repository files: ${err.message}`;
    statusEl.style.color = '#ff4444';
  }
}

async function initHelia() {
  try {
    // Spawn an in-browser IPFS node
    heliaNode = await createHelia();
    heliaStrings = strings(heliaNode);
    heliaUnixfs = unixfs(heliaNode);
    window.__heliaNode = heliaNode;

    const peerId = heliaNode.libp2p.peerId.toString();

    statusEl.textContent = 'Online & Connected to Peer-to-Peer Network';
    peerIdEl.textContent = peerId;

    try {
      const addrs = heliaNode.libp2p.getMultiaddrs().map((a) => a.toString());
      multiaddrsEl.textContent = addrs.length ? addrs.join(', ') : '(none - browser node)';
    } catch (e) {
      multiaddrsEl.textContent = '(unavailable)';
    }

    publishBtn.disabled = false;
    fetchBtn.disabled = false;
    connectBtn.disabled = false;
    setConnectState('disconnected');
    bootstrapBtn.disabled = false;

    // Try common local Kubo multiaddrs by default
    const commonAddrs = ['/ip4/127.0.0.1/tcp/4001', '/ip4/127.0.0.1/tcp/4001/ws', '/ip4/127.0.0.1/tcp/5001'];
    (async () => {
      for (const a of commonAddrs) {
        try {
          await heliaNode.libp2p.dial(multiaddr(a));
          connectStatus.textContent = `Connected to ${a}`;
          inputMultiaddr.value = a;
          return;
        } catch (e) {
          // try next
        }
      }
      // Fall back to public bootstrap peers
      let connected = 0;
      for (const addr of bootstrapPeers) {
        try {
          await heliaNode.libp2p.dial(multiaddr(addr));
          connected++;
        } catch (e) {
          // ignore
        }
      }
      if (connected > 0) {
        connectStatus.textContent = `Connected to ${connected} bootstrap peer(s).`;
      } else {
        connectStatus.textContent = 'No common peer found. Enter a multiaddr manually.';
      }
    })();

    // Render the repository file tree immediately
    renderRepoTree();

    // Automatically add all files in the repo to IPFS
    addAllRepoFiles();
  } catch (error) {
    statusEl.textContent = `Initialization Error: ${error.message}`;
    statusEl.style.color = '#ff4444';
  }
}

// Publish text content directly to IPFS from the browser
publishBtn.addEventListener('click', async () => {
  const text = inputContent.value.trim();
  if (!text) return;

  publishBtn.disabled = true;
  outputCid.textContent = 'Publishing to DAG...';

  try {
    const cid = await heliaStrings.add(text);
    outputCid.textContent = cid.toString();
    inputCid.value = cid.toString();
  } catch (err) {
    outputCid.textContent = `Error publishing: ${err.message}`;
  } finally {
    publishBtn.disabled = false;
  }
});

async function fetchContent(cidStr, nameHint) {
  if (!cidStr) return;
  inputCid.value = cidStr;
  fetchBtn.disabled = true;
  downloadBtn.disabled = true;
  outputContent.textContent = 'Resolving blocks from IPFS network...';
  const downloadName = nameHint || null;
  lastFetchedCid = null;
  lastFetchedIsDir = false;

  try {
    const cid = CID.parse(cidStr);
    const stat = await heliaUnixfs.stat(cid);
    if (stat.type === 'directory') {
      const entries = [];
      for await (const entry of heliaUnixfs.ls(cid)) {
        entries.push((entry.type === 'directory' ? '📁 ' : '📄 ') + entry.name);
      }
      const dirText = entries.length ? entries.join('\\n') : '(empty directory)';
      outputContent.textContent = dirText;
      lastFetchedBytes = new TextEncoder().encode(dirText);
      lastFetchedName = downloadName ? downloadName + (downloadName.includes('.') ? '' : '.txt') : `ipfs-${cidStr.slice(0, 12)}-listing.txt`;
      lastFetchedCid = cidStr;
      lastFetchedIsDir = true;
      downloadBtn.disabled = false;
    } else {
      const chunks = [];
      for await (const chunk of heliaUnixfs.cat(cid)) {
        chunks.push(chunk);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      try {
        outputContent.textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        outputContent.textContent = `Binary content (${bytes.length} bytes)`;
      }
      lastFetchedBytes = bytes;
      lastFetchedName = downloadName || `ipfs-${cidStr.slice(0, 12)}`;
      lastFetchedCid = cidStr;
      lastFetchedIsDir = false;
      downloadBtn.disabled = false;
    }
  } catch (err) {
    // Fallback for string CIDs created via heliaStrings
    try {
      const cid = CID.parse(cidStr);
      const content = await heliaStrings.get(cid);
      outputContent.textContent = content;
      lastFetchedBytes = new TextEncoder().encode(content);
      lastFetchedName = downloadName || `ipfs-${cidStr.slice(0, 12)}.txt`;
      lastFetchedCid = cidStr;
      lastFetchedIsDir = false;
      downloadBtn.disabled = false;
    } catch (err2) {
      outputContent.textContent = `Error retrieving CID: ${err2.message}`;
    }
  } finally {
    fetchBtn.disabled = false;
  }
}

// Fetch IPFS content from any peer across the network using CID
fetchBtn.addEventListener('click', async () => {
  const cidStr = inputCid.value.trim();
  if (!cidStr) return;
  await fetchContent(cidStr);
});

async function collectIpfsDir(cidStr) {
  const cid = CID.parse(cidStr);
  const result = {};
  for await (const entry of heliaUnixfs.ls(cid)) {
    if (entry.type === 'directory') {
      result[entry.name] = await collectIpfsDir(entry.cid.toString());
    } else {
      const chunks = [];
      for await (const chunk of heliaUnixfs.cat(entry.cid)) {
        chunks.push(chunk);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      result[entry.name] = bytes;
    }
  }
  return result;
}

// Download the most recently fetched content
downloadBtn.addEventListener('click', async () => {
  if (!lastFetchedBytes && !lastFetchedCid) return;
  downloadBtn.disabled = true;
  try {
    let blob;
    let filename;
    if (lastFetchedIsDir && lastFetchedCid) {
      const tree = await collectIpfsDir(lastFetchedCid);
      const zipped = zipSync(tree);
      blob = new Blob([zipped], { type: 'application/zip' });
      filename = lastFetchedName.replace(/\.(txt|listing\.txt)$/, '') + '.zip';
      if (!filename || filename === '.zip') filename = 'ipfs-files.zip';
    } else {
      blob = new Blob([lastFetchedBytes], { type: 'application/octet-stream' });
      filename = lastFetchedName;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    outputContent.textContent = `Download error: ${err.message}`;
  } finally {
    downloadBtn.disabled = false;
  }
});

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Files tab actions
if (fetchSelectedBtn) {
  fetchSelectedBtn.addEventListener('click', async () => {
    if (!selectedFileCid) return;
    fileActionStatus.textContent = 'Fetching...';
    try {
      await fetchContent(selectedFileCid, selectedFileName);
      fileActionStatus.textContent = `Fetched ${selectedFileName}. Switch to the Fetch tab to view.`;
    } catch (err) {
      fileActionStatus.textContent = `Fetch failed: ${err.message}`;
      fileActionStatus.style.color = '#ff4444';
    }
  });
}

if (downloadSelectedBtn) {
  downloadSelectedBtn.addEventListener('click', async () => {
    if (!selectedFileCid) return;
    downloadSelectedBtn.disabled = true;
    fileActionStatus.textContent = 'Downloading...';
    fileActionStatus.style.color = '#00ff88';
    try {
      const cid = CID.parse(selectedFileCid);
      const stat = await heliaUnixfs.stat(cid);
      if (stat.type === 'directory') {
        const tree = await collectIpfsDir(selectedFileCid);
        const zipped = zipSync(tree);
        const filename = (selectedFileName || 'ipfs-files').replace(/\.(txt|listing\.txt)$/, '') + '.zip';
        downloadBytes(zipped, filename || 'ipfs-files.zip');
        fileActionStatus.textContent = `Downloaded ${filename}`;
      } else {
        const chunks = [];
        for await (const chunk of heliaUnixfs.cat(cid)) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
        downloadBytes(bytes, selectedFileName || `ipfs-${selectedFileCid.slice(0, 12)}`);
        fileActionStatus.textContent = `Downloaded ${selectedFileName}`;
      }
    } catch (err) {
      fileActionStatus.textContent = `Download failed: ${err.message}`;
      fileActionStatus.style.color = '#ff4444';
    } finally {
      downloadSelectedBtn.disabled = false;
    }
  });
}

// Whole-repo actions in Files tab
if (fetchRepoBtn) {
  fetchRepoBtn.addEventListener('click', async () => {
    const rootCid = outputCid.textContent.trim();
    if (!rootCid || rootCid === 'None') return;
    fileActionStatus.style.color = '#00ff88';
    fileActionStatus.textContent = 'Fetching whole repo...';
    try {
      await fetchContent(rootCid, 'repo');
      fileActionStatus.textContent = 'Fetched whole repo. Switch to the Fetch tab to view.';
    } catch (err) {
      fileActionStatus.textContent = `Fetch failed: ${err.message}`;
      fileActionStatus.style.color = '#ff4444';
    }
  });
}

if (downloadRepoBtn) {
  downloadRepoBtn.addEventListener('click', async () => {
    const rootCid = outputCid.textContent.trim();
    if (!rootCid || rootCid === 'None') return;
    downloadRepoBtn.disabled = true;
    fileActionStatus.style.color = '#00ff88';
    fileActionStatus.textContent = 'Downloading whole repo as zip...';
    try {
      const tree = await collectIpfsDir(rootCid);
      const zipped = zipSync(tree);
      downloadBytes(zipped, 'repo.zip');
      fileActionStatus.textContent = 'Downloaded repo.zip';
    } catch (err) {
      fileActionStatus.textContent = `Download failed: ${err.message}`;
      fileActionStatus.style.color = '#ff4444';
    } finally {
      downloadRepoBtn.disabled = false;
    }
  });
}

// Debug helpers (used by integration tests)
window.__runFetch = fetchContent;
window.__provideRoot = async () => {
  try {
    if (!heliaNode || !heliaNode.routing) return 'no routing';
    const cid = CID.parse(outputCid.textContent.trim());
    await Promise.race([
      heliaNode.routing.provide(cid),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    return 'provided OK';
  } catch (e) {
    return 'provide failed: ' + e.message;
  }
};
window.__getLastFetched = () => ({ len: lastFetchedBytes ? lastFetchedBytes.length : 0, name: lastFetchedName, isDir: lastFetchedIsDir });
window.__collectZipSize = async (cid) => {
  const tree = await collectIpfsDir(cid);
  const z = zipSync(tree);
  return z.length;
};

function setConnectState(state) {
  connectBtn.classList.remove('disconnected', 'connecting', 'connected');
  connectBtn.classList.add(state);
}

// Connect to a peer (e.g. Kubo Desktop) so it can fetch our blocks
connectBtn.addEventListener('click', async () => {
  const addr = inputMultiaddr.value.trim();
  if (!addr) return;

  // If already connected to the same peer, hang up first so the button acts as a retry
  if (connectedPeerAddr === addr) {
    try {
      await heliaNode.libp2p.hangUp(multiaddr(addr));
    } catch (e) {
      // ignore hangUp errors
    }
  }

  connectBtn.disabled = true;
  setConnectState('connecting');
  connectStatus.textContent = 'Dialing peer...';
  try {
    const ma = multiaddr(addr);
    await heliaNode.libp2p.dial(ma);
    connectedPeerAddr = addr;
    setConnectState('connected');
    connectStatus.textContent = 'Connected. The peer can now fetch the root CID.';
    // Re-provide after connecting
    if (rootCidForProvide) {
      try { await heliaNode.routing.provide(rootCidForProvide); } catch (e) {}
    }
  } catch (err) {
    connectedPeerAddr = null;
    setConnectState('disconnected');
    connectStatus.textContent = `Connection failed: ${err.message}`;
  } finally {
    connectBtn.disabled = false;
  }
});

const bootstrapPeers = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ'
];

bootstrapBtn.addEventListener('click', () => {
  bootstrapBtn.disabled = true;
  let connected = 0;
  let completed = 0;
  connectStatus.textContent = `Connecting to bootstrap peers... (0/${bootstrapPeers.length})`;

  const attempts = bootstrapPeers.map(async (addr) => {
    try {
      await heliaNode.libp2p.dial(multiaddr(addr));
      connected++;
    } catch (e) {
      // ignore
    } finally {
      completed++;
      connectStatus.textContent = `Connecting to bootstrap peers... (${connected}/${completed})`;
    }
  });

  Promise.allSettled(attempts).then(() => {
    connectStatus.textContent = connected > 0
      ? `Connected to ${connected} bootstrap peer(s).`
      : 'Could not connect to bootstrap peers.';
    bootstrapBtn.disabled = false;
  });
});

// Kubo RPC detection in Settings tab
function isBrowserDialable(addr) {
  return addr.includes('/ws') || addr.includes('/wss') || addr.includes('/webrtc') || addr.includes('/webtransport');
}

function normalizeAddressForProxy(addr, proxyPort) {
  // Replace /tcp/4002/ws with /tcp/<proxyPort>/wss for LAN use behind the local TLS proxy
  return addr.replace(/\/tcp\/\d+\/ws$/, `/tcp/${proxyPort}/wss`);
}

const currentOrigin = window.location.origin;
const currentPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

if (settingsCurrentOrigin) {
  settingsCurrentOrigin.textContent = `Current page origin: ${currentOrigin}`;
}

// Update CORS origin table with the actual port
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
setText('settings-url-127', `http://127.0.0.1:${currentPort}`);
setText('settings-origin-127', `http://127.0.0.1:${currentPort}`);
setText('settings-url-localhost', `http://localhost:${currentPort}`);
setText('settings-origin-localhost', `http://localhost:${currentPort}`);

const corsCommandText = `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '${JSON.stringify([currentOrigin])}'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'
ipfs daemon`;

const multiOriginCommandText = `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '${JSON.stringify([
  `http://127.0.0.1:${currentPort}`,
  `http://localhost:${currentPort}`,
  'http://127.0.0.1:4173',
  'https://yourusername.github.io'
])}'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'
ipfs daemon`;

if (settingsCorsCommand) {
  settingsCorsCommand.textContent = corsCommandText;
}

const settingsCorsMultiCommand = document.getElementById('settings-cors-multi-command');
if (settingsCorsMultiCommand) {
  settingsCorsMultiCommand.textContent = multiOriginCommandText;
}

if (copyCorsBtn) {
  copyCorsBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(corsCommandText);
      copyCorsBtn.textContent = 'Copied!';
      setTimeout(() => { copyCorsBtn.textContent = 'Copy CORS Command'; }, 1500);
    } catch (err) {
      copyCorsBtn.textContent = 'Copy failed';
      setTimeout(() => { copyCorsBtn.textContent = 'Copy CORS Command'; }, 1500);
    }
  });
}

async function tryKuboRpc(host, ports) {
  const errors = [];
  for (const port of ports) {
    const url = `http://${host}:${port}/api/v0/id`;
    try {
      const res = await fetch(url, { method: 'POST' });
      if (res.ok) {
        const info = await res.json();
        return { info, port };
      }
      errors.push(`${port}: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${port}: ${err.message || 'connection failed'}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function detectKubo(autoConnect = false) {
  const host = settingsRpcHost.value.trim() || '127.0.0.1';
  const userPort = settingsRpcPort.value.trim();
  const proxyPort = settingsRpcProxyPort.value.trim() || '4003';
  const defaultPorts = Array.from({ length: 10 }, (_, i) => String(5001 + i));
  const ports = userPort ? [userPort] : defaultPorts;

  settingsKuboStatus.textContent = 'Detecting Kubo on ' + ports.map(p => `${host}:${p}`).join(', ') + '...';
  settingsKuboResult.style.display = 'none';
  settingsKuboAddresses.innerHTML = '';

  try {
    const { info, port } = await tryKuboRpc(host, ports);
    const peerId = info.ID;
    const addresses = (info.Addresses || []).filter(isBrowserDialable);

    settingsRpcPort.value = port;
    settingsKuboPeerId.textContent = peerId;
    settingsKuboStatus.textContent = addresses.length
      ? `Found ${addresses.length} browser-dialable address(es) via RPC port ${port}.`
      : `Kubo found on port ${port}, but no browser-dialable /ws or /wss addresses. Run npm run kubo:ws first.`;

    // Update Connect input with the best detected address
    if (addresses.length && inputMultiaddr) {
      const best =
        addresses.find(a => a.includes('/ip4/127.0.0.1/') && a.includes('/ws') && !a.includes('/wss')) ||
        addresses.find(a => a.includes('/ws') && !a.includes('/wss')) ||
        addresses.find(a => a.includes('/wss')) ||
        addresses[0];
      inputMultiaddr.value = best;

      // Auto-connect if requested and Helia is ready
      if (autoConnect && connectBtn && !connectBtn.disabled) {
        setTimeout(() => connectBtn.click(), 100);
      }
    }

    const seen = new Set();
    for (const addr of addresses) {
      if (!seen.has(addr)) {
        seen.add(addr);
        const li = document.createElement('li');
        li.textContent = addr;
        li.title = 'Click to use this address';
        li.addEventListener('click', () => {
          inputMultiaddr.value = addr;
          document.getElementById('sub-tab-btn-connect').click();
        });
        settingsKuboAddresses.appendChild(li);
      }
      // Also offer a WSS proxy variant for plain WS addresses
      if (addr.includes('/ws') && !addr.includes('/wss')) {
        const proxyAddr = normalizeAddressForProxy(addr, proxyPort) + `/p2p/${peerId}`;
        if (!seen.has(proxyAddr)) {
          seen.add(proxyAddr);
          const li = document.createElement('li');
          li.textContent = proxyAddr + ' (via local WSS proxy)';
          li.title = 'Click to use this address';
          li.addEventListener('click', () => {
            inputMultiaddr.value = proxyAddr;
            document.getElementById('sub-tab-btn-connect').click();
          });
          settingsKuboAddresses.appendChild(li);
        }
      }
    }

    settingsKuboResult.style.display = 'block';
  } catch (err) {
    settingsKuboStatus.innerHTML = `Detection failed. <br><strong>Current page origin:</strong> ${window.location.origin}<br>Kubo must allow this origin via CORS (see below).<br><small>RPC errors: ${err.message}</small>`;
  }
}

if (detectKuboBtn) {
  detectKuboBtn.addEventListener('click', () => detectKubo(true));
}

// Auto-detect Kubo shortly after page load and auto-connect if found
setTimeout(() => {
  if (detectKuboBtn) detectKubo(true);
}, 1000);

// Tab navigation
document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    document.querySelectorAll('.tab-button').forEach((btn) => {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.remove('active');
    });
    button.classList.add('active');
    button.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.add('active');
  });
});

// Sub-tab navigation (inside Peer tab)
document.querySelectorAll('.sub-tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    const subtab = button.dataset.subtab;
    const parent = button.closest('.card');
    parent.querySelectorAll('.sub-tab-button').forEach((btn) => {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
    });
    parent.querySelectorAll('.sub-tab-panel').forEach((panel) => {
      panel.classList.remove('active');
    });
    button.classList.add('active');
    button.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(`sub-tab-${subtab}`);
    if (panel) panel.classList.add('active');
  });
});

initHelia();