import { createHelia } from 'helia';
import { strings } from '@helia/strings';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';
import repoFiles from 'virtual:repo-files';
import { zipSync } from 'fflate';
import { multiaddr } from '@multiformats/multiaddr';
import { formatSize, base64ToUint8Array, buildRepoTree, isBrowserDialable, normalizeAddressForProxy } from './lib/shared.mjs';

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
// Set once a ?connect= share-link dial reaches a terminal state, so the
// concurrent startup/bootstrap dialing can't overwrite its outcome.
let shareLinkConnectSettled = false;
const repoTreeSizes = new Map();

const statusEl = document.getElementById('node-status');
const peerIdEl = document.getElementById('peer-id');
const multiaddrsEl = document.getElementById('multiaddrs');
const connectBtn = document.getElementById('btn-connect');
const bootstrapBtn = document.getElementById('btn-bootstrap');
const copyMultiaddrBtn = document.getElementById('btn-copy-multiaddr');
const copyLinkBtn = document.getElementById('btn-copy-link');
const shareStatus = document.getElementById('share-status');
const peersListEl = document.getElementById('peers-list');
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
const copyCorsMultiBtn = document.getElementById('btn-copy-cors-multi');
const fileSelectedEl = document.getElementById('file-selected');
const fetchSelectedBtn = document.getElementById('btn-fetch-selected');
const downloadSelectedBtn = document.getElementById('btn-download-selected');
const fetchRepoBtn = document.getElementById('btn-fetch-repo');
const downloadRepoBtn = document.getElementById('btn-download-repo');
const fileActionStatus = document.getElementById('file-action-status');
const cloneCidEl = document.getElementById('clone-cid');
const cloneZipBtn = document.getElementById('btn-clone-zip');
const cloneCidCopyBtn = document.getElementById('btn-clone-cid-copy');
const cloneStatus = document.getElementById('clone-status');

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

