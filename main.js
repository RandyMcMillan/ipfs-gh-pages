import { createHelia } from 'helia';
import { strings } from '@helia/strings';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';
import repoFiles from 'virtual:repo-files';

let heliaNode = null;
let heliaStrings = null;
let heliaUnixfs = null;
const repoTreeCids = new Map();

const statusEl = document.getElementById('node-status');
const peerIdEl = document.getElementById('peer-id');
const publishBtn = document.getElementById('btn-publish');
const fetchBtn = document.getElementById('btn-fetch');
const inputContent = document.getElementById('input-content');
const outputCid = document.getElementById('output-cid');
const inputCid = document.getElementById('input-cid');
const outputContent = document.getElementById('output-content');
const fileTreeEl = document.getElementById('file-tree');

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
          cidEl.title = 'Click to fetch this CID';
          cidEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            fetchContent(cid);
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
          cidEl.title = 'Click to fetch this CID';
          cidEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            fetchContent(cid);
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
      statusEl.textContent = 'Online & All repository files added to IPFS';
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

    const peerId = heliaNode.libp2p.peerId.toString();

    statusEl.textContent = 'Online & Connected to Peer-to-Peer Network';
    peerIdEl.textContent = peerId;

    publishBtn.disabled = false;
    fetchBtn.disabled = false;

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

async function fetchContent(cidStr) {
  if (!cidStr) return;
  inputCid.value = cidStr;
  fetchBtn.disabled = true;
  outputContent.textContent = 'Resolving blocks from IPFS network...';

  try {
    const cid = CID.parse(cidStr);
    const stat = await heliaUnixfs.stat(cid);
    if (stat.type === 'directory') {
      const entries = [];
      for await (const entry of heliaUnixfs.ls(cid)) {
        entries.push((entry.type === 'directory' ? '📁 ' : '📄 ') + entry.name);
      }
      outputContent.textContent = entries.length ? entries.join('\\n') : '(empty directory)';
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
    }
  } catch (err) {
    // Fallback for string CIDs created via heliaStrings
    try {
      const cid = CID.parse(cidStr);
      const content = await heliaStrings.get(cid);
      outputContent.textContent = content;
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

initHelia();