// Single file/folder tree renderer shared by the Repository File Tree and the
// fetched-content view. Terminal-style: monospace rows, dirs end in '/' and
// expand on click, CIDs are clickable. A node is { name, isDir, cid, size,
// children }, where children is an array (rendered eagerly), a zero-arg async
// function (loaded on first expand), or null for files and empty directories.
function renderFileTree(nodes, onCidClick) {
  const ul = document.createElement('ul');
  ul.className = 'tree-view';

  const sorted = [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of sorted) {
    const li = document.createElement('li');

    const makeCidEl = () => {
      const cidEl = document.createElement('span');
      cidEl.className = 'tree-cid';
      cidEl.textContent = ' ' + (node.cid || '');
      cidEl.title = node.isDir ? 'Click to select this directory CID' : 'Click to select this CID';
      cidEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (node.cid) onCidClick(node, cidEl);
      });
      return cidEl;
    };

    const makeSizeEl = () => {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'tree-size';
      sizeEl.textContent = ` (${formatSize(node.size)})`;
      return sizeEl;
    };

    const hasSize = node.size != null && Number(node.size) > 0;

    if (node.isDir) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${node.name}/`;
      if (node.cid) summary.appendChild(makeCidEl());
      if (hasSize) summary.appendChild(makeSizeEl());
      details.appendChild(summary);

      if (typeof node.children === 'function') {
        let loaded = false;
        details.addEventListener('toggle', async () => {
          if (!details.open || loaded) return;
          loaded = true;
          const childUl = document.createElement('ul');
          const placeholder = document.createElement('li');
          placeholder.className = 'tree-dim';
          placeholder.textContent = 'Loading...';
          childUl.appendChild(placeholder);
          details.appendChild(childUl);
          try {
            const children = await node.children();
            childUl.removeChild(placeholder);
            if (children.length === 0) {
              const empty = document.createElement('li');
              empty.className = 'tree-dim';
              empty.textContent = '(empty directory)';
              childUl.appendChild(empty);
            } else {
              childUl.appendChild(renderFileTree(children, onCidClick));
            }
          } catch (e) {
            placeholder.textContent = `Failed to load: ${e.message}`;
            placeholder.className = 'tree-error';
          }
        });
      } else if (Array.isArray(node.children) && node.children.length > 0) {
        details.appendChild(renderFileTree(node.children, onCidClick));
      }

      li.appendChild(details);
    } else {
      const nameEl = document.createElement('span');
      nameEl.className = 'tree-file';
      nameEl.textContent = node.name;
      li.appendChild(nameEl);
      if (node.cid) li.appendChild(makeCidEl());
      if (hasSize) li.appendChild(makeSizeEl());
    }
    ul.appendChild(li);
  }
  return ul;
}

function repoTreeNodes(tree, parentPath) {
  return Object.entries(tree.children).map(([name, child]) => {
    const childPath = parentPath ? parentPath + '/' + name : name;
    return {
      name,
      isDir: child.isDir,
      cid: repoTreeCids.get(childPath) || null,
      size: repoTreeSizes.get(childPath) ?? null,
      children: child.isDir ? repoTreeNodes(child, childPath) : null
    };
  });
}

function renderRepoTree() {
  if (!fileTreeEl) return;
  fileTreeEl.innerHTML = '';
  const tree = buildRepoTree(Object.keys(repoFiles));
  fileTreeEl.appendChild(renderFileTree(repoTreeNodes(tree, ''), (node, el) => {
    selectFile(node.cid, node.name, el);
  }));
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
      const rootCidStr = rootCid.toString();
      if (cloneCidEl) {
        cloneCidEl.textContent = rootCidStr;
        cloneCidEl.title = rootCidStr;
      }
      if (cloneZipBtn) cloneZipBtn.disabled = false;
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

      // Collect sizes for each CID in the tree
      await Promise.all(
        Array.from(repoTreeCids.entries()).map(async ([path, cidStr]) => {
          try {
            const st = await heliaUnixfs.stat(CID.parse(cidStr));
            repoTreeSizes.set(path, st.size);
          } catch {
            repoTreeSizes.set(path, null);
          }
        })
      );

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

    // Try common local Kubo WebSocket multiaddrs by default. Raw TCP (4001) and the RPC
    // API port (5001) cannot be dialed by a browser node — see Connection Help.
    const commonAddrs = ['/ip4/127.0.0.1/tcp/4002/ws', '/ip4/127.0.0.1/tcp/4001/ws'];
    (async () => {
      for (const a of commonAddrs) {
        try {
          await heliaNode.libp2p.dial(multiaddr(a));
          if (!shareLinkConnectSettled) {
            connectStatus.textContent = `Connected to ${a}`;
            inputMultiaddr.value = a;
          }
          return;
        } catch (e) {
          // try next
        }
      }
      // Fall back to public bootstrap peers, with live progress so the
      // connect status is never silently blank. Each dial is raced against a
      // timeout: an unresponsive peer must not stall the loop (or the final
      // status) forever.
      let connected = 0;
      let completed = 0;
      if (!shareLinkConnectSettled) {
        connectStatus.textContent = `Connecting to bootstrap peers... (0/${bootstrapPeers.length})`;
      }
      for (const addr of bootstrapPeers) {
        try {
          await Promise.race([
            heliaNode.libp2p.dial(multiaddr(addr)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('dial timeout')), 20000))
          ]);
          connected++;
        } catch (e) {
          // ignore
        } finally {
          completed++;
          if (!shareLinkConnectSettled) {
            connectStatus.textContent = `Connecting to bootstrap peers... (${completed}/${bootstrapPeers.length})`;
          }
        }
      }
      if (!shareLinkConnectSettled) {
        if (connected > 0) {
          connectStatus.textContent = `Connected to ${connected} bootstrap peer(s).`;
        } else {
          connectStatus.textContent = 'No common peer found. Enter a multiaddr manually.';
        }
      }
    })();

    // Render the repository file tree immediately
    renderRepoTree();

    // Automatically add all files in the repo to IPFS
    addAllRepoFiles();

    // Auto-connect to a peer provided via URL (?connect=...)
    autoConnectFromUrl();

    // Detect a local Kubo immediately (probes RPC, then test-dials
    // candidates). Share-link pages own the field instead.
    if (!hasShareLinkParam) detectKubo();
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

// Convert a fetched UnixFS directory into renderFileTree nodes. Subdirectory
// contents load lazily on first expand (one network ls per expand), so large
// repos don't block the initial view.
async function fetchedDirNodes(cid) {
  const entries = [];
  for await (const entry of heliaUnixfs.ls(cid)) {
    entries.push(entry);
  }
  const sizes = await Promise.all(entries.map(async (entry) => {
    try {
      const st = await heliaUnixfs.stat(entry.cid);
      return st.size;
    } catch (e) {
      return null;
    }
  }));
  return entries.map((entry, i) => {
    const isDir = entry.type === 'directory';
    return {
      name: entry.name,
      isDir,
      cid: entry.cid.toString(),
      size: sizes[i],
      children: isDir ? () => fetchedDirNodes(entry.cid) : null
    };
  });
}

function onFetchedCidClick(node) {
  inputCid.value = node.cid;
  fetchContent(node.cid, node.name);
}

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
        entries.push(entry);
      }
      outputContent.innerHTML = '';
      if (entries.length) {
        const heading = document.createElement('p');
        heading.textContent = `Directory with ${entries.length} item(s):`;
        heading.style.marginTop = '0';
        outputContent.appendChild(heading);
        outputContent.appendChild(renderFileTree(await fetchedDirNodes(cid), onFetchedCidClick));
        const dirText = entries.map(e => (e.type === 'directory' ? '📁 ' : '📄 ') + e.name).join('\\n');
        lastFetchedBytes = new TextEncoder().encode(dirText);
      } else {
        outputContent.textContent = '(empty directory)';
        lastFetchedBytes = new TextEncoder().encode('(empty directory)');
      }
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
    const baseName = (lastFetchedName || `ipfs-${lastFetchedCid.slice(0, 12)}`).replace(/\.(txt|listing\.txt)$/, '');
    const filename = `${baseName}.${lastFetchedCid}.zip`;
    let zipped;
    if (lastFetchedIsDir && lastFetchedCid) {
      const tree = await collectIpfsDir(lastFetchedCid);
      zipped = zipSync(tree);
    } else {
      zipped = zipSync({ [baseName]: lastFetchedBytes });
    }
    const blob = new Blob([zipped], { type: 'application/zip' });
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
      const baseName = (selectedFileName || `ipfs-${selectedFileCid.slice(0, 12)}`).replace(/\.(txt|listing\.txt)$/, '');
      const filename = `${baseName}.${selectedFileCid}.zip`;
      let zipped;
      if (stat.type === 'directory') {
        const tree = await collectIpfsDir(selectedFileCid);
        zipped = zipSync(tree);
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
        zipped = zipSync({ [baseName]: bytes });
      }
      downloadBytes(zipped, filename);
      fileActionStatus.textContent = `Downloaded ${filename}`;
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
      fileActionStatus.textContent = '';
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
      const filename = `${rootCid}.zip`;
      downloadBytes(zipped, filename);
      fileActionStatus.textContent = `Downloaded ${filename}`;
    } catch (err) {
      fileActionStatus.textContent = `Download failed: ${err.message}`;
      fileActionStatus.style.color = '#ff4444';
    } finally {
      downloadRepoBtn.disabled = false;
    }
  });
}

// Clone bar: copy the root CID, or fetch the whole repo and download a zip.
if (cloneCidCopyBtn) {
  cloneCidCopyBtn.addEventListener('click', async () => {
    const cid = (cloneCidEl && cloneCidEl.title) || '';
    if (!cid) return;
    try {
      await navigator.clipboard.writeText(cid);
      if (cloneStatus) cloneStatus.textContent = 'Copied root CID to clipboard.';
    } catch (e) {
      if (cloneStatus) cloneStatus.textContent = cid;
    }
  });
}

if (cloneCidEl) {
  cloneCidEl.addEventListener('click', () => {
    const cid = cloneCidEl.title || '';
    if (!cid || !navigator.clipboard) return;
    navigator.clipboard.writeText(cid).then(() => {
      if (cloneStatus) cloneStatus.textContent = 'Copied root CID to clipboard.';
    }).catch(() => {});
  });
}

if (cloneZipBtn) {
  cloneZipBtn.addEventListener('click', async () => {
    const rootCid = outputCid.textContent.trim();
    if (!rootCid || rootCid === 'None') return;
    cloneZipBtn.disabled = true;
    if (cloneStatus) {
      cloneStatus.style.color = '#00ff88';
      cloneStatus.textContent = 'Fetching repo from IPFS network...';
    }
    try {
      // Fetch into Retrieved Data as the clone preview, then package the zip.
      await fetchContent(rootCid, 'repo');
      if (cloneStatus) cloneStatus.textContent = 'Packaging zip...';
      const tree = await collectIpfsDir(rootCid);
      const zipped = zipSync(tree);
      const filename = `${rootCid.slice(0, 12)}.zip`;
      downloadBytes(zipped, filename);
      if (cloneStatus) cloneStatus.textContent = `Downloaded ${filename}`;
    } catch (err) {
      if (cloneStatus) {
        cloneStatus.style.color = '#ff4444';
        cloneStatus.textContent = `Clone failed: ${err.message}`;
      }
    } finally {
      cloneZipBtn.disabled = false;
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
window.__getShareableMultiaddr = getShareableMultiaddr;
window.__dialMultiaddr = (addr) => heliaNode.libp2p.dial(multiaddr(addr));

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

// --- Inter-browser sharing helpers ---
function getShareableMultiaddr() {
  if (!heliaNode) return null;
  const addrs = heliaNode.libp2p.getMultiaddrs().map(a => a.toString());
  // Prefer a relayed WebRTC address (dialable by other browsers)
  const webrtc = addrs.find(a => a.includes('/p2p-circuit') && a.includes('/webrtc'));
  if (webrtc) return webrtc;
  const wss = addrs.find(a => a.includes('/p2p-circuit') && a.includes('/wss'));
  if (wss) return wss;
  const circuit = addrs.find(a => a.includes('/p2p-circuit'));
  if (circuit) return circuit;
  return addrs[0] || null;
}

function refreshPeers() {
  if (!heliaNode || !peersListEl) return;
  try {
    const peers = heliaNode.libp2p.getPeers();
    if (!peers || peers.length === 0) {
      peersListEl.innerHTML = '<li>(none)</li>';
      return;
    }
    peersListEl.innerHTML = '';
    for (const p of peers) {
      const li = document.createElement('li');
      li.textContent = p.toString();
      li.style.fontSize = '0.85rem';
      li.style.wordBreak = 'break-all';
      peersListEl.appendChild(li);
    }
  } catch (e) {
    // ignore
  }
}

if (copyMultiaddrBtn) {
  copyMultiaddrBtn.addEventListener('click', async () => {
    const ma = getShareableMultiaddr();
    if (!ma) { shareStatus.textContent = 'No shareable address yet. Wait for a relay reservation.'; return; }
    try {
      await navigator.clipboard.writeText(ma);
      shareStatus.textContent = 'Copied multiaddr to clipboard.';
    } catch (e) {
      shareStatus.textContent = ma;
    }
  });
}

const shareLinkField = document.getElementById('share-link-field');

// Current share link for this node, or null if no relayed address yet.
function buildShareLink() {
  const ma = getShareableMultiaddr();
  if (!ma) return null;
  const url = new URL(window.location.href);
  url.searchParams.set('connect', ma);
  return url.toString();
}

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    const link = buildShareLink();
    if (!link) { shareStatus.textContent = 'No shareable address yet. Wait for a relay reservation.'; return; }
    if (shareLinkField) shareLinkField.value = link;
    try {
      await navigator.clipboard.writeText(link);
      shareStatus.textContent = 'Copied share link to clipboard.';
    } catch (e) {
      shareStatus.textContent = 'Copy failed — select the link field and copy it manually.';
    }
  });
}

if (shareLinkField) {
  shareLinkField.addEventListener('click', () => shareLinkField.select());
  shareLinkField.addEventListener('focus', () => shareLinkField.select());
}

// Auto-connect to a peer provided via URL (?connect=...)
// Retries a few times: the sharing node's relay reservation may still be
// settling when the recipient opens the link.
async function autoConnectFromUrl() {
  if (!heliaNode) return;
  const params = new URLSearchParams(window.location.search);
  const addr = params.get('connect') || params.get('peer');
  if (!addr) return;
  inputMultiaddr.value = addr;

  // Plain ws:// can never succeed from an https page: browsers block it as
  // mixed content, and the failed dial would otherwise hang until libp2p's
  // dial timeout on every retry. Fail fast with an actionable message.
  if (window.location.protocol === 'https:' && addr.includes('/ws') && !addr.includes('/wss')) {
    shareLinkConnectSettled = true;
    setConnectState('disconnected');
    connectStatus.textContent = 'Auto-connect failed: plain ws:// addresses cannot be dialed from an https page (browser mixed-content block). Use a webrtc-direct or wss address instead.';
    shareStatus.textContent = 'Share-link connect failed — this link uses ws://, which browsers block on https pages. Ask the sender for a webrtc-direct or wss link.';
    return;
  }

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      shareStatus.textContent = attempt === 1
        ? 'Connecting to peer from link...'
        : `Retrying connection from link (${attempt}/${MAX_ATTEMPTS})...`;
      await heliaNode.libp2p.dial(multiaddr(addr));
      shareLinkConnectSettled = true;
      connectedPeerAddr = addr;
      setConnectState('connected');
      connectStatus.textContent = 'Connected to peer from link.';
      shareStatus.textContent = 'Connected via share link.';
      if (rootCidForProvide) {
        try { await heliaNode.routing.provide(rootCidForProvide); } catch (e) {}
      }
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        shareLinkConnectSettled = true;
        setConnectState('disconnected');
        connectStatus.textContent = `Auto-connect failed: ${err.message}`;
        shareStatus.textContent = 'Share-link connect failed — the address may be stale. Ask the sender to copy a fresh share link.';
      } else {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
}

// Periodically refresh peers + enable share buttons once a circuit address exists
setInterval(() => {
  refreshPeers();
  const ma = getShareableMultiaddr();
  if (ma) {
    if (copyMultiaddrBtn) copyMultiaddrBtn.disabled = false;
    if (copyLinkBtn) copyLinkBtn.disabled = false;
    if (shareLinkField && !shareLinkField.value) shareLinkField.value = buildShareLink() || '';
  }
}, 2000);

// Kubo RPC detection in Settings tab
const currentOrigin = window.location.origin;
const currentPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');

if (settingsCurrentOrigin) {
  const originLink = document.createElement('a');
  originLink.href = currentOrigin;
  originLink.textContent = currentOrigin;
  originLink.target = '_blank';
  originLink.rel = 'noopener';
  settingsCurrentOrigin.textContent = '';
  settingsCurrentOrigin.appendChild(originLink);
}

// Update CORS origin table with the actual port
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
const isLocalDev = currentOrigin.startsWith('http://127.0.0.1') || currentOrigin.startsWith('http://localhost');
const devPort = isLocalDev ? currentPort : '5173';
const previewPort = isLocalDev ? currentPort : '4173';
setText('settings-url-127', `http://127.0.0.1:${devPort}`);
setText('settings-origin-127', `http://127.0.0.1:${devPort}`);
setText('settings-url-localhost', `http://localhost:${devPort}`);
setText('settings-origin-localhost', `http://localhost:${devPort}`);
setText('settings-url-preview', `http://127.0.0.1:${previewPort}`);
setText('settings-origin-preview', `http://127.0.0.1:${previewPort}`);

const corsCommandText = `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '${JSON.stringify([currentOrigin])}'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'
ipfs daemon`;

const multiOriginCommandText = `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '${JSON.stringify([
  currentOrigin,
  `http://127.0.0.1:${devPort}`,
  `http://localhost:${devPort}`,
  `http://127.0.0.1:${previewPort}`
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

if (copyCorsMultiBtn) {
  copyCorsMultiBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(multiOriginCommandText);
      copyCorsMultiBtn.textContent = 'Copied!';
      setTimeout(() => { copyCorsMultiBtn.textContent = 'Copy Multi-Origin CORS Command'; }, 1500);
    } catch (err) {
      copyCorsMultiBtn.textContent = 'Copy failed';
      setTimeout(() => { copyCorsMultiBtn.textContent = 'Copy Multi-Origin CORS Command'; }, 1500);
    }
  });
}

// Kubo API ports we probe when none is pinned in Settings.
const KUBO_RPC_PORTS = Array.from({ length: 10 }, (_, i) => String(5001 + i));
const KUBO_PROBE_TIMEOUT_MS = 2000;

async function probeKuboRpc(host, port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KUBO_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/api/v0/id`, {
      method: 'POST',
      signal: controller.signal
    });
    if (res.ok) {
      return { port, info: await res.json() };
    }
    return { port, error: `${port}: HTTP ${res.status}` };
  } catch (err) {
    return { port, error: `${port}: ${err.message || 'connection failed'}` };
  } finally {
    clearTimeout(timer);
  }
}

// Probe every port in parallel so one dead/unresponsive port can't stall the scan.
async function tryKuboRpc(host, ports) {
  const results = await Promise.all(ports.map(port => probeKuboRpc(host, port)));
  const found = results.find(result => result.info);
  if (found) {
    return { info: found.info, port: found.port };
  }
  throw new Error(results.map(result => result.error).join('; '));
}

// Try dialing an address with a timeout; used to verify a detected Kubo
// address actually works from this browser before it lands in the Connect
// field. On success it applies the same UI state as a manual connect.
async function probeDial(addr, timeoutMs = 8000) {
  if (!heliaNode) return false;
  try {
    await Promise.race([
      heliaNode.libp2p.dial(multiaddr(addr)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), timeoutMs))
    ]);
    connectedPeerAddr = addr;
    setConnectState('connected');
    connectStatus.textContent = `Connected to ${addr}`;
    return true;
  } catch {
    return false;
  }
}

// A pinned port in Settings is probed first, then the full 5001-5010 range.
// Candidate addresses are then probe-dialed (best first) until one connects,
// so the Connect field ends up with an address verified to work from this
// browser — not just the first one that looks dialable.
async function detectKubo() {
  const host = settingsRpcHost.value.trim() || '127.0.0.1';
  const userPort = settingsRpcPort.value.trim();
  const proxyPort = settingsRpcProxyPort.value.trim() || '4003';
  const pinnedPorts = userPort ? [userPort] : [];
  const ports = [...pinnedPorts, ...KUBO_RPC_PORTS.filter(port => !pinnedPorts.includes(port))];

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

    // Update Connect input by probe-dialing candidates (best first).
    // Plain ws:// dials are blocked as mixed content from https (non-localhost)
    // pages, so from GitHub Pages webrtc-direct ranks above ws there.
    if (addresses.length && inputMultiaddr) {
      const isPlainWs = (a) => a.includes('/ws') && !a.includes('/wss');
      const pageIsSecureNonLocal = window.location.protocol === 'https:' && !isLocalDev;
      const score = (a) => {
        if (pageIsSecureNonLocal) {
          if (a.includes('/webrtc-direct')) return 0;
          if (a.includes('/wss')) return 1;
          return 2; // plain ws:// is mixed content here
        }
        if (a.includes('/ip4/127.0.0.1/') && isPlainWs(a)) return 0;
        if (isPlainWs(a)) return 1;
        if (a.includes('/webrtc-direct')) return 2;
        return 3;
      };
      const candidates = [...addresses].sort((a, b) => score(a) - score(b)).slice(0, 3);

      settingsKuboStatus.textContent += ` Probing ${candidates.length} address(es)...`;
      let connectedAddr = null;
      for (const addr of candidates) {
        settingsKuboStatus.textContent = `Probing ${addr}...`;
        if (await probeDial(addr)) {
          connectedAddr = addr;
          break;
        }
      }
      if (connectedAddr) {
        inputMultiaddr.value = connectedAddr;
        settingsKuboStatus.textContent = `Connected via ${connectedAddr} (RPC port ${port}).`;
      } else {
        settingsKuboStatus.textContent = `Kubo found on port ${port}, but none of the ${candidates.length} probed address(es) connected. Pick one from the list below.`;
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
    settingsKuboStatus.innerHTML = `Detection failed. <br>Kubo must allow this origin via CORS (see below): <a href="${window.location.origin}" target="_blank" rel="noopener">${window.location.origin}</a><br><small>RPC errors: ${err.message}</small>`;
  }
}

if (detectKuboBtn) {
  detectKuboBtn.addEventListener('click', () => detectKubo());
}

// Share-link pages (?connect=/?peer=) own the multiaddr field: Kubo detection
// must not overwrite or dial over it. Non-share-link pages run detection
// immediately from initHelia once the node exists.
const hasShareLinkParam = (() => {
  const p = new URLSearchParams(window.location.search);
  return p.has('connect') || p.has('peer');
})();

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

// Multiaddr help modal (Peer → Connect "?")
const multiaddrHelpModal = document.getElementById('multiaddr-help-modal');
const multiaddrHelpBtn = document.getElementById('btn-multiaddr-help');
if (multiaddrHelpModal && multiaddrHelpBtn) {
  multiaddrHelpBtn.addEventListener('click', () => {
    multiaddrHelpModal.hidden = false;
  });
  const closeBtn = document.getElementById('btn-close-multiaddr-help');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      multiaddrHelpModal.hidden = true;
    });
  }
  multiaddrHelpModal.addEventListener('click', (e) => {
    if (e.target === multiaddrHelpModal) multiaddrHelpModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !multiaddrHelpModal.hidden) multiaddrHelpModal.hidden = true;
  });
}

initHelia();