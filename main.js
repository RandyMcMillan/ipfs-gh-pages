import '@primer/css/dist/primer.css';
import { createHelia, libp2pDefaults } from 'helia';
import { createLibp2p } from 'libp2p';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { ipns } from '@helia/ipns';
import { generateKeyPair, privateKeyFromRaw, publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id';
import * as dagJson from '@ipld/dag-json';
import { sha256 } from 'multiformats/hashes/sha2';
import { car } from '@helia/car';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car/reader';
import repoIdentity from 'virtual:repo-identity';
import repoSubmodules from 'virtual:repo-submodules';
import { strings } from '@helia/strings';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';
import repoFiles from 'virtual:repo-files';
import repoMode from 'virtual:repo-mode';

// --- Repo file source ----------------------------------------------------
// 'embedded' (small repos): file contents are base64-inlined in the bundle
// via virtual:repo-files — zero fetches. 'car' (large repos): the bundle
// carries no contents; paths + CIDs come from dist/repo-manifest.json and
// bytes from dist/repo.car, both written by scripts/build-car.mjs. The
// build picks the mode by total repo bytes (EMBED_THRESHOLD_BYTES in
// scripts/lib/repo-files.mjs); both modes expose the same interface below.
const repoCarIndex = new Map(); // car mode: path -> { cid, size }
let repoCarRoot = null;         // car mode: manifest root CID string
let repoCarImportPromise = null;

function repoPaths() {
  return repoMode === 'car' ? Array.from(repoCarIndex.keys()) : Object.keys(repoFiles);
}
function hasRepoFile(p) {
  return repoMode === 'car' ? repoCarIndex.has(p) : Object.hasOwn(repoFiles, p);
}

async function loadRepoManifest() {
  const res = await fetch(new URL('repo-manifest.json', document.baseURI));
  if (!res.ok) throw new Error(`repo-manifest.json: HTTP ${res.status}`);
  const data = await res.json();
  repoCarIndex.clear();
  for (const f of data.files) {
    repoCarIndex.set(f.path, { cid: f.cid, size: f.size });
    repoTreeCids.set(f.path, f.cid);
    repoTreeSizes.set(f.path, f.size);
  }
  repoCarRoot = data.root;
  return data;
}

async function ensureRepoCar() {
  if (!heliaNode) return 0;
  if (!repoCarImportPromise) {
    repoCarImportPromise = (async () => {
      const res = await fetch(new URL('repo.car', document.baseURI));
      if (!res.ok) throw new Error(`repo.car: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await car(heliaNode).import(await CarReader.fromBytes(bytes));
      return bytes.length;
    })();
  }
  return repoCarImportPromise;
}

async function repoBytes(p) {
  if (repoMode !== 'car') {
    const b64 = repoFiles[p];
    return b64 ? base64ToUint8Array(b64) : null;
  }
  const entry = repoCarIndex.get(p);
  if (!entry) return null;
  await ensureRepoCar();
  const chunks = [];
  for await (const chunk of heliaUnixfs.cat(CID.parse(entry.cid))) chunks.push(chunk);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
// --- end repo file source ------------------------------------------------
import { zipSync } from 'fflate';
import { multiaddr } from '@multiformats/multiaddr';
import { formatSize, base64ToUint8Array, uint8ArrayToBase64, buildRepoTree, isBrowserDialable, normalizeAddressForProxy } from './lib/shared.mjs';

import { classifyIndexSync } from './js/index-merge.js';
import { normalizeLineRange, makeLineCommentFields, isLineCommentNote, commentsByLine } from './js/line-comments.js';
import { collectReleases, blameLines, blameCommentMatches } from './js/blame.js';
import { findCidTokens, cidAffordanceModel } from './js/cid-links.js';
import { sanitizeMarkdownHtml, rewriteRendered, sandboxedFrame } from './js/markdown.js';
import { rehostAndRewrite } from './js/rehost.js';

// Repo identity: prefer the Pages origin (<owner>.github.io/<repo>), then the
// build-time identity baked by the action (GITHUB_REPOSITORY / git remote), so
// the chrome is correct for whoever deploys this app.
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
const repoUrl = `https://github.com/${repoFullName}`;
const pagesUrl = `https://${repoOwner}.github.io/${repoName}/`;
const appVersion = repoIdentity.version || '';
// The header "latest release" chip shows the REPO's own latest TAG, baked
// at build time from the checkout (consumer workflows fetch the newest tag
// — see deploy-gh-pages.yml). appVersion (the ACTION's package version) is
// NOT a fallback: on a consumer repo with no tags it would print the
// action's release there — a lie. appVersion stays the Actions panel's
// "Built as v…" and nothing else.
const tagVersion = repoIdentity.tagVersion || '';

function applyRepoIdentity() {
  document.title = repoFullName;
  const search = document.getElementById('repo-search-input');
  if (search) search.value = repoFullName;
  // Baked chip: only when the checkout really had a tag. No tag → the row
  // stays hidden (see index.html) — never the action's version.
  if (tagVersion) {
    const rel = document.getElementById('latest-release-version');
    if (rel) rel.textContent = `v${tagVersion}`;
    const relLink = document.getElementById('latest-release-link');
    if (relLink) {
      relLink.hidden = false;
      relLink.dataset.ghpath = `/releases/tag/v${tagVersion}`;
    }
  }
  document.querySelectorAll('a.gh-link').forEach((a) => {
    a.href = repoUrl + (a.dataset.ghpath || '');
  });
  document.querySelectorAll('a.gh-owner-link').forEach((a) => {
    a.href = `https://github.com/${repoOwner}`;
    a.textContent = repoOwner;
  });
  // The header avatar link wraps the owner image (no text to rewrite) and
  // works for both user and organization owners — the .png shortcut
  // redirects to the right avatar for either.
  document.querySelectorAll('a.Header-link').forEach((a) => {
    a.href = `https://github.com/${repoOwner}`;
  });
  document.querySelectorAll('a.gh-repo-link').forEach((a) => {
    a.href = repoUrl;
    a.textContent = repoName;
  });
  document.querySelectorAll('img.gh-avatar').forEach((img) => {
    img.src = `https://github.com/${repoOwner}.png`;
    img.alt = repoOwner;
  });
  const website = document.getElementById('pages-website-link');
  if (website) {
    website.href = pagesUrl;
    const label = website.querySelector('span');
    if (label) label.textContent = pagesUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
  }
}

// GitHub-style relative time: "14 minutes ago", "yesterday", "3 weeks ago".
function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} week${w === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

// Fill the commit bar with the real last-commit info captured at build time.
function applyBuildInfo() {
  const msg = document.getElementById('commit-msg');
  if (msg && repoIdentity.lastCommitMsg) msg.textContent = repoIdentity.lastCommitMsg;
  const time = document.getElementById('commit-time');
  if (time) {
    if (repoIdentity.lastCommitTime) {
      time.textContent = relativeTime(repoIdentity.lastCommitTime);
      time.title = repoIdentity.lastCommitTime;
      time.setAttribute('datetime', repoIdentity.lastCommitTime);
    } else {
      time.textContent = '';
    }
  }
  const count = document.getElementById('commit-count');
  if (count) {
    count.textContent = repoIdentity.commitCount ? `${repoIdentity.commitCount} Commits` : '';
  }
}
applyRepoIdentity();
applyBuildInfo();

// Live repo metadata from the public GitHub API (unauthenticated,
// 60 req/h/IP): real Watch/Fork/Star counts, description, topics, release
// info, and language breakdown. Cached in localStorage for 30 minutes;
// failures silently keep the static build-time values.
const GH_META_TTL_MS = 30 * 60 * 1000;
const LINGUIST_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#563d7c',
  Rust: '#dea584', Python: '#3572A5', Shell: '#89e051', Go: '#00ADD8',
  Ruby: '#701516', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
  Vue: '#41b883', Java: '#b07219', PHP: '#4F5D95', Kotlin: '#A97BFF'
};

async function refreshRepoMetadata() {
  const cacheKey = `gh-meta-${repoFullName}`;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
  } catch (e) {}
  if (cached && Date.now() - cached.fetchedAt < GH_META_TTL_MS) {
    applyRepoMetadata(cached);
    return;
  }
  try {
    const headers = { accept: 'application/vnd.github+json' };
    const [repoRes, langRes, branchRes, tagRes, relRes, relCountRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repoFullName}`, { headers }),
      fetch(`https://api.github.com/repos/${repoFullName}/languages`, { headers }),
      // Exact branch count in one tiny request: per_page=1 + the Link
      // header's last page (no Link → the array itself is 0 or 1).
      fetch(`https://api.github.com/repos/${repoFullName}/branches?per_page=1`, { headers }),
      fetch(`https://api.github.com/repos/${repoFullName}/tags?per_page=1`, { headers }),
      fetch(`https://api.github.com/repos/${repoFullName}/releases/latest`, { headers }),
      fetch(`https://api.github.com/repos/${repoFullName}/releases?per_page=1`, { headers })
    ]);
    if (!repoRes.ok) return;
    const repo = await repoRes.json();
    const languages = langRes.ok ? await langRes.json() : null;
    let branches = null;
    if (branchRes.ok) {
      const link = branchRes.headers.get('link');
      const last = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      branches = last ? parseInt(last[1], 10) : (await branchRes.json()).length;
    }
    let tags = null;
    if (tagRes.ok) {
      const link = tagRes.headers.get('link');
      const last = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      tags = last ? parseInt(last[1], 10) : (await tagRes.json()).length;
    }
    // Latest release, else newest tag (repos without releases still show
    // their real tag — the agregore v1.5.0-vs-v2.24.0 bug).
    let release = null;
    if (relRes.ok) {
      const r = await relRes.json();
      if (r.tag_name) release = { tag: r.tag_name, url: r.html_url };
    } else {
      const tagsRes = await fetch(`https://api.github.com/repos/${repoFullName}/tags?per_page=1`, { headers });
      if (tagsRes.ok) {
        const tags = await tagsRes.json();
        if (tags.length) release = { tag: tags[0].name, url: `https://github.com/${repoFullName}/releases/tag/${tags[0].name}` };
      }
    }
    let releaseCount = null;
    if (relCountRes.ok) {
      const link = relCountRes.headers.get('link');
      const last = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      releaseCount = last ? parseInt(last[1], 10) : (await relCountRes.json()).length;
    }
    const meta = { fetchedAt: Date.now(), repo, languages, branches, tags, release, releaseCount };
    try { localStorage.setItem(cacheKey, JSON.stringify(meta)); } catch (e) {}
    applyRepoMetadata(meta);
  } catch (e) {
    // offline or rate-limited — keep static values
  }
}

function applyRepoMetadata(meta) {
  const { repo, languages } = meta;
  const setCount = (id, n) => {
    const el = document.getElementById(id);
    if (el && typeof n === 'number') el.textContent = n.toLocaleString();
  };
  setCount('gh-watch-count', repo.subscribers_count);
  setCount('gh-fork-count', repo.forks_count);
  setCount('gh-star-count', repo.stargazers_count);
  if (typeof meta.branches === 'number') {
    const el = document.getElementById('gh-branches-count');
    if (el) {
      el.hidden = false;
      el.textContent = `${meta.branches} Branch${meta.branches === 1 ? '' : 'es'}`;
    }
  }
  if (typeof meta.tags === 'number') {
    const el = document.getElementById('gh-tags-count');
    if (el) {
      el.hidden = false;
      el.textContent = `${meta.tags} Tag${meta.tags === 1 ? '' : 's'}`;
    }
  }
  // Live release/tag beats the build-time bake (which only refreshes when
  // the site rebuilds; the API answer is always current).
  if (meta.release && meta.release.tag) {
    const rel = document.getElementById('latest-release-version');
    if (rel) rel.textContent = meta.release.tag;
    const relLink = document.getElementById('latest-release-link');
    if (relLink) {
      relLink.hidden = false;
      relLink.dataset.ghpath = `/releases/tag/${meta.release.tag}`;
      relLink.href = meta.release.url;
    }
  }
  if (typeof meta.releaseCount === 'number' && meta.releaseCount > 0) {
    const more = document.getElementById('releases-more');
    if (more) {
      more.hidden = false;
      more.textContent = `+ ${meta.releaseCount} release${meta.releaseCount === 1 ? '' : 's'}`;
    }
  }

  if (repo.description) {
    const desc = document.getElementById('about-description');
    if (desc) desc.textContent = repo.description;
  }
  if (Array.isArray(repo.topics) && repo.topics.length > 0) {
    const box = document.getElementById('about-topics');
    if (box) {
      box.innerHTML = '';
      for (const topic of repo.topics) {
        const a = document.createElement('a');
        a.className = 'topic-chip';
        a.href = `https://github.com/topics/${topic}`;
        a.textContent = topic;
        a.target = '_blank';
        a.rel = 'noopener';
        box.appendChild(a);
      }
      box.style.display = 'block';
    }
  }
  if (languages && Object.keys(languages).length > 0) {
    const total = Object.values(languages).reduce((a, b) => a + b, 0);
    const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
    const bar = document.getElementById('lang-bar');
    const legend = document.getElementById('lang-legend');
    if (bar) {
      bar.innerHTML = '';
      for (const [lang] of entries) {
        const span = document.createElement('span');
        span.style.width = `${(languages[lang] / total) * 100}%`;
        span.style.background = LINGUIST_COLORS[lang] || '#999999';
        bar.appendChild(span);
      }
    }
    if (legend) {
      legend.innerHTML = entries.map(([lang, bytes]) => {
        const pct = ((bytes / total) * 100).toFixed(1);
        const color = LINGUIST_COLORS[lang] || '#999999';
        return `<div class="mt-1"><span class="lang-dot" style="background:${color}"></span>${lang} ${pct}%</div>`;
      }).join('');
    }
  }
}
refreshRepoMetadata();

let heliaNode = null;
let heliaStrings = null;
let heliaUnixfs = null;
let heliaCar = null;
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
const multiaddrsListEl = document.getElementById('multiaddrs-list');
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
const carDownloadBtn = document.getElementById('btn-clone-car');
const cloneCidCopyBtn = document.getElementById('btn-clone-cid-copy');
const cloneStatus = document.getElementById('clone-status');
const codeBtn = document.getElementById('btn-code');
const codeDropdown = document.getElementById('code-dropdown');
const codeShareField = document.getElementById('code-share-field');
const codeMultiaddrField = document.getElementById('code-multiaddr-field');
const codeCopyLinkBtn = document.getElementById('btn-code-copy-link');
const codeCopyMultiaddrBtn = document.getElementById('btn-code-copy-multiaddr');
const remotePinBtn = document.getElementById('btn-remote-pin');
const remotePinStatus = document.getElementById('remote-pin-status');
const remotePinEndpointInput = document.getElementById('remote-pin-endpoint');
const remotePinTokenInput = document.getElementById('remote-pin-token');
const remotePinSaveBtn = document.getElementById('btn-remote-pin-save');
const REMOTE_PIN_CFG_KEY = 'remote-pin-config';
const REMOTE_PIN_LAST_KEY = 'remote-pin-last';

function loadRemotePinConfig() {
  try { return JSON.parse(localStorage.getItem(REMOTE_PIN_CFG_KEY) || '{}'); } catch { return {}; }
}

function setRemotePinStatus(msg) {
  if (remotePinStatus) remotePinStatus.textContent = msg;
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
    selectedFileEl.style.backgroundColor = 'var(--color-accent-subtle)';
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
      path: childPath,
      isDir: child.isDir,
      cid: repoTreeCids.get(childPath) || null,
      size: repoTreeSizes.get(childPath) ?? null,
      children: child.isDir ? repoTreeNodes(child, childPath) : null
    };
  });
}

const FOLDER_SVG = '<svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h8.5A1.75 1.75 0 0 0 12 13.25v-8.5A1.75 1.75 0 0 0 10.25 3H7.547a.25.25 0 0 1-.186-.083l-.667-.77A1.75 1.75 0 0 0 5.279 1.5H1.75Z"></path></svg>';
const SUBMODULE_SVG = '<svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h8.5A1.75 1.75 0 0 0 12 13.25v-8.5A1.75 1.75 0 0 0 10.25 3H7.547a.25.25 0 0 1-.186-.083l-.667-.77A1.75 1.75 0 0 0 5.279 1.5H1.75Zm.75 3.5v7h7v-7h-7Z"></path></svg>';
const FILE_SVG = '<svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914Z"></path></svg>';

// GitHub-style repo file listing: rows of Name | CID | Size, directories
// expand in place. Kept as ul/li so the CDP tests keep working.
// GitHub-style file detail (blob) view for repo files. Name click in the
// listing drills in; the repo breadcrumb goes back to the tree.
const BLOB_KEYWORDS = {
  js: '\\b(?:const|let|var|function|return|if|else|for|while|do|class|extends|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|true|false|null|undefined|void|delete|yield|switch|case|break|continue)\\b',
  json: '\\b(?:true|false|null)\\b',
  sh: '\\b(?:if|then|else|fi|for|in|do|done|case|esac|function|return|local|echo|cd|export|source)\\b'
};
const BLOB_LANG = (path) => {
  const ext = path.split('.').pop().toLowerCase();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'js';
  if (['json'].includes(ext)) return 'json';
  if (['yml', 'yaml'].includes(ext)) return 'yml';
  if (['toml'].includes(ext)) return 'ini';
  if (['sh', 'bash'].includes(ext)) return 'sh';
  if (['html', 'xml', 'svg'].includes(ext)) return 'html';
  return 'plain';
};

function highlightBlobLine(escapedLine, lang) {
  let out = escapedLine;
  const comment = lang === 'sh' || lang === 'yml' || lang === 'ini' ? '(#[^&]*?$)' : null;
  const patterns = [];
  if (lang === 'js' || lang === 'sh') patterns.push(['(//[^&]*?$)', 'tok-com']);
  if (comment) patterns.push([comment, 'tok-com']);
  patterns.push([
    lang === 'html'
      ? '(&lt;!--[\\s\\S]*?--&gt;|&lt;\\/?[a-zA-Z][^&]*?&gt;)'
      : '(&#39;(?:[^&]|&(?!#39;))*?&#39;|&quot;(?:[^&]|&(?!quot;))*?&quot;|\\\\`(?:[^&]|&(?!`))*?`)',
    lang === 'html' ? 'tok-tag' : 'tok-str'
  ]);
  if (BLOB_KEYWORDS[lang]) patterns.push(['(' + BLOB_KEYWORDS[lang] + ')', 'tok-kw']);
  patterns.push(['(\\b\\d+(?:\\.\\d+)?\\b)', 'tok-num']);
  const combined = new RegExp(patterns.map(([re]) => re).join('|'), 'g');
  out = out.replace(combined, (...args) => {
    for (let i = 0; i < patterns.length; i++) {
      if (args[i + 1] !== undefined) return `<span class="${patterns[i][1]}">${args[i + 1]}</span>`;
    }
    return args[0];
  });
  return out;
}

const blobView = document.getElementById('blob-view');
const treeView = document.getElementById('tree-view');
let blobCurrentBytes = null;
let blobCurrentCid = null;
let blobCurrentPath = null;

// Expand the repo tree to a directory: reveal every ancestor nested list
// so the target row is visible, then scroll to it and flash it. Folded
// chains (".github/workflows" as one row) match by prefix.
function expandTreeTo(dirPath) {
  if (!fileTreeEl) return;
  const rows = [...fileTreeEl.querySelectorAll('li.row[data-path]')];
  const target = rows.find((li) => li.dataset.path === dirPath)
    || rows.find((li) => li.dataset.path.startsWith(dirPath + '/'));
  if (!target) return;
  let el = target;
  while (el && el !== fileTreeEl) {
    if (el.classList && el.classList.contains('nested')) el.hidden = false;
    el = el.parentElement;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const nameEl = target.querySelector('.cell-name');
  if (nameEl) {
    nameEl.style.backgroundColor = 'var(--color-accent-subtle)';
    setTimeout(() => { nameEl.style.backgroundColor = ''; }, 1200);
  }
}

async function showFileBlob(path) {
  if (!blobView || !treeView || !hasRepoFile(path)) return;
  const bytes = await repoBytes(path);
  if (!bytes) return;
  const text = new TextDecoder().decode(bytes);
  blobCurrentBytes = bytes;
  blobCurrentCid = repoTreeCids.get(path) || null;
  blobCurrentPath = path;

  const repoLink = document.getElementById('blob-repo-link');
  repoLink.textContent = repoName;
  const pathEl = document.getElementById('blob-path');
  // Breadcrumb: every directory segment links to its place in the tree
  // (GitHub-style); the file name stays plain text.
  pathEl.innerHTML = '';
  const parts = path.split('/');
  parts.forEach((part, i) => {
    const isFile = i === parts.length - 1;
    const segPath = parts.slice(0, i + 1).join('/');
    if (isFile) {
      const span = document.createElement('span');
      span.textContent = ` / ${part}`;
      pathEl.appendChild(span);
      return;
    }
    const a = document.createElement('a');
    a.href = '#/code'; // the tree endpoint; the click also expands the folder
    a.textContent = ` / ${part}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      hideFileBlob();
      expandTreeTo(segPath);
    });
    pathEl.appendChild(a);
  });
  document.getElementById('blob-meta').textContent = `${formatSize(bytes.length)}`;

  const codeEl = document.getElementById('blob-code');
  codeEl.innerHTML = '';
  const lang = BLOB_LANG(path);
  if (lang === 'md') {
    const article = document.createElement('article');
    article.className = 'readme-body';
    article.style.padding = '1rem';
    const dir = path.split('/').slice(0, -1).join('/');
    renderMarkdownInto(article, text, { mdDir: dir });
    codeEl.appendChild(article);
  } else {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
    const lines = text.replace(/\n$/, '').split('\n');
    lines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'line';
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = i + 1;
      const lc = document.createElement('span');
      lc.className = 'lc';
      lc.innerHTML = lang === 'plain' ? esc(line) || ' ' : highlightBlobLine(esc(line), lang) || ' ';
      row.appendChild(ln);
      row.appendChild(lc);
      codeEl.appendChild(row);
    });
  }

  treeView.hidden = true;
  blobView.hidden = false;
  resetLineCommentUi();
  renderLineGutter();
  blobView.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideFileBlob() {
  if (blobView) blobView.hidden = true;
  if (treeView) treeView.hidden = false;
  blobCurrentBytes = null;
  blobCurrentCid = null;
  blobCurrentPath = null;
  resetLineCommentUi();
}

const blobRepoLink = document.getElementById('blob-repo-link');
if (blobRepoLink) {
  blobRepoLink.addEventListener('click', (e) => {
    e.preventDefault();
    hideFileBlob();
  });
}
const blobRawBtn = document.getElementById('btn-blob-raw');
if (blobRawBtn) {
  blobRawBtn.addEventListener('click', () => {
    if (!blobCurrentBytes) return;
    // Named download: browsers show/save bare blob URLs as "Unknown", so
    // save under the file's CID instead.
    const url = URL.createObjectURL(new Blob([blobCurrentBytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = blobCurrentCid || 'raw';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}
const blobCopyBtn = document.getElementById('btn-blob-copy');
if (blobCopyBtn) {
  blobCopyBtn.addEventListener('click', async () => {
    if (!blobCurrentBytes) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(blobCurrentBytes));
      blobCopyBtn.textContent = 'Copied!';
      setTimeout(() => { blobCopyBtn.textContent = 'Copy raw file'; }, 1500);
    } catch (e) {}
  });
}
const blobDownloadBtn = document.getElementById('btn-blob-download');
if (blobDownloadBtn) {
  blobDownloadBtn.addEventListener('click', () => {
    if (!blobCurrentBytes) return;
    const path = document.getElementById('blob-path').textContent.replace(/\s*\/\s*/g, '/').replace(/^\//, '').trim();
    downloadBytes(blobCurrentBytes, path.split('/').pop() || 'file');
  });
}

// ---- Line comments (docs/issues-car.md phase 9) --------------------------------
// Granular review on the blob view: select lines in the code, comment; the
// note is a signed `line-comment` anchored to this exact blob CID, so
// (cid, line) is an immutable coordinate — the CID pins the content the
// range was filed against. Gutter markers render from the local index;
// clicking one lists the file's fetched-and-verified comments below the code.

const LINE_COMMENTS_KEY = 'repo-line-comments';
const BLAME_COMMENTS_KEY = 'repo-blame-comments';
const lineBarEl = document.getElementById('line-comment-bar');
const lineBarBtn = document.getElementById('btn-line-comment-start');
const lineComposerEl = document.getElementById('line-comment-composer');
const linePanelEl = document.getElementById('line-comment-panel');
// The composer carries one pending comment: a line-comment range or a
// blame-comment coordinate (line + origin release root).
let pendingComment = null;

function loadLineCommentIndex() {
  try { return JSON.parse(localStorage.getItem(LINE_COMMENTS_KEY) || '{}'); } catch { return {}; }
}

function saveLineCommentIndex(index) {
  try { localStorage.setItem(LINE_COMMENTS_KEY, JSON.stringify(index)); } catch {}
}

function blobLineRows() {
  const codeEl = document.getElementById('blob-code');
  return codeEl ? Array.from(codeEl.querySelectorAll('.line')) : [];
}

// Selection → 1-based line range; null unless both ends sit inside the
// rendered code (selecting page chrome must not offer a line comment).
function currentBlobSelectionRange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const codeEl = document.getElementById('blob-code');
  if (!codeEl || !blobView || blobView.hidden) return null;
  const { anchorNode, focusNode } = sel;
  if (!anchorNode || !focusNode || !codeEl.contains(anchorNode) || !codeEl.contains(focusNode)) return null;
  const rowOf = (node) => {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== codeEl) {
      if (el.classList && el.classList.contains('line')) return el;
      el = el.parentElement;
    }
    return null;
  };
  const rows = blobLineRows();
  const ai = rows.indexOf(rowOf(anchorNode));
  const fi = rows.indexOf(rowOf(focusNode));
  if (ai < 0 || fi < 0) return null;
  return normalizeLineRange(ai + 1, fi + 1);
}

function hideLineBar() {
  if (lineBarEl) lineBarEl.hidden = true;
}

// Floating "Comment on lines X–Y" action pinned above the selection's last
// line; hidden again whenever the selection collapses or the view scrolls.
function updateLineBar() {
  if (!lineBarEl || !blobView || blobView.hidden) return;
  const range = currentBlobSelectionRange();
  const rows = blobLineRows();
  const row = range ? rows[range.end - 1] : null;
  if (!range || !row) {
    hideLineBar();
    return;
  }
  lineBarBtn.textContent = `💬 Comment on lines ${range.start}–${range.end}`;
  const rect = row.getBoundingClientRect();
  lineBarEl.style.top = `${Math.max(6, rect.top - 42)}px`;
  lineBarEl.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - 300))}px`;
  lineBarEl.hidden = false;
}

document.addEventListener('selectionchange', updateLineBar);
window.addEventListener('scroll', hideLineBar, { passive: true });
window.addEventListener('resize', hideLineBar);

if (lineBarBtn) {
  lineBarBtn.addEventListener('click', () => {
    const range = currentBlobSelectionRange();
    if (!range) return;
    pendingComment = { kind: 'line', range };
    hideLineBar();
    window.getSelection()?.removeAllRanges();
    openLineComposer();
  });
}

function openLineComposer() {
  if (!lineComposerEl || !pendingComment) return;
  const heading = document.getElementById('line-comment-heading');
  const path = (document.getElementById('blob-path')?.textContent || '').trim();
  if (heading) {
    if (pendingComment.kind === 'blame') {
      const originTimestamp = pendingComment.originTimestamp ? ` · ${pendingComment.originTimestamp}` : '';
      heading.textContent = `Blame comment on ${path || '(file)'} line ${pendingComment.line} — originates in ${pendingComment.origin}${originTimestamp} · rides this line across later versions`;
    } else {
      heading.textContent = `Commenting on ${path || '(file)'} — lines ${pendingComment.range.start}–${pendingComment.range.end}, anchored to ${blobCurrentCid}`;
    }
  }
  const bodyEl = document.getElementById('line-comment-body');
  if (bodyEl) bodyEl.value = '';
  const statusEl = document.getElementById('line-comment-status');
  if (statusEl) statusEl.textContent = '';
  lineComposerEl.hidden = false;
  bodyEl?.focus();
}

function hideLineComposer() {
  pendingComment = null;
  if (lineComposerEl) lineComposerEl.hidden = true;
}

// Gutter: tint annotated rows and drop a marker (with count) in the line
// number cell. The marker pairs glyph+count with the tint so the meaning
// never rides on color alone.
function renderLineGutter() {
  const rows = blobLineRows();
  rows.forEach((row) => {
    row.classList.remove('line-commented');
    row.querySelectorAll('.ln-marker').forEach((m) => m.remove());
  });
  if (!blobCurrentCid) return;
  const stored = loadLineCommentIndex()[blobCurrentCid] || [];
  if (!stored.length) return;
  const byLine = commentsByLine(stored);
  rows.forEach((row, i) => {
    const list = byLine.get(i + 1);
    if (!list) return;
    row.classList.add('line-commented');
    const ln = row.querySelector('.ln');
    if (!ln) return;
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'ln-marker';
    marker.textContent = list.length > 1 ? `💬${list.length}` : '💬';
    const label = `${list.length} comment(s) on line ${i + 1}`;
    marker.title = label;
    marker.setAttribute('aria-label', label);
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      openLineCommentPanel(i + 1);
    });
    ln.appendChild(marker);
  });
  renderBlameGutter();
}

// Fetch + verify one comment note for the panel; a valid signature on a
// malformed note still must not render as a line comment.
async function renderLineCommentBody(item, holder) {
  if (!heliaNode) {
    holder.textContent = 'Node offline — cannot fetch this comment.';
    return;
  }
  try {
    const note = await getDagJson(CID.parse(item.cid));
    const { ok, signed, signer } = await verifyNote(note);
    if (!ok || !isLineCommentNote(signed)) {
      holder.style.color = 'var(--fgColor-danger, #cf222e)';
      holder.textContent = `✗ invalid note at ${item.cid}`;
      return;
    }
    holder.textContent = '';
    const meta = document.createElement('div');
    meta.className = 'f6 color-fg-muted';
    meta.style.wordBreak = 'break-all';
    meta.textContent = `✓ ${signer} · ${signed.timestamp} · ${item.cid}`;
    const body = document.createElement('div');
    body.textContent = signed.body;
    const pin = document.createElement('pre');
    pin.style.margin = '0.15rem 0 0 0';
    const code = document.createElement('code');
    code.textContent = `ipfs pin add ${item.cid}`;
    pin.appendChild(code);
    holder.appendChild(meta);
    holder.appendChild(body);
    holder.appendChild(pin);
  } catch {
    holder.textContent = `${item.cid} — unavailable (no provider)`;
  }
}

// The file's line comments, newest-indexed first, each jumping to its
// range on click/Enter.
function openLineCommentPanel() {
  if (!linePanelEl || !blobCurrentCid) return;
  const stored = (loadLineCommentIndex()[blobCurrentCid] || []).slice()
    .sort((a, b) => (a.start - b.start) || String(a.cid).localeCompare(String(b.cid)));
  if (!stored.length) {
    linePanelEl.hidden = true;
    return;
  }
  linePanelEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'line-comment-panel-head';
  head.textContent = `Line comments on this file (${stored.length}) — anchored to ${blobCurrentCid}`;
  linePanelEl.appendChild(head);
  for (const item of stored) {
    const range = normalizeLineRange(item.start, item.end);
    const row = document.createElement('div');
    row.className = 'line-comment-item';
    row.tabIndex = 0;
    const chip = document.createElement('span');
    chip.className = 'line-comment-chip';
    chip.textContent = range.start === range.end ? `L${range.start}` : `L${range.start}–L${range.end}`;
    const holder = document.createElement('div');
    holder.className = 'f6 color-fg-muted';
    holder.style.flex = '1';
    holder.style.wordBreak = 'break-all';
    holder.textContent = 'Fetching…';
    row.appendChild(chip);
    row.appendChild(holder);
    const jump = () => {
      const rows = blobLineRows();
      rows.forEach((r, i) => r.classList.toggle('line-flash', i + 1 >= range.start && i + 1 <= range.end));
      rows[range.start - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => rows.forEach((r) => r.classList.remove('line-flash')), 1600);
    };
    row.addEventListener('click', jump);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        jump();
      }
    });
    linePanelEl.appendChild(row);
    renderLineCommentBody(item, holder);
  }
  linePanelEl.hidden = false;
}

async function createLineComment() {
  if (pendingComment?.kind === 'blame') return createBlameComment();
  const statusEl = document.getElementById('line-comment-status');
  const bodyEl = document.getElementById('line-comment-body');
  const btn = document.getElementById('btn-line-comment-submit');
  if (!blobCurrentCid || pendingComment?.kind !== 'line') {
    if (statusEl) statusEl.textContent = 'Select a line range in the code first.';
    return;
  }
  const fields = makeLineCommentFields({
    fileCid: blobCurrentCid,
    start: pendingComment.range.start,
    end: pendingComment.range.end,
    body: bodyEl?.value,
    timestamp: new Date().toISOString()
  });
  if (!fields) {
    if (statusEl) statusEl.textContent = 'Write a comment first.';
    return;
  }
  if (!heliaNode) {
    if (statusEl) statusEl.textContent = 'Wait for the node to come online.';
    return;
  }
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Signing and publishing…';
  try {
    const { envelope, signer } = await signNote(fields);
    const cid = await publishNote(envelope);
    const index = loadLineCommentIndex();
    (index[blobCurrentCid] = index[blobCurrentCid] || []).unshift({
      cid, start: fields.line.start, end: fields.line.end, timestamp: fields.timestamp, signer
    });
    saveLineCommentIndex(index);
    await extendChain([cid]);
    if (statusEl) statusEl.textContent = `Commented — ${cid}`;
    if (bodyEl) bodyEl.value = '';
    renderLineGutter();
    openLineCommentPanel();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// A blame comment anchors to the ORIGIN of a line (its release root), not
// the version — { ns:'review', type:'blame-comment', anchors:[fileCid],
// line:{start}, origin }. It surfaces on every later version whose blame
// attributes that line to the same origin (blameCommentMatches).
async function createBlameComment() {
  const statusEl = document.getElementById('line-comment-status');
  const bodyEl = document.getElementById('line-comment-body');
  const btn = document.getElementById('btn-line-comment-submit');
  const pending = pendingComment;
  const body = (bodyEl?.value || '').trim();
  if (!blobCurrentCid || pending?.kind !== 'blame' || !pending.origin || !body) {
    if (statusEl) statusEl.textContent = 'Write a comment first.';
    return;
  }
  if (!heliaNode) {
    if (statusEl) statusEl.textContent = 'Wait for the node to come online.';
    return;
  }
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Signing and publishing…';
  try {
    const { envelope, signer } = await signNote({
      ns: 'review',
      type: 'blame-comment',
      anchors: [blobCurrentCid],
      line: { start: pending.line },
      origin: pending.origin,
      body,
      timestamp: new Date().toISOString()
    });
    const cid = await publishNote(envelope);
    const list = loadBlameCommentIndex();
    list.unshift({
      cid, anchor: blobCurrentCid, line: pending.line, origin: pending.origin,
      timestamp: envelope.timestamp, signer
    });
    saveBlameCommentIndex(list);
    await extendChain([cid]);
    if (statusEl) statusEl.textContent = `Commented — ${cid}`;
    if (bodyEl) bodyEl.value = '';
    renderBlameGutter();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- Blame (docs/issues-car.md phase 11) ---------------------------------------
// The Blame toggle computes per-line origin attribution over the release
// chain and renders an origin column; every blame cell can carry a
// blame-comment, which rides the line's history across later versions.

const blameToggleBtn = document.getElementById('btn-blame-toggle');
let blameOn = false;
let blameOrigins = null; // array parallel to the file's lines, or null
let blameReleases = [];

function loadBlameCommentIndex() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BLAME_COMMENTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBlameCommentIndex(list) {
  try { localStorage.setItem(BLAME_COMMENTS_KEY, JSON.stringify(list.slice(0, 500))); } catch {}
}

// The release chain for THIS checkout: local tips (recorded at publish
// time), newest first. Fetched-repo roots have no chain here — history
// before the chain exists attributes to the current root, the genesis
// release (same as git blame at a root commit: earlier content is
// unattributable).
function loadBlameReleases() {
  const currentRoot = outputCid?.textContent?.trim();
  const releases = collectReleases(loadReleaseTips());
  if (currentRoot && !releases.some((r) => r.root === currentRoot)) {
    return [{ cid: null, root: currentRoot, timestamp: null }, ...releases];
  }
  return releases;
}

// File lines at a path under a release root; null when absent/unfetchable.
async function blameFileLines(root) {
  if (!heliaUnixfs || !blobCurrentPath || !root) return null;
  try {
    const stat = await heliaUnixfs.stat(CID.parse(root), { path: blobCurrentPath });
    if (stat.type === 'directory') return null;
    const chunks = [];
    for await (const chunk of heliaUnixfs.cat(stat.cid)) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes).replace(/\n$/, '').split('\n');
  } catch {
    return null;
  }
}

async function computeBlame() {
  const codeEl = document.getElementById('blob-code');
  if (!codeEl) return;
  blameReleases = loadBlameReleases();
  // The file's true lines, exactly as published (the rendered rows use a
  // ' ' placeholder for empty lines, which would never match a release's
  // empty string).
  const currentText = new TextDecoder().decode(blobCurrentBytes || new Uint8Array());
  const currentLines = currentText.replace(/\n$/, '').split('\n');
  if (!currentLines.length) return;
  // Doc optimization: a file whose CID is unchanged between consecutive
  // roots has identical content, so keep the last fetched lines instead of
  // refetching.
  let lastFileCid = null;
  let lastLines = null;
  const fetchFileLines = async (root) => {
    const stat = await heliaUnixfs.stat(CID.parse(root), { path: blobCurrentPath });
    if (stat.type === 'directory') return null;
    const fileCid = stat.cid.toString();
    if (fileCid === lastFileCid && lastLines) return lastLines;
    const chunks = [];
    for await (const chunk of heliaUnixfs.cat(stat.cid)) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    lastFileCid = fileCid;
    lastLines = new TextDecoder().decode(bytes).replace(/\n$/, '').split('\n');
    return lastLines;
  };
  blameOrigins = await blameLines(currentLines, blameReleases, fetchFileLines);
}

function renderBlameGutter() {
  blobLineRows().forEach((row) => {
    row.querySelectorAll('.bl').forEach((el) => el.remove());
  });
  if (!blameOn || !blameOrigins) return;
  const comments = loadBlameCommentIndex();
  blobLineRows().forEach((row, i) => {
    const origin = blameOrigins[i];
    if (!origin) return;
    const bl = document.createElement('button');
    bl.type = 'button';
    bl.className = 'bl';
    const count = comments.filter((c) => blameCommentMatches(c, origin.root, i + 1)).length;
    bl.textContent = `${origin.timestamp || 'release'}${count > 0 ? ` 💬${count}` : ' ＋'}`;
    bl.title = `Line ${i + 1} originates in release ${origin.root} — click to comment on this origin`;
    bl.setAttribute('aria-label', bl.title);
    bl.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingComment = { kind: 'blame', line: i + 1, origin: origin.root, originTimestamp: origin.timestamp };
      openLineComposer();
    });
    row.insertBefore(bl, row.querySelector('.lc'));
  });
}

async function toggleBlame() {
  if (!blobView || blobView.hidden) return;
  blameOn = !blameOn;
  if (blameToggleBtn) blameToggleBtn.setAttribute('aria-pressed', String(blameOn));
  const codeEl = document.getElementById('blob-code');
  if (codeEl) codeEl.classList.toggle('blame-on', blameOn);
  if (blameOn) {
    if (blameToggleBtn) blameToggleBtn.disabled = true;
    try {
      await computeBlame();
    } finally {
      if (blameToggleBtn) blameToggleBtn.disabled = false;
    }
  } else {
    blameOrigins = null;
  }
  renderBlameGutter();
}

if (blameToggleBtn) {
  blameToggleBtn.setAttribute('aria-pressed', 'false');
  blameToggleBtn.addEventListener('click', toggleBlame);
}

const lineSubmitBtn = document.getElementById('btn-line-comment-submit');
if (lineSubmitBtn) lineSubmitBtn.addEventListener('click', createLineComment);
const lineCancelBtn = document.getElementById('btn-line-comment-cancel');
if (lineCancelBtn) lineCancelBtn.addEventListener('click', hideLineComposer);

function resetLineCommentUi() {
  hideLineBar();
  hideLineComposer();
  if (linePanelEl) linePanelEl.hidden = true;
  blameOn = false;
  blameOrigins = null;
  blameReleases = [];
  if (blameToggleBtn) blameToggleBtn.setAttribute('aria-pressed', 'false');
}

// Export a CID (and its full DAG) as CAR bytes. CarWriter streams block
// chunks through an async iterable; collect them into one buffer.
async function exportCarBytes(rootCid) {
  const { writer, out } = await CarWriter.create([rootCid]);
  const chunks = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await heliaCar.export(rootCid, writer);
  await collect;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// Publish tab: download the published content as a CAR.
const publishCarBtn = document.getElementById('btn-publish-car');
if (publishCarBtn) {
  publishCarBtn.addEventListener('click', async () => {
    const published = document.getElementById('output-cid')?.dataset.published
      ? document.getElementById('output-cid').textContent.trim()
      : null;
    if (!published || !heliaCar) return;
    publishCarBtn.disabled = true;
    try {
      const bytes = await exportCarBytes(CID.parse(published));
      downloadBytes(bytes, `${published}.car`);
    } finally {
      publishCarBtn.disabled = false;
    }
  });
}

// Download CAR: export the whole repo (exact root CID) as a CAR archive.
if (carDownloadBtn) {
  carDownloadBtn.addEventListener('click', async () => {
    const rootCid = outputCid.textContent.trim();
    if (!rootCid || rootCid === 'None' || !heliaCar) return;
    carDownloadBtn.disabled = true;
    if (cloneStatus) {
      cloneStatus.style.color = 'var(--color-success-fg)';
      cloneStatus.textContent = 'Building CAR...';
    }
    try {
      const bytes = await exportCarBytes(CID.parse(rootCid));
      downloadBytes(bytes, `${rootCid}.car`);
      if (cloneStatus) cloneStatus.textContent = `Downloaded ${rootCid}.car (${formatSize(bytes.length)})`;
    } catch (err) {
      if (cloneStatus) {
        cloneStatus.style.color = 'var(--color-danger-fg)';
        cloneStatus.textContent = `CAR export failed: ${err.message}`;
      }
    } finally {
      carDownloadBtn.disabled = false;
    }
  });
}

function renderRepoTable(nodes, depth = 0) {
  const ul = document.createElement('ul');
  ul.className = 'repo-table' + (depth > 0 ? ' nested' : '');
  const sorted = [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sorted) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.path = node.path;

    const cells = document.createElement('div');
    cells.className = 'cells';

    const nameCell = document.createElement('span');
    nameCell.className = 'cell-name';
    const sub = repoSubmodules[node.path];
    nameCell.innerHTML = (sub ? SUBMODULE_SVG : node.isDir ? FOLDER_SVG : FILE_SVG) + '<span></span>';
    nameCell.querySelector('span').textContent = node.name;
    if (sub) {
      nameCell.title = 'Submodule — click to expand the contents embedded from this checkout';
      // GitHub marks submodules with @<short gitlink> right after the name.
      const ref = document.createElement('a');
      ref.className = 'submodule-ref';
      ref.href = sub.url || '#';
      ref.target = '_blank';
      ref.rel = 'noopener';
      ref.textContent = '@' + sub.sha.slice(0, 7);
      ref.title = `Submodule at ${sub.sha}${sub.url ? ' — ' + sub.url : ''}`;
      nameCell.appendChild(ref);
    }

    const cidCell = document.createElement('span');
    cidCell.className = 'cell-cid';
    cidCell.textContent = node.cid || '';
    cidCell.title = node.isDir ? 'Click to reveal the files inside this directory' : 'Click to select this CID';
    cidCell.addEventListener('click', (e) => {
      e.stopPropagation();
      if (node.isDir) {
        const childUl = li.querySelector(':scope > ul.nested');
        if (childUl) childUl.hidden = !childUl.hidden;
      } else if (node.cid) {
        selectFile(node.cid, node.name, cidCell);
      }
    });

    const sizeCell = document.createElement('span');
    sizeCell.className = 'cell-size';
    sizeCell.textContent = !node.isDir && node.size != null && Number(node.size) > 0 ? formatSize(node.size) : '';

    cells.appendChild(nameCell);
    cells.appendChild(cidCell);
    cells.appendChild(sizeCell);
    li.appendChild(cells);

    if (node.isDir && node.children && node.children.length > 0) {
      const childUl = renderRepoTable(node.children, depth + 1);
      childUl.hidden = true;
      li.appendChild(childUl);
      nameCell.addEventListener('click', () => {
        childUl.hidden = !childUl.hidden;
      });
    } else if (!node.isDir) {
      nameCell.addEventListener('click', () => showFileBlob(node.path));
    }
    ul.appendChild(li);
  }
  return ul;
}

// GitHub folds directory chains where each level holds a single
// subdirectory: ".github" containing only "workflows" renders as one
// ".github/workflows" row. Applied at every level.
function foldRepoNodes(nodes) {
  return nodes.map((node) => {
    // A submodule root must stay its own row — folding it into a chained
    // path would hide the gitlink marker GitHub shows.
    if (node.isDir && !repoSubmodules[node.path] && node.children && node.children.length === 1 && node.children[0].isDir) {
      const child = node.children[0];
      const merged = { ...node, name: `${node.name}/${child.name}`, path: child.path, children: child.children };
      return foldRepoNodes([merged])[0];
    }
    if (node.isDir && node.children) {
      return { ...node, children: foldRepoNodes(node.children) };
    }
    return node;
  });
}

function renderRepoTree() {
  if (!fileTreeEl) return;
  fileTreeEl.innerHTML = '';
  const tree = buildRepoTree(repoPaths());
  fileTreeEl.appendChild(renderRepoTable(foldRepoNodes(repoTreeNodes(tree, ''))));
}

// GitHub-like markdown (docs/markdown-rendering.md): marked (GFM) →
// DOMPurify (no scripts/handlers/style/SVG/MathML — SVG renders via <img>
// only) → rewrite pass. Repo-relative images come from the embedded
// bundle as data: URLs (script-inert in <img> context); remote images go
// through the rehost service (fetch-once → content-addressed URL); when no
// service answers they fall back to direct load (js/markdown.js) — a
// blocked image is a broken page.
const EMBED_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp'
};
async function embedDataUrl(path) {
  const mime = EMBED_MIME[path.split('.').pop().toLowerCase()];
  if (!mime || !hasRepoFile(path)) return null;
  if (repoMode !== 'car') {
    const b64 = repoFiles[path];
    return b64 ? `data:${mime};base64,${b64}` : null;
  }
  const bytes = await repoBytes(path);
  return bytes ? `data:${mime};base64,${uint8ArrayToBase64(bytes)}` : null;
}

const REHOST_ENDPOINT_KEY = 'rehost-endpoint';
function rehostEndpoint() {
  try { return localStorage.getItem(REHOST_ENDPOINT_KEY) || 'http://127.0.0.1:8081'; } catch { return 'http://127.0.0.1:8081'; }
}
async function rehostRemoteImage(url) {
  const out = await rehostAndRewrite(url, { endpoint: rehostEndpoint() });
  if (out && out.cid) recordRehost(url, out.cid).catch(() => {}); // chain record, fire-and-forget
  return out;
}

function renderMarkdownInto(el, src, { mdDir = '' } = {}) {
  el.innerHTML = sanitizeMarkdownHtml(src);
  el.dataset.mdDir = mdDir;
  rewriteRendered(el, {
    onEmbed: embedDataUrl,
    rehost: rehostRemoteImage,
    onRepoLink: (path) => {
      activateTab('files');
      showFileBlob(path);
    }
  });
}

async function renderReadme() {
  const card = document.getElementById('readme-card');
  const body = document.getElementById('readme-content');
  if (!card || !body || !hasRepoFile('README.md')) return;
  try {
    const bytes = await repoBytes('README.md');
    if (!bytes) return;
    const text = new TextDecoder().decode(bytes);
    renderMarkdownInto(body, text);
    card.style.display = 'block';
  } catch (e) {
    // No README render — leave the card hidden.
  }
}

// IPNS branch pointer: publish the current repo root CID under a
// browser-held Ed25519 key, so `/ipns/<peerId>` tracks HEAD like a branch
// ref while the page is open. The key's raw bytes persist in localStorage
// per repo, so refreshes keep the same name.
let ipnsBranchKeyPromise = null;
let ipnsBranchCid = null;
let ipnsBranchLastPublish = 0;
let ipnsBranchName = '';

// Signed dag-json metadata (the GitHub "signed commit" equivalent): an
// envelope {cid, name, timestamp, signer, signature, publicKey} stored as a
// dag-json block. The signature covers the dag-json encoding of the first
// five fields; verification re-encodes and checks with the embedded key.
async function addDagJson(obj) {
  const bytes = dagJson.encode(obj);
  const cid = CID.create(1, dagJson.code, await sha256.digest(bytes));
  await heliaNode.blockstore.put(cid, bytes);
  return cid;
}

async function getDagJson(cid) {
  const bytes = await heliaNode.blockstore.get(cid);
  return dagJson.decode(bytes);
}

async function signPublished() {
  const publishedEl = document.getElementById('output-cid');
  const cid = publishedEl?.dataset.published ? publishedEl.textContent.trim() : null;
  const resultEl = document.getElementById('signed-metadata-cid');
  if (!cid) return;
  if (resultEl) resultEl.textContent = 'Signing…';
  try {
    const key = await getIpnsBranchKey();
    const signer = peerIdFromPrivateKey(key).toString();
    const signed = {
      cid,
      name: window.__lastPublishedSlug || 'published',
      timestamp: new Date().toISOString(),
      signer
    };
    const signature = await key.sign(dagJson.encode(signed));
    const envelope = {
      ...signed,
      signature: uint8ArrayToBase64(signature),
      publicKey: uint8ArrayToBase64(publicKeyToProtobuf(key.publicKey))
    };
    const metaCid = await addDagJson(envelope);
    heliaNode.routing?.provide?.(metaCid).catch(() => {});
    if (resultEl) resultEl.textContent = metaCid.toString();
  } catch (err) {
    if (resultEl) resultEl.textContent = `Sign failed: ${err.message}`;
  }
}

async function verifyMetadata() {
  const input = document.getElementById('verify-metadata-cid');
  const resultEl = document.getElementById('verify-metadata-result');
  const raw = (input?.value || '').trim();
  if (!resultEl) return;
  if (!raw) {
    resultEl.textContent = 'Paste a metadata CID first.';
    return;
  }
  resultEl.textContent = 'Fetching…';
  try {
    const envelope = await getDagJson(CID.parse(raw));
    const { signature, publicKey, ...signed } = envelope;
    const payload = dagJson.encode(signed);
    const pub = publicKeyFromProtobuf(base64ToUint8Array(publicKey));
    const signer = peerIdFromPublicKey(pub).toString();
    const ok = await pub.verify(payload, base64ToUint8Array(signature));
    resultEl.textContent = ok
      ? `✓ signed by ${signer}\n  payload ${signed.cid}\n  name ${signed.name}\n  at ${signed.timestamp}`
      : `✗ signature INVALID (claims signer ${signer})`;
  } catch (err) {
    resultEl.textContent = `Verify failed: ${err.message}`;
  }
}

// Repo chat (P9): signed dag-json envelopes over the repo gossip channel's
// :chat subtopic — the GitHub discussions/watch-activity equivalent. Every
// message is verified with the P7 envelope scheme; forgeries render marked.
const chatSeen = new Set();

async function renderChatMessage(data) {
  const listEl = document.getElementById('chat-list');
  if (!listEl) return;
  let envelope;
  try { envelope = dagJson.decode(data); } catch { return; }
  const { signature, publicKey, ...signed } = envelope;
  if (!signature || !publicKey || typeof signed.text !== 'string') return;
  const key = `${signed.signer}:${signed.timestamp}:${signed.text.slice(0, 32)}`;
  if (chatSeen.has(key)) return;
  chatSeen.add(key);
  let ok = false;
  let signer = signed.signer;
  try {
    const pub = publicKeyFromProtobuf(base64ToUint8Array(publicKey));
    signer = peerIdFromPublicKey(pub).toString();
    ok = await pub.verify(dagJson.encode(signed), base64ToUint8Array(signature));
  } catch {}
  const li = document.createElement('li');
  li.style.cssText = 'padding: 0.3rem 0; border-bottom: 1px solid var(--color-border-muted); word-break: break-word;';
  const meta = document.createElement('div');
  meta.className = 'f6';
  meta.style.color = ok ? 'var(--color-fg-muted)' : 'var(--fgColor-danger, #cf222e)';
  meta.textContent = `${ok ? '✓' : '✗ invalid signature'} ${signer} · ${signed.timestamp}`;
  const body = document.createElement('div');
  body.textContent = signed.text;
  li.appendChild(meta);
  li.appendChild(body);
  if (listEl.querySelector('.color-fg-muted')) listEl.innerHTML = '';
  listEl.prepend(li);
  while (listEl.children.length > 50) listEl.removeChild(listEl.lastChild);
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  const pubsub = heliaNode?.libp2p?.services?.pubsub;
  if (!pubsub) return;
  try {
    const key = await getIpnsBranchKey();
    const signer = peerIdFromPrivateKey(key).toString();
    const signed = { text, timestamp: new Date().toISOString(), signer };
    const signature = await key.sign(dagJson.encode(signed));
    const envelope = {
      ...signed,
      signature: uint8ArrayToBase64(signature),
      publicKey: uint8ArrayToBase64(publicKeyToProtobuf(key.publicKey))
    };
    const data = dagJson.encode(envelope);
    await pubsub.publish(`repo-gossip:${repoFullName}:chat`, data);
    if (input) input.value = '';
    // emitSelf is off — render our own post so the sender sees it immediately.
    await renderChatMessage(data);
  } catch {}
}

const chatSendBtn = document.getElementById('btn-chat-send');
if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);
const chatInput = document.getElementById('chat-input');
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });
}

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

// Interop probe (docs/interop.md): the rust app serves its bridge's
// identity bundle on the fixed loopback port 5050. Loopback fetch from an
// https page is not mixed-content-blocked, so the Pages deployment can
// reach it. Silent adopt when this origin has no key yet; when keys
// differ, expose the bundle as window.__pendingIdentityAdoption for the
// UI instead of deciding for the user.
async function probeInteropIdentity() {
  try {
    const res = await fetch('http://127.0.0.1:5050/well-known/identity');
    if (!res.ok) return;
    const bundle = await res.json();
    if (!bundle || typeof bundle.key !== 'string' || !bundle.key) return;
    const storageKey = `ipns-branch-key:${repoFullName}`;
    if (!localStorage.getItem(storageKey)) {
      localStorage.setItem(storageKey, bundle.key);
      ipnsBranchKeyPromise = null; // re-read on next getIpnsBranchKey()
      window.__identityAdopted = bundle.peerId || null;
      console.log(`interop: adopted local identity ${bundle.peerId}`);
      return;
    }
    if (bundle.peerId) {
      const localKey = await getIpnsBranchKey();
      if (peerIdFromPrivateKey(localKey).toString() !== bundle.peerId) {
        window.__pendingIdentityAdoption = bundle;
        console.log('interop: local identity differs; see window.__pendingIdentityAdoption');
      }
    }
  } catch {
    // no local rust app running — the normal case for most visitors
  }
}

async function publishBranchPointer(rootCid) {

  const field = document.getElementById('code-ipns-field');
  try {
    if (!heliaNode || !rootCid) return;
    const key = await getIpnsBranchKey();
    const peerId = peerIdFromPrivateKey(key);
    const ipnsName = `/ipns/${peerId}`;
    ipnsBranchCid = rootCid;
    ipnsBranchName = ipnsName;
    if (field) {
      field.value = ipnsName;
      field.dataset.ipns = ipnsName;
      field.title = 'IPNS branch pointer — tracks the repo root CID while this page is open. Click to select, then copy.';
    }
    await ipns(heliaNode).publish(key, rootCid);
    ipnsBranchLastPublish = Date.now();
    if (field) field.title = 'IPNS branch pointer published';
  } catch (err) {
    if (field) field.title = `IPNS publish failed: ${err.message} — the name above is still valid once a publisher is online`;
  }
}

// ---- Release chain (docs/issues-car.md phase 10) -------------------------------
// Every publish of a NEW repo root records a release-commit object
// { type:'release', root, prev, timestamp } — the git-commit analog the
// DAG was missing, and what blame (phase 11) walks. The object is plain
// dag-json (no signature — the data model keeps releases as history links;
// blame attribution is advisory). Dedup: publishing an unchanged tree
// yields the same root CID, so the chain only advances when content does.

const RELEASE_CHAIN_KEY = 'repo-release-chain';

function loadReleaseTips() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RELEASE_CHAIN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReleaseTips(tips) {
  try { localStorage.setItem(RELEASE_CHAIN_KEY, JSON.stringify(tips.slice(0, 50))); } catch {}
}

// Record `rootCidStr` as a release; no-op when it matches the current tip
// (same content republished). Returns the release record or null.
async function recordRelease(rootCidStr) {
  if (!heliaNode || !rootCidStr) return null;
  const tips = loadReleaseTips();
  if (tips[0] && tips[0].root === rootCidStr) return tips[0];
  const obj = {
    type: 'release',
    root: rootCidStr,
    prev: tips[0] ? tips[0].cid : null,
    timestamp: new Date().toISOString()
  };
  try {
    const cid = await addDagJson(obj);
    heliaNode.routing?.provide?.(cid).catch(() => {});
    const record = { cid: cid.toString(), root: rootCidStr, timestamp: obj.timestamp };
    saveReleaseTips([record, ...tips]);
    return record;
  } catch {
    return null;
  }
}

async function addAllRepoFiles() {
  if (!heliaUnixfs) return;

  if (repoMode === 'car') {
    // The root CID was already computed at build time over the same
    // virtual-flattened file set (scripts/build-car.mjs) — skip the
    // in-browser addAll entirely and stream bytes from repo.car instead.
    if (!repoCarRoot) return;
    const rootCid = CID.parse(repoCarRoot);
    outputCid.textContent = repoCarRoot;
    inputCid.value = repoCarRoot;
    rootCidForProvide = rootCid;
    if (cloneCidEl) {
      cloneCidEl.textContent = repoCarRoot;
      cloneCidEl.title = repoCarRoot;
    }
    if (cloneZipBtn) cloneZipBtn.disabled = false;
    if (carDownloadBtn) carDownloadBtn.disabled = false;
    if (fetchRepoBtn) fetchRepoBtn.disabled = false;
    if (downloadRepoBtn) downloadRepoBtn.disabled = false;
    publishBranchPointer(rootCid).catch(() => {});
    recordRelease(repoCarRoot).catch(() => {});
    statusEl.textContent = 'Online & loading repository CAR...';
    try {
      const size = await ensureRepoCar();
      statusEl.textContent = `Online & repository CAR loaded (${formatSize(size)})`;
    } catch (err) {
      statusEl.textContent = `Online & CAR load failed: ${err.message}`;
    }
    if (heliaNode && heliaNode.routing && typeof heliaNode.routing.provide === 'function') {
      heliaNode.routing.provide(rootCid).catch(() => {});
    }
    return;
  }

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
      if (carDownloadBtn) carDownloadBtn.disabled = false;
      if (fetchRepoBtn) fetchRepoBtn.disabled = false;
      if (downloadRepoBtn) downloadRepoBtn.disabled = false;
      publishBranchPointer(rootCid).catch(() => {});
      recordRelease(rootCidStr).catch(() => {});
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
    // Spawn an in-browser IPFS node. Extend helia's own libp2p defaults
    // with gossipsub for clone detection (a bare services key would
    // clobber the defaults — identify, dht, ping, etc.), and announce
    // ourselves on the repo topic so clones discover each other without
    // a share link.
    const lpDefaults = libp2pDefaults();
    const libp2p = await createLibp2p({
      ...lpDefaults,
      peerDiscovery: [
        ...lpDefaults.peerDiscovery,
        pubsubPeerDiscovery({ topics: [`repo-gossip:${repoFullName}`] })
      ],
      services: {
        ...lpDefaults.services,
        pubsub: gossipsub({ emitSelf: false })
      }
    });
    heliaNode = await createHelia({ libp2p });
    heliaStrings = strings(heliaNode);
    heliaUnixfs = unixfs(heliaNode);
    heliaCar = car(heliaNode);
    window.__heliaNode = heliaNode;

    // Enforce the persisted peer blocklist on every new connection,
    // inbound included: blocked peers are closed on sight.
    heliaNode.libp2p.addEventListener('connection:open', (evt) => {
      const id = evt.detail.remotePeer.toString();
      if (isBlockedPeer(id)) {
        evt.detail.close().catch(() => {});
      }
    });

    // Clone detection: every instance of this app subscribes to a gossip
    // topic named after the repo, so subscribers ARE clones (peers running
    // the same published app). Unknown deployments share the gnostr default.
    // The :chat subtopic carries signed repo chat between those same clones.
    const pubsub = heliaNode.libp2p.services?.pubsub;
    if (pubsub) {
      try {
        pubsub.subscribe(`repo-gossip:${repoFullName}`);
      } catch {}
      try {
        const chatTopic = `repo-gossip:${repoFullName}:chat`;
        pubsub.subscribe(chatTopic);
        pubsub.addEventListener('message', (evt) => {
          if (evt.detail.topic !== chatTopic) return;
          renderChatMessage(evt.detail.data).catch(() => {});
        });
      } catch {}
    }

    const peerId = heliaNode.libp2p.peerId.toString();

    // Interop (docs/interop.md): if the local rust app publishes an
    // identity on 127.0.0.1:5050, adopt it when we have no key yet, or
    // surface it for the UI when it differs from ours.
    probeInteropIdentity();

    statusEl.textContent = 'Online & Connected to Peer-to-Peer Network';
    peerIdEl.textContent = peerId;

    try {
      const addrs = heliaNode.libp2p.getMultiaddrs().map((a) => a.toString());
      multiaddrsListEl.textContent = addrs.length ? addrs.join(', ') : '(none - browser node)';
    } catch (e) {
      multiaddrsListEl.textContent = '(unavailable)';
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

    // Car mode: paths + CIDs must land before the tree renders; file
    // bytes stream from dist/repo.car on demand (see repoBytes).
    if (repoMode === 'car') {
      statusEl.textContent = 'Loading repository manifest...';
      await loadRepoManifest();
    }

    // Render the repository file tree immediately
    renderRepoTree();

    // Render the embedded README
    renderReadme();

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
    outputCid.dataset.published = '1';
    inputCid.value = cid.toString();
    window.__lastPublishedSlug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'published';
    const help = document.getElementById('publish-help');
    if (help) help.style.display = 'block';
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

// Ask the delegated routing endpoint (IPNI-backed) who provides this CID,
// then dial those providers. Lets a fetch succeed even when the original
// publisher is offline — anyone who announced the content can serve it.
// Returns the number of providers successfully dialed.
const DELEGATED_ROUTING_URL = 'https://delegated-ipfs.dev';
async function dialDelegatedProviders(cidStr, timeoutMs = 8000) {
  if (!heliaNode) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let providers;
  try {
    const res = await fetch(`${DELEGATED_ROUTING_URL}/routing/v1/providers/${cidStr}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) return 0;
    providers = (await res.json()).Providers || [];
  } catch (e) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
  let dialed = 0;
  for (const p of providers.slice(0, 5)) {
    const addr = (p.Addrs || [])[0];
    if (!addr || !p.ID) continue;
    const full = addr.endsWith(`/p2p/${p.ID}`) ? addr : `${addr}/p2p/${p.ID}`;
    try {
      await Promise.race([
        heliaNode.libp2p.dial(multiaddr(full)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dial timeout')), 8000))
      ]);
      dialed++;
    } catch (e) {
      // try next provider
    }
  }
  return dialed;
}

async function fetchContent(cidStr, nameHint, _retried = false) {
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
    // First fallback: ask delegated routing who provides this CID, dial
    // them, and retry the fetch once (publisher may be offline).
    if (!_retried) {
      try {
        outputContent.textContent = 'Looking up providers via delegated routing...';
        const dialed = await dialDelegatedProviders(cidStr);
        if (dialed > 0) {
          return fetchContent(cidStr, nameHint, true);
        }
      } catch (e) {
        // fall through to the strings fallback
      }
    }
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

// "Go to file": focus the fetch box and bring it into view.
const goToFileBtn = document.getElementById('btn-go-to-file');
if (goToFileBtn) {
  goToFileBtn.addEventListener('click', () => {
    inputCid.focus();
    inputCid.select();
    inputCid.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// Readme jump (the one inline handler, de-inlined for CSP script-src 'self').
const readmeJumpBtn = document.getElementById('btn-readme-jump');
if (readmeJumpBtn) {
  readmeJumpBtn.addEventListener('click', () => {
    document.getElementById('readme-card')?.scrollIntoView({ behavior: 'smooth' });
  });
}

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

// Code dropdown: toggle, tabs, copy buttons.
if (codeBtn && codeDropdown) {
  codeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Clicking Code while a file is open returns to the repo tree first,
    // the same way the breadcrumb repo link does.
    if (blobView && !blobView.hidden) hideFileBlob();
    const opening = codeDropdown.style.display === 'none';
    codeDropdown.style.display = opening ? 'block' : 'none';
    if (!opening) return;
    if (window.innerWidth <= 544) {
      // Narrow screens: pin below the button, spanning the viewport, so the
      // options are always on screen wherever the toolbar wrapped the button.
      const r = codeBtn.getBoundingClientRect();
      codeDropdown.style.position = 'fixed';
      codeDropdown.style.left = '0.5rem';
      codeDropdown.style.right = '0.5rem';
      codeDropdown.style.width = 'auto';
      codeDropdown.style.top = `${Math.round(r.bottom) + 4}px`;
      codeDropdown.style.maxHeight = `${Math.max(200, window.innerHeight - r.bottom - 12)}px`;
      codeDropdown.style.overflowY = 'auto';
    } else {
      codeDropdown.style.position = 'absolute';
      codeDropdown.style.left = 'auto';
      codeDropdown.style.right = '0';
      codeDropdown.style.width = 'min(380px, calc(100vw - 1rem))';
      codeDropdown.style.top = 'calc(100% + 4px)';
      codeDropdown.style.maxHeight = '';
      codeDropdown.style.overflowY = '';
    }
  });
  document.addEventListener('click', (e) => {
    if (codeDropdown.style.display !== 'none' && !codeDropdown.contains(e.target) && e.target !== codeBtn) {
      codeDropdown.style.display = 'none';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') codeDropdown.style.display = 'none';
  });
}

document.querySelectorAll('[data-codetab]').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.codetab;
    document.querySelectorAll('[data-codetab]').forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    document.getElementById('codetab-panel-link').style.display = tab === 'link' ? 'block' : 'none';
    document.getElementById('codetab-panel-multiaddr').style.display = tab === 'multiaddr' ? 'block' : 'none';
    document.getElementById('codetab-panel-ipns').style.display = tab === 'ipns' ? 'block' : 'none';
  });
});

async function copyToClipboard(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    if (cloneStatus) cloneStatus.textContent = okMsg;
  } catch (e) {
    if (cloneStatus) cloneStatus.textContent = 'Copy failed — select the field and copy manually.';
  }
}

if (codeCopyLinkBtn) {
  codeCopyLinkBtn.addEventListener('click', () => {
    const link = (codeShareField && codeShareField.value) || '';
    if (link) copyToClipboard(link, 'Copied share link to clipboard.');
  });
}
if (codeCopyMultiaddrBtn) {
  codeCopyMultiaddrBtn.addEventListener('click', () => {
    const ma = (codeMultiaddrField && codeMultiaddrField.value) || '';
    if (ma) copyToClipboard(ma, 'Copied multiaddr to clipboard.');
  });
}
if (codeShareField) {
  codeShareField.addEventListener('click', () => codeShareField.select());
  codeShareField.addEventListener('focus', () => codeShareField.select());
}
if (codeMultiaddrField) {
  codeMultiaddrField.addEventListener('click', () => codeMultiaddrField.select());
  codeMultiaddrField.addEventListener('focus', () => codeMultiaddrField.select());
}

// Remote pin (Pinning Services API) — the GitHub "star" equivalent: pin a
// CID to a remote pinning service so it outlives this tab. Shared by the
// repo-root button and the CID popover; config persists in localStorage
// only, the request follows the PSA spec.
async function remotePinCid(cid, name) {
  const cfg = loadRemotePinConfig();
  if (!cfg.endpoint || !cfg.token) {
    throw new Error('Set the endpoint + token first (Code tab, ☆ Remote pin settings).');
  }
  const origins = [];
  const ma = getShareableMultiaddr();
  if (ma) origins.push(ma);
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ cid, name, origins })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function remotePinRoot() {
  const root = cloneCidEl?.textContent.trim();
  if (!root || !root.startsWith('baf')) return;
  setRemotePinStatus('Pinning…');
  remotePinBtn.disabled = true;
  try {
    const pin = await remotePinCid(root, repoFullName);
    const cfg = loadRemotePinConfig();
    try {
      localStorage.setItem(REMOTE_PIN_LAST_KEY, JSON.stringify({ requestId: pin.requestId, cid: root, endpoint: cfg.endpoint, status: pin.status }));
    } catch {}
    setRemotePinStatus(`Pin ${pin.status}${pin.requestId ? ` (${pin.requestId})` : ''}`);
    remotePinBtn.textContent = '★ Pinned';
  } catch (err) {
    setRemotePinStatus(`Pin failed: ${err.message}`);
  } finally {
    remotePinBtn.disabled = false;
  }
}

// Restore the last pin's status (best effort — the service may want fresh auth).
(async () => {
  try {
    const last = JSON.parse(localStorage.getItem(REMOTE_PIN_LAST_KEY) || 'null');
    if (!last?.requestId || !last?.endpoint) return;
    const res = await fetch(`${last.endpoint.replace(/\/$/, '')}/${last.requestId}`, {
      headers: { Authorization: `Bearer ${loadRemotePinConfig().token || ''}` }
    });
    if (!res.ok) return;
    const pin = await res.json();
    last.status = pin.status;
    localStorage.setItem(REMOTE_PIN_LAST_KEY, JSON.stringify(last));
    setRemotePinStatus(`Pin ${pin.status} (${last.cid})`);
    if (pin.status === 'pinned' && remotePinBtn) remotePinBtn.textContent = '★ Pinned';
  } catch {}
})();

if (remotePinSaveBtn) {
  const cfg = loadRemotePinConfig();
  if (remotePinEndpointInput) remotePinEndpointInput.value = cfg.endpoint || '';
  if (remotePinTokenInput) remotePinTokenInput.value = cfg.token || '';
  remotePinSaveBtn.addEventListener('click', () => {
    try {
      localStorage.setItem(REMOTE_PIN_CFG_KEY, JSON.stringify({
        endpoint: (remotePinEndpointInput?.value || '').trim(),
        token: (remotePinTokenInput?.value || '').trim()
      }));
    } catch {}
    setRemotePinStatus('Settings saved.');
  });
}
// Pinata preset: fills the PSA endpoint (docs.pinata.cloud — the page's
// remotePinCid speaks the Pinning Services API JSON, same call the
// server-side SDK's upload.public.cid wraps).
const remotePinPresetPinata = document.getElementById('btn-remote-pin-preset-pinata');
if (remotePinPresetPinata) {
  remotePinPresetPinata.addEventListener('click', () => {
    if (remotePinEndpointInput) remotePinEndpointInput.value = 'https://api.pinata.cloud/psa/pins';
    if (remotePinTokenInput) remotePinTokenInput.focus();
    setRemotePinStatus('Endpoint set to Pinata — paste your JWT and Save.');
  });
}
if (remotePinBtn) {
  remotePinBtn.addEventListener('click', remotePinRoot);
}
const signPublishBtn = document.getElementById('btn-sign-publish');
if (signPublishBtn) signPublishBtn.addEventListener('click', signPublished);
const verifyMetadataBtn = document.getElementById('btn-verify-metadata');
if (verifyMetadataBtn) verifyMetadataBtn.addEventListener('click', verifyMetadata);

// Resolve the branch pointer the way a stranger would: through the IPNS
// routers (local record, delegated routing, DHT) rather than our own state.
async function checkIpnsResolution() {
  const statusEl = document.getElementById('ipns-resolve-status');
  if (!statusEl) return;
  if (!heliaNode || !ipnsBranchName) {
    statusEl.textContent = 'Publish the branch pointer first.';
    return;
  }
  statusEl.textContent = 'Resolving…';
  try {
    const key = await getIpnsBranchKey();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('no answer within 30s')), 30000));
    const res = await Promise.race([ipns(heliaNode).resolve(peerIdFromPrivateKey(key)), timeout]);
    const path = res?.path?.toString?.() || res?.value?.toString?.() || String(res?.path ?? res?.value ?? '');
    statusEl.textContent = `Resolves to ${path}`;
  } catch (err) {
    statusEl.textContent = `Not resolvable yet: ${err.message} — the record may still be propagating, or no router has it yet.`;
  }
}
const ipnsResolveBtn = document.getElementById('btn-ipns-resolve');
if (ipnsResolveBtn) ipnsResolveBtn.addEventListener('click', checkIpnsResolution);

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
window.__sanitizeMarkdown = sanitizeMarkdownHtml;
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

// Blocked peers: persisted denylist. Blocked peers are hung up on sight
// (including inbound connections) and hidden from the connected list.
const BLOCKED_KEY = 'blocked-peers';
function getBlockedPeers() {
  try { return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]'); } catch { return []; }
}
function setBlockedPeers(list) {
  try { localStorage.setItem(BLOCKED_KEY, JSON.stringify(list)); } catch {}
}
function isBlockedPeer(id) {
  return getBlockedPeers().includes(id);
}
function blockPeer(id) {
  if (!isBlockedPeer(id)) setBlockedPeers([...getBlockedPeers(), id]);
  const pid = id;
  heliaNode?.libp2p.hangUp(pid).catch(() => {});
  refreshPeers();
}
function unblockPeer(id) {
  setBlockedPeers(getBlockedPeers().filter((x) => x !== id));
  refreshPeers();
}

function refreshPeers() {
  if (!heliaNode || !peersListEl) return;
  try {
    const peers = heliaNode.libp2p.getPeers();
    const countEl = document.getElementById('peer-count');
    if (countEl) countEl.textContent = String(peers.length);
    const insightsPeers = document.getElementById('insights-peers');
    if (insightsPeers) insightsPeers.textContent = String(peers.length);
    peersListEl.innerHTML = '';
    if (!peers || peers.length === 0) {
      peersListEl.innerHTML = '<li>(none)</li>';
    }
    const pingService = heliaNode.libp2p.services?.ping;
    for (const p of peers) {
      const id = p.toString();
      const li = document.createElement('li');
      li.style.marginBottom = '0.4rem';
      li.style.wordBreak = 'break-all';
      const fold = document.createElement('details');
      const summary = document.createElement('summary');
      summary.style.cursor = 'pointer';
      summary.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
      summary.style.fontSize = '0.8rem';
      const idSpan = document.createElement('span');
      idSpan.textContent = id;
      idSpan.title = 'Click to copy peer ID';
      idSpan.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(id);
        idSpan.textContent = 'Copied to clipboard';
        setTimeout(() => { idSpan.textContent = id; }, 900);
      });
      summary.appendChild(idSpan);
      fold.appendChild(summary);

      const body = document.createElement('div');
      body.style.marginTop = '0.3rem';
      body.style.paddingLeft = '1rem';

      const btns = document.createElement('div');
      btns.style.marginBottom = '0.3rem';
      btns.style.whiteSpace = 'nowrap';
      const mkBtn = (label, title, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm';
        b.textContent = label;
        b.title = title;
        b.style.marginRight = '0.35rem';
        b.style.marginBottom = '0.1rem';
        b.style.padding = '0.1rem 0.5rem';
        b.style.fontSize = '0.75rem';
        b.addEventListener('click', onClick);
        return b;
      };

      const pingBtn = mkBtn('Ping', 'Measure round-trip latency', async () => {
        if (!pingService) return;
        pingBtn.disabled = true;
        pingResult.textContent = 'pinging…';
        try {
          const latency = await pingService.ping(p);
          pingResult.textContent = `ping: ${latency}ms`;
        } catch (e) {
          pingResult.textContent = `ping failed: ${(e?.message || e).slice(0, 40)}`;
        } finally {
          pingBtn.disabled = false;
        }
      });
      if (!pingService) pingBtn.disabled = true;
      const pingResult = document.createElement('span');
      pingResult.style.marginLeft = '0.4rem';
      pingResult.style.color = 'var(--color-fg-muted)';
      pingResult.style.fontSize = '0.75rem';

      btns.appendChild(pingBtn);
      btns.appendChild(mkBtn('Disconnect', 'Drop all connections to this peer', () => {
        heliaNode.libp2p.hangUp(p).catch(() => {});
      }));
      btns.appendChild(mkBtn('Block', 'Disconnect and refuse future connections (persisted)', () => {
        blockPeer(id);
      }));
      body.appendChild(btns);
      body.appendChild(pingResult);

      try {
        const conns = heliaNode.libp2p.getConnections(p);
        const streams = conns.reduce((n, c) => n + (c.streams?.length || 0), 0);
        const meta = document.createElement('div');
        meta.style.color = 'var(--color-fg-muted)';
        meta.style.fontSize = '0.75rem';
        meta.textContent = `${conns.map((c) => c.direction).join(', ')} · ${conns.length} connection(s) · ${streams} stream(s)`;
        body.appendChild(meta);
        if (conns[0]) {
          const addr = document.createElement('div');
          addr.textContent = conns[0].remoteAddr.toString();
          addr.style.cssText = 'color:var(--color-fg-muted);font-size:0.72rem;word-break:break-all;';
          body.appendChild(addr);
        }
      } catch {}
      fold.appendChild(body);
      li.appendChild(fold);
      peersListEl.appendChild(li);
    }
    renderBlockedPeers();
  } catch (e) {
    // ignore
  }
}

function renderBlockedPeers() {
  const listEl = document.getElementById('blocked-peers-list');
  const countEl = document.getElementById('blocked-count');
  if (!listEl) return;
  const blocked = getBlockedPeers();
  if (countEl) countEl.textContent = String(blocked.length);
  listEl.innerHTML = '';
  if (blocked.length === 0) {
    listEl.innerHTML = '<li>(none)</li>';
    return;
  }
  for (const id of blocked) {
    const li = document.createElement('li');
    li.style.wordBreak = 'break-all';
    li.style.marginBottom = '0.4rem';
    const span = document.createElement('span');
    span.textContent = id + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = 'Unblock';
    btn.style.padding = '0.1rem 0.5rem';
    btn.style.fontSize = '0.75rem';
    btn.addEventListener('click', () => unblockPeer(id));
    li.appendChild(span);
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

if (copyMultiaddrBtn) {
  copyMultiaddrBtn.addEventListener('click', async () => {
    // Contributors (design objective 2): peers providing the repo root,
    // from the delegated routing provider records. Cached 5 min.
    const root = cloneCidEl?.textContent.trim();
    if (root && root.startsWith('baf')) {
      const cacheKey = `gh-contributors-${root}`;
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch {}
      if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
        renderContributors(cached.providers);
      } else {
        fetch(`https://delegated-ipfs.dev/routing/v1/providers/${root}`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            const providers = (data?.Providers || []).map((p) => p.ID).filter(Boolean);
            try { localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), providers })); } catch {}
            renderContributors(providers);
          })
          .catch(() => {});
      }
    }
    const ma = getShareableMultiaddr();
    if (!ma) { shareStatus.textContent = 'No shareable address yet. Wait for a relay reservation.'; return; }
    try {
      await navigator.clipboard.writeText(ma);
      shareStatus.textContent = 'Copied multiaddr to clipboard.';
    } catch (e) {
      shareStatus.textContent = 'Copy failed — open the Code dropdown and copy the multiaddr from the Multiaddr tab.';
    }
  });
}

const shareLinkField = document.getElementById('share-link-field');

// Current share link for this node: always the full public Pages URL
// (https://<owner>.github.io/<repo>/?connect=...), even in local dev, so the
// link works for anyone opening it.
function buildShareLink() {
  const ma = getShareableMultiaddr();
  if (!ma) return null;
  const url = new URL(pagesUrl);
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

function renderContributors(providers) {
  const el = document.getElementById('contributors-list');
  if (!el) return;
  el.innerHTML = '';
  if (!providers || providers.length === 0) {
    el.textContent = '(none yet — pin the repo on a Kubo to appear here)';
    return;
  }
  for (const id of providers.slice(0, 8)) {
    const div = document.createElement('div');
    div.textContent = id;
    div.title = 'Click to copy peer ID';
    div.style.cssText = 'cursor:pointer;word-break:break-all;margin-bottom:0.25rem;';
    div.addEventListener('click', () => {
      navigator.clipboard?.writeText(id);
      const orig = id;
      div.textContent = 'Copied to clipboard';
      setTimeout(() => { div.textContent = orig; }, 900);
    });
    el.appendChild(div);
  }
  if (providers.length > 8) {
    const more = document.createElement('div');
    more.style.color = 'var(--color-fg-muted)';
    more.textContent = `+ ${providers.length - 8} more`;
    el.appendChild(more);
  }
}

// Color the "Connect to Bootstrap Peers" button from the live connect status:
// green when connected, yellow while connecting/retrying, red otherwise.
function updateBootstrapBtnState() {
  if (!bootstrapBtn) return;
  const s = connectStatus.textContent || '';
  bootstrapBtn.classList.remove('connected', 'connecting', 'disconnected');
  if (s.startsWith('Connected to')) {
    bootstrapBtn.classList.add('connected');
  } else if (/Connecting|Retrying|Probing|Resolving/.test(s)) {
    bootstrapBtn.classList.add('connecting');
  } else {
    bootstrapBtn.classList.add('disconnected');
  }
}
updateBootstrapBtnState();

// Periodically refresh peers + enable share buttons once a circuit address exists
let lastCloneAnnounce = 0;
const cloneRedialAttempts = new Map();
setInterval(() => {
  refreshPeers();
  updateBootstrapBtnState();
  // Keep the Node Status multiaddr list in sync: one foldable, copyable row
  // per address. Rows appear once a relay reservation exists.
  try {
    if (multiaddrsListEl && heliaNode) {
      const addrs = heliaNode.libp2p.getMultiaddrs().map((a) => a.toString());
      const key = addrs.join('\n');
      if (key !== multiaddrsListEl.dataset.key) {
        multiaddrsListEl.dataset.key = key;
        multiaddrsListEl.innerHTML = '';
        if (addrs.length === 0) {
          multiaddrsListEl.textContent = '(none yet — waiting for a relay reservation)';
        } else {
          for (const addr of addrs) {
            const det = document.createElement('details');
            det.style.marginBottom = '0.15rem';
            const sum = document.createElement('summary');
            sum.style.cssText = 'cursor:pointer;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8rem;';
            sum.textContent = addr;
            sum.title = 'Click to copy';
            const flash = () => {
              const orig = addr;
              sum.textContent = 'Copied to clipboard';
              setTimeout(() => { sum.textContent = orig; }, 900);
            };
            sum.addEventListener('click', (e) => {
              e.preventDefault();
              navigator.clipboard?.writeText(addr).then(flash).catch(flash);
            });
            det.appendChild(sum);
            const field = document.createElement('input');
            field.type = 'text';
            field.readOnly = true;
            field.value = addr;
            field.style.cssText = 'width:100%;margin:0.25rem 0 0.35rem 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.78rem;';
            field.title = 'Click to select, then copy';
            field.addEventListener('click', () => field.select());
            field.addEventListener('focus', () => field.select());
            det.appendChild(field);
            multiaddrsListEl.appendChild(det);
          }
        }
      }
    }
  } catch {}
  const pubsub = heliaNode?.libp2p?.services?.pubsub;
  if (pubsub) {
    try {
      const topic = `repo-gossip:${repoFullName}`;
      const subs = pubsub.getSubscribers(topic).map(String);
      const countEl = document.getElementById('clones-count');
      const listEl = document.getElementById('clones-list');
      if (countEl) countEl.textContent = String(subs.length);
      const insightsClones = document.getElementById('insights-clones');
      if (insightsClones) insightsClones.textContent = String(subs.length);
      if (listEl) {
        listEl.innerHTML = '';
        if (subs.length === 0) {
          listEl.innerHTML = '<li>(none yet — open the page in another browser)</li>';
        } else {
          for (const id of subs) {
            const li = document.createElement('li');
            li.textContent = id;
            li.style.wordBreak = 'break-all';
            li.style.fontSize = '0.85rem';
            listEl.appendChild(li);
          }
        }
      }
      // If nobody is known on the topic, re-announce: gossipsub only
      // propagates subscriptions from subscribe events, so peers that
      // connected after we subscribed never heard about us.
      if (subs.length === 0 && Date.now() - lastCloneAnnounce > 15000) {
        lastCloneAnnounce = Date.now();
        try { pubsub.unsubscribe(topic); } catch {}
        try { pubsub.subscribe(topic); } catch {}
        // Same propagation problem on the chat subtopic.
        try { pubsub.unsubscribe(`${topic}:chat`); } catch {}
        try { pubsub.subscribe(`${topic}:chat`); } catch {}
      }
      // libp2p 2.x removed connection tagging, so protect clone peers
      // app-side: redial any known subscriber we are no longer connected
      // to (bounded: one attempt per peer per 20s).
      for (const sub of subs) {
        try {
          const pid = sub;
          if (heliaNode.libp2p.getConnections(pid).length === 0) {
            const last = cloneRedialAttempts.get(pid) || 0;
            if (Date.now() - last > 20000) {
              cloneRedialAttempts.set(pid, Date.now());
              heliaNode.libp2p.dial(pid).catch(() => {});
            }
          }
        } catch {}
      }
    } catch {}
  }
  const ma = getShareableMultiaddr();
  // Branch pointer: one Copy-button binding, plus a republish every 10 min
  // while the page is open so /ipns/<peerId> keeps resolving to the latest root.
  const ipnsCopyBtn = document.getElementById('btn-code-copy-ipns');
  if (ipnsCopyBtn && !ipnsCopyBtn.dataset.bound) {
    ipnsCopyBtn.dataset.bound = '1';
    ipnsCopyBtn.addEventListener('click', () => {
      const fieldEl = document.getElementById('code-ipns-field');
      const v = (fieldEl && (fieldEl.dataset.ipns || fieldEl.value)) || '';
      if (!v) return;
      const done = () => {
        const orig = ipnsCopyBtn.textContent;
        ipnsCopyBtn.textContent = 'Copied to clipboard';
        setTimeout(() => { ipnsCopyBtn.textContent = orig; }, 900);
      };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(v).then(done).catch(done);
      } else {
        done();
      }
    });
  }
  if (ipnsBranchCid && Date.now() - ipnsBranchLastPublish > 10 * 60 * 1000) {
    publishBranchPointer(ipnsBranchCid).catch(() => {});
  }
  if (codeBtn && (ma || ipnsBranchName)) codeBtn.disabled = false;
  if (remotePinBtn) {
    const root = cloneCidEl?.textContent.trim() || '';
    if (root.startsWith('baf') && loadRemotePinConfig().endpoint) remotePinBtn.disabled = false;
  }
  if (ma) {
    if (copyMultiaddrBtn) copyMultiaddrBtn.disabled = false;
    if (copyLinkBtn) copyLinkBtn.disabled = false;
    if (codeMultiaddrField && !codeMultiaddrField.value) codeMultiaddrField.value = ma;
    if (codeShareField && !codeShareField.value) codeShareField.value = buildShareLink() || '';
    if (shareLinkField && !shareLinkField.value) shareLinkField.value = buildShareLink() || '';
    const docSwarm = document.getElementById('doc-swarm-cmd');
    if (docSwarm) {
      const root = (cloneCidEl && cloneCidEl.textContent.trim()) || '<root CID from the Clone bar>';
      const cmd = `ipfs swarm connect '${ma}'\nipfs pin add ${root}`;
      if (docSwarm.textContent !== cmd) docSwarm.textContent = cmd;
    }
    const docGet = document.getElementById('doc-get-cmd');
    if (docGet) {
      const root = cloneCidEl?.textContent.trim();
      if (root && root.startsWith('baf')) {
        const cmd = `ipfs get ${root}`;
        if (docGet.textContent !== cmd) docGet.textContent = cmd;
      }
    }
    const docPin = document.getElementById('doc-pin-cmd');
    if (docPin) {
      const root = cloneCidEl?.textContent.trim();
      if (root && root.startsWith('baf')) {
        const cmd = `ipfs pin add ${root}`;
        if (docPin.textContent !== cmd) docPin.textContent = cmd;
      }
    }
    const docDnslinkIpns = document.getElementById('doc-dnslink-ipns');
    if (docDnslinkIpns && ipnsBranchName) {
      const rec = `dnslink=${ipnsBranchName}`;
      if (docDnslinkIpns.textContent !== rec) docDnslinkIpns.textContent = rec;
    }
    const docDnslinkCid = document.getElementById('doc-dnslink-cid');
    if (docDnslinkCid) {
      const root = cloneCidEl?.textContent.trim();
      if (root && root.startsWith('baf')) {
        const rec = `dnslink=/ipfs/${root}`;
        if (docDnslinkCid.textContent !== rec) docDnslinkCid.textContent = rec;
      }
    }
    const docPublish = document.getElementById('doc-publish-cmd');
    if (docPublish) {
      const publishedEl = document.getElementById('output-cid');
      const published = publishedEl?.dataset.published ? publishedEl.textContent.trim() : null;
      if (published && published.startsWith('baf')) {
        const cmd = `ipfs swarm connect '${ma}'\nipfs pin add ${published}`;
        if (docPublish.textContent !== cmd) docPublish.textContent = cmd;
      }
    }
    // Mapping chips (design objective 2): Kubo equivalent at the control.
    const chipCar = document.getElementById('chip-car-export');
    if (chipCar) {
      const root = cloneCidEl?.textContent.trim();
      if (root && root.startsWith('baf')) {
        const cmd = `ipfs dag export ${root}`;
        if (chipCar.textContent !== cmd) chipCar.textContent = cmd;
      }
    }
    const chipFetch = document.getElementById('chip-fetch-get');
    if (chipFetch && inputCid) {
      const cid = inputCid.value.trim();
      const cmd = `ipfs get ${cid && /^[a-z0-9]+$/i.test(cid) ? cid : '<CID>'}`;
      if (chipFetch.textContent !== cmd) chipFetch.textContent = cmd;
    }
    const chipSwarm = document.getElementById('chip-swarm-connect');
    if (chipSwarm && inputMultiaddr) {
      const ma = inputMultiaddr.value.trim();
      const cmd = ma ? `ipfs swarm connect '${ma}'` : "ipfs swarm connect '<multiaddr>'";
      if (chipSwarm.textContent !== cmd) chipSwarm.textContent = cmd;
    }
    // Publish tab help: pin command + full gateway URL once something is published.
    const publishHelp = document.getElementById('publish-help');
    if (publishHelp && publishHelp.style.display !== 'none') {
      const publishedEl = document.getElementById('output-cid');
      const published = publishedEl?.dataset.published ? publishedEl.textContent.trim() : null;
      if (published) {
        const slug = (window.__lastPublishedSlug || 'published');
        const host = (document.getElementById('settings-rpc-host')?.value.trim()) || '127.0.0.1';
        const pinCmd = document.getElementById('publish-pin-cmd');
        if (pinCmd) {
          const cmd = `ipfs swarm connect '${ma}'\nipfs pin add ${published}`;
          if (pinCmd.textContent !== cmd) pinCmd.textContent = cmd;
        }
        const gw = document.getElementById('publish-gateway-url');
        if (gw) {
          const url = `http://${host}:8080/ipfs/${published}?filename=${slug}`;
          if (gw.textContent !== url) gw.textContent = url;
        }
        const pubPath = document.getElementById('publish-public-path-url');
        if (pubPath) {
          const url = `https://ipfs.io/ipfs/${published}?filename=${slug}`;
          if (pubPath.textContent !== url) pubPath.textContent = url;
        }
        const pubSub = document.getElementById('publish-public-subdomain-url');
        if (pubSub) {
          const url = `https://${published}.ipfs.dweb.link?filename=${slug}`;
          if (pubSub.textContent !== url) pubSub.textContent = url;
        }
        const tlPath = document.getElementById('publish-trustless-path-url');
        if (tlPath) {
          const url = `https://ipfs.io/ipfs/${published}?format=car`;
          if (tlPath.textContent !== url) tlPath.textContent = url;
        }
        const tlSub = document.getElementById('publish-trustless-subdomain-url');
        if (tlSub) {
          const url = `https://${published}.ipfs.dweb.link?format=car`;
          if (tlSub.textContent !== url) tlSub.textContent = url;
        }
        const tlCurl = document.getElementById('publish-trustless-curl-cmd');
        if (tlCurl) {
          const cmd = `curl -s "https://ipfs.io/ipfs/${published}?format=car" -o ${published}.car\nipfs dag import ${published}.car`;
          if (tlCurl.textContent !== cmd) tlCurl.textContent = cmd;
        }
        const carImport = document.getElementById('publish-car-import-cmd');
        if (carImport) {
          const cmd = `ipfs dag import ${published}.car`;
          if (carImport.textContent !== cmd) carImport.textContent = cmd;
        }
      }
    }
  }
}, 2000);

// Theme toggle (light/dark via Primer color modes), persisted in localStorage.
const themeToggleBtn = document.getElementById('btn-theme-toggle');
const MOON_SVG = '<svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.598 1.591a.75.75 0 0 1 .785-.175 7 7 0 1 1-9.9 9.9.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.07-7.07.75.75 0 0 1-.175-.785Z"></path></svg>';
const SUN_SVG = '<svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"></path></svg>';
function applyTheme(mode) {
  document.documentElement.setAttribute('data-color-mode', mode);
  try { localStorage.setItem('theme', mode); } catch (e) {}
  if (themeToggleBtn) {
    themeToggleBtn.innerHTML = mode === 'dark' ? SUN_SVG : MOON_SVG;
    themeToggleBtn.title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
}
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
  applyTheme(document.documentElement.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light');
}

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

// Tab navigation — every named view has its own endpoint (#/code, #/issues,
// #/peer, …) so a refresh or a shared link lands back on the same view.
// GitHub-style PATH routes are accepted too: /code, /issues, /peer load the
// right view and normalize to the canonical hash form. When both are given
// (/code#/issues) the hash wins. Canonical form is the hash because GitHub
// Pages has no SPA fallback for unknown paths — dist ships a 404.html copy
// of index.html so deep path links on Pages still boot the app.
const TAB_ROUTE_ALIAS = { code: 'files' };
const ROUTE_NAMES = ['code', 'issues', 'pulls', 'actions', 'projects', 'wiki', 'security', 'insights', 'settings', 'peer', 'publish'];
const VALID_TABS = ['files', 'issues', 'pulls', 'actions', 'projects', 'wiki', 'security', 'insights', 'settings', 'peer', 'publish'];

function activateTab(tab) {
  const target = TAB_ROUTE_ALIAS[tab] || tab;
  if (!VALID_TABS.includes(target)) return false;
  // Nav items are endpoint links (`<a href="#/route" data-tab-route>`);
  // match active state by route, not by tab name.
  const route = target === 'files' ? 'code' : target;
  document.querySelectorAll('.tab-button[data-tab], a.tab-link[data-tab-route]').forEach((el) => {
    const elRoute = el.dataset.tabRoute || (el.dataset.tab === 'files' ? 'code' : el.dataset.tab);
    const on = elRoute === route;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
  const panel = document.getElementById(`tab-${target}`);
  if (panel) panel.classList.add('active');
  // The Code tab's landing state is the file tree — arriving at #/code
  // (link click or navigation) escapes any open file view.
  if (target === 'files') hideFileBlob();
  return true;
}

// The directory part of the current path with any route segment removed —
// the shareable base (on Pages: /ipfs-gh-pages, locally: '' or '/').
function basePath() {
  const segs = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length && ROUTE_NAMES.includes(segs[segs.length - 1])) segs.pop();
  return segs.length ? '/' + segs.join('/') : '';
}

function applyRoute() {
  const hashTab = window.location.hash.replace(/^#\/?/, '');
  const lastSeg = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
  const tab = (hashTab && ROUTE_NAMES.includes(hashTab) && hashTab) || (ROUTE_NAMES.includes(lastSeg) && lastSeg) || '';
  if (!tab) return;
  activateTab(tab);
  const canonical = `${basePath()}/#/${tab}`;
  if (window.location.pathname + window.location.hash !== canonical) {
    history.replaceState(null, '', canonical);
  }
}

// Tab links navigate natively (hash → applyRoute). Clicking the CURRENT
// route's link fires no hashchange, so re-apply it: pressing Code while a
// file view is open escapes to the tree.
document.querySelectorAll('a.tab-link[data-tab-route]').forEach((a) => {
  a.addEventListener('click', () => {
    if (a.getAttribute('href') === window.location.hash) applyRoute();
  });
});
window.addEventListener('hashchange', applyRoute);
applyRoute();

// ipfs:// URI support (docs/ipfs-uri-providers.md): clicking an ipfs:// or
// ipns:// link fetches in-app through our own Helia node — works on every
// platform with no extension. web+ipfs/web+ipns protocol handlers land
// external "open in app" requests on the same path via ?uri=.
function openUri(uri) {
  const m = uri.match(/^ip[fn]s:\/\/([^/?#]+)/i) || uri.match(/^web\+ip[fn]s:\/\/([^/?#]+)/i);
  if (!m) return false;
  activateTab('files');
  if (inputCid) inputCid.value = m[1];
  fetchContent(m[1]);
  return true;
}

// Companion preference (docs/ipfs-uri-providers.md §1.3): with companion
// (or the iOS build) present, native ipfs:// hrefs are the better path —
// skip interception so the extension handles them. Default off:
// interception wins because it works with no install.
const COMPANION_PREF_KEY = 'pref-ipfs-companion';
function companionPrefOn() {
  try { return localStorage.getItem(COMPANION_PREF_KEY) === '1'; } catch { return false; }
}
const companionToggle = document.getElementById('pref-companion');
if (companionToggle) {
  companionToggle.checked = companionPrefOn();
  companionToggle.addEventListener('change', () => {
    try { localStorage.setItem(COMPANION_PREF_KEY, companionToggle.checked ? '1' : '0'); } catch {}
  });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="ipfs://"],a[href^="ipns://"],a[href^="web+ipfs://"],a[href^="web+ipns://"]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (companionPrefOn() && /^(?:ipfs|ipns):\/\//i.test(href)) return; // native passthrough
  e.preventDefault();
  openUri(href);
});

try {
  navigator.registerProtocolHandler('web+ipfs', `${location.origin}${basePath()}/?uri=%s`, 'ipfs-gh-pages');
  navigator.registerProtocolHandler('web+ipns', `${location.origin}${basePath()}/?uri=%s`, 'ipfs-gh-pages');
} catch {}

const uriParam = new URLSearchParams(window.location.search).get('uri');
if (uriParam) openUri(uriParam);

// ---- CID linkification (docs/ipfs-uri-providers.md step 3) ----------------
// Every CID rendered anywhere on the page becomes a link — click fetches
// in-app through our own Helia node (the ipfs:// interception above) and
// opens the affordance popover below. Commands stay plain: pre blocks and
// kubo chips are copy targets (design idiom), so they are never linkified.
const LINKIFY_SKIP = 'pre, .kubo-chip, a, script, style, textarea, input, select, [contenteditable], #cid-popover';

function linkifyTextNode(node) {
  const text = node.nodeValue;
  if (!text || !/(?:baf|bag|Qm)/.test(text)) return;
  const tokens = findCidTokens(text);
  if (tokens.length === 0) return;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const t of tokens) {
    if (t.start > last) frag.appendChild(document.createTextNode(text.slice(last, t.start)));
    const a = document.createElement('a');
    a.href = `ipfs://${t.cid}`;
    a.className = 'cid-link';
    a.textContent = t.cid;
    frag.appendChild(a);
    last = t.end;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  node.parentNode.replaceChild(frag, node);
}

function linkifyCids(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest(LINKIFY_SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const n of targets) linkifyTextNode(n);
}

// One observer covers every current and future CID: re-renders that
// replace text nodes are picked up automatically. Wrapping converges —
// new links live inside <a>, which the walker skips.
const cidLinkObserver = new MutationObserver((mutations) => {
  const elements = [];
  const texts = [];
  for (const m of mutations) {
    if (m.type === 'childList') {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE) elements.push(n);
        else if (n.nodeType === Node.TEXT_NODE) texts.push(n);
      }
    } else if (m.type === 'characterData') {
      texts.push(m.target);
    }
  }
  for (const n of texts) {
    if (n.parentElement && !n.parentElement.closest(LINKIFY_SKIP)) linkifyTextNode(n);
  }
  const visible = elements.filter((el) => !el.closest(LINKIFY_SKIP));
  if (visible.length) {
    requestAnimationFrame(() => { for (const el of visible) linkifyCids(el); });
  }
});
cidLinkObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
linkifyCids(document.body);

// ---- CID affordance popover (docs/ipfs-uri-providers.md §2 + step 3) ------
// gateway / ipfs:// / providers / pin affordances for any linkified CID.
let cidPopover = null;

function closeCidPopover() {
  if (cidPopover) { cidPopover.remove(); cidPopover = null; }
}

async function loadProvidersInto(el, cid) {
  try {
    const res = await fetch(`${DELEGATED_ROUTING_URL}/routing/v1/providers/${cid}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const providers = (await res.json()).Providers || [];
    el.innerHTML = '';
    const head = document.createElement('div');
    head.textContent = `${providers.length} provider(s) (delegated routing)`;
    el.appendChild(head);
    for (const p of providers.slice(0, 5)) {
      const id = document.createElement('div');
      id.style.wordBreak = 'break-all';
      id.textContent = p.ID;
      el.appendChild(id);
      for (const addr of (p.Addrs || []).slice(0, 3)) {
        const pre = document.createElement('pre');
        pre.style.margin = '0.15rem 0';
        const code = document.createElement('code');
        code.textContent = `ipfs swarm connect '${addr}'`;
        pre.appendChild(code);
        el.appendChild(pre);
      }
    }
    if (providers.length === 0) {
      el.textContent = '0 providers found (delegated routing) — gateways may still resolve it.';
    }
  } catch (err) {
    el.textContent = `Provider lookup failed: ${err.message}`;
  }
}

function showCidPopover(cid, anchor) {
  closeCidPopover();
  const model = cidAffordanceModel(cid);
  const pop = document.createElement('div');
  pop.id = 'cid-popover';
  pop.style.cssText = 'position:fixed;z-index:1000;max-width:min(30rem,90vw);background:var(--color-canvas-overlay,#ffffff);color:var(--color-fg-default,#1f2328);border:1px solid var(--color-border-default,#d0d7de);border-radius:6px;padding:0.6rem 0.75rem;font-size:0.8rem;box-shadow:0 8px 24px rgba(0,0,0,0.12);';

  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;word-break:break-all;margin-bottom:0.35rem;';
  head.textContent = cid;
  pop.appendChild(head);

  const linkRow = (label, href, external) => {
    const div = document.createElement('div');
    div.style.cssText = 'word-break:break-all;margin:0.1rem 0;';
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (external) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    div.appendChild(a);
    pop.appendChild(div);
  };
  linkRow(model.ipfsUri, model.ipfsUri, false);
  linkRow(model.gatewayUrl, model.gatewayUrl, true);
  linkRow(model.subdomainUrl, model.subdomainUrl, true);

  const pre = document.createElement('pre');
  pre.style.margin = '0.35rem 0';
  const code = document.createElement('code');
  code.textContent = model.pinCmd;
  pre.appendChild(code);
  pop.appendChild(pre);

  const prov = document.createElement('div');
  prov.className = 'f6 color-fg-muted';
  prov.style.marginTop = '0.35rem';
  prov.textContent = 'Looking up providers (delegated routing)…';
  pop.appendChild(prov);

  const pinRow = document.createElement('div');
  pinRow.style.cssText = 'margin-top:0.4rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;';
  const pinBtn = document.createElement('button');
  pinBtn.className = 'btn btn-sm';
  pinBtn.type = 'button';
  pinBtn.textContent = '☆ Pin to provider';
  const pinStatus = document.createElement('span');
  pinStatus.className = 'f6 color-fg-muted';
  pinStatus.style.wordBreak = 'break-all';
  pinRow.appendChild(pinBtn);
  pinRow.appendChild(pinStatus);
  pop.appendChild(pinRow);

  pinBtn.addEventListener('click', async () => {
    pinBtn.disabled = true;
    pinStatus.textContent = 'Pinning…';
    try {
      const pin = await remotePinCid(cid, repoFullName);
      pinStatus.textContent = `Pin ${pin.status}${pin.requestId ? ` (${pin.requestId})` : ''}`;
    } catch (err) {
      pinStatus.textContent = `Pin failed: ${err.message}`;
      pinBtn.disabled = false;
    }
  });

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  cidPopover = pop;
  loadProvidersInto(prov, cid);
}

document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a.cid-link');
  if (link) {
    showCidPopover(link.getAttribute('href').replace(/^ipfs:\/\//, ''), link);
    return; // the ipfs:// interception above runs the in-app fetch
  }
  if (cidPopover && !e.target.closest('#cid-popover')) closeCidPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCidPopover();
});

// Settings endpoint deep-link: open the Peer tab's Settings sub-tab.
const openNodeSettingsBtn = document.getElementById('btn-open-node-settings');
if (openNodeSettingsBtn) {
  openNodeSettingsBtn.addEventListener('click', () => {
    window.location.hash = '/peer';
    activateTab('peer');
    const sub = document.getElementById('sub-tab-btn-settings');
    if (sub) sub.click();
  });
}

// Actions endpoint: show which build this page is.
const actionsVersionEl = document.getElementById('actions-app-version');
if (actionsVersionEl && appVersion) actionsVersionEl.textContent = `v${appVersion}`;

// Issues and comments: signed dag-json note objects (docs/issues-car.md
// phase 1 — the full note schema: ns/type/anchors, comments reply via
// parent CID). signNote/verifyNote are shared by every note type.
const ISSUES_KEY = 'repo-issues';
const COMMENTS_KEY = 'repo-comments';

function loadIssues() {
  try { return JSON.parse(localStorage.getItem(ISSUES_KEY) || '[]'); } catch { return []; }
}

function loadCommentIndex() {
  try { return JSON.parse(localStorage.getItem(COMMENTS_KEY) || '{}'); } catch { return {}; }
}

// Build the signed envelope for any note payload; signer identity is the
// browser's Ed25519 key (same as IPNS/chat/attestation).
async function signNote(fields) {
  const key = await getIpnsBranchKey();
  const signer = peerIdFromPrivateKey(key).toString();
  const signed = { ...fields, signer };
  const signature = await key.sign(dagJson.encode(signed));
  return {
    envelope: {
      ...signed,
      signature: uint8ArrayToBase64(signature),
      publicKey: uint8ArrayToBase64(publicKeyToProtobuf(key.publicKey))
    },
    signer
  };
}

// Verify a fetched note; returns { ok, signed, signer } without throwing on
// a bad signature (that's data, not an error).
async function verifyNote(envelope) {
  const { signature, publicKey, ...signed } = envelope;
  const pub = publicKeyFromProtobuf(base64ToUint8Array(publicKey));
  const signer = peerIdFromPublicKey(pub).toString();
  const ok = await pub.verify(dagJson.encode(signed), base64ToUint8Array(signature));
  return { ok, signed, signer };
}

let currentIssueCid = null;
// Phase 3: an issue filed from the file tree anchors to that file's CID —
// the git-notes model (annotate without mutating the annotated object).
let pendingIssueAnchor = null;

// Phase 4: the local index chain (Chronology protocol, docs/issues-car.md).
// Every create extends the chain with a hash-chained, signed index entry:
// {type, added, prev, height, lamport, signer, timestamp, signature,
// publicKey}. Prev links give the DAG its history; height/lamport feed the
// fork-choice rule when remote chains merge (phase 5).
const CHAIN_KEY = 'repo-index-chain';
const LAMPORT_KEY = 'repo-index-lamport';

// Phase 10: the index tip gets its OWN IPNS name (one name holds one
// value; the branch pointer already uses the repo key — docs/issues-car.md
// "the index tip, published at an IPNS name"). Same key derivation and
// localStorage scheme as the branch key, so interop identity adoption
// (docs/interop.md) carries the index name across surfaces too.
let ipnsIndexKeyPromise = null;
function getIpnsIndexKey() {
  if (!ipnsIndexKeyPromise) {
    ipnsIndexKeyPromise = (async () => {
      const storageKey = `ipns-index-key:${repoFullName}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          return privateKeyFromRaw(base64ToUint8Array(stored));
        } catch {}
      }
      const key = await generateKeyPair('Ed25519');
      localStorage.setItem(storageKey, uint8ArrayToBase64(key.raw));
      return key;
    })();
  }
  return ipnsIndexKeyPromise;
}

function indexIpnsName() {
  return getIpnsIndexKey().then((key) => `/ipns/${peerIdFromPrivateKey(key)}`);
}

// Publish the chain tip to the index IPNS name. Fire-and-forget: IPNS
// publishing is slow (DHT put) and must never block issue creation.
function publishIndexTip(tipCid) {
  if (!heliaNode || !tipCid) return;
  (async () => {
    try {
      const key = await getIpnsIndexKey();
      await ipns(heliaNode).publish(key, CID.parse(String(tipCid)));
      window.__indexIpnsLastPublish = Date.now();
    } catch {}
  })();
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

// Extend the chain with a new signed entry naming the notes just created.
// The chain is its own content-addressed DAG; the tip CID is what a
// stranger fetches to replay our chronology.
async function extendChain(addedCids) {
  if (!heliaNode || addedCids.length === 0) return null;
  const prevTip = loadChainTip();
  const parentCids = prevTip ? [prevTip.cid] : [];
  let parentHeight = 0;
  let parentLamport = 0;
  if (prevTip) {
    try {
      const prevEntry = await getDagJson(CID.parse(prevTip.cid));
      parentHeight = Number(prevEntry.height) || 0;
      parentLamport = Number(prevEntry.lamport) || 0;
    } catch { /* prev unavailable — treat as genesis */ }
  }
  const lamport = nextLamport([parentLamport]);
  const height = parentHeight + 1;
  const { envelope } = await signNote({
    type: 'index-entry',
    added: addedCids,
    prev: parentCids,
    height,
    lamport,
    timestamp: new Date().toISOString()
  });
  const cid = await publishNote(envelope);
  try {
    localStorage.setItem(CHAIN_KEY, JSON.stringify({ cid, height, lamport, added: addedCids.length }));
  } catch {}
  publishIndexTip(cid);
  renderChainStatus();
  return cid;
}

// Display the local chain tip — height, CID, and its pin command (the
// design-idiom pre block inherits yellow + single-click copy).
function renderChainStatus() {
  const el = document.getElementById('index-chain-status');
  if (!el) return;
  const tip = loadChainTip();
  if (!tip) {
    el.innerHTML = '<span class="f6 color-fg-muted">Index chain: genesis pending — create the first issue.</span>';
    return;
  }
  el.innerHTML = '';
  const meta = document.createElement('div');
  meta.className = 'f6 color-fg-muted';
  meta.style.wordBreak = 'break-all';
  meta.textContent = `Index chain: height ${tip.height} · tip ${tip.cid}`;
  indexIpnsName().then((name) => {
    meta.textContent += ` · index name ${name} (resolves while a publisher is online)`;
  }).catch(() => {});
  const pre = document.createElement('pre');
  pre.style.margin = '0.2rem 0 0 0';
  const code = document.createElement('code');
  code.textContent = `ipfs pin add ${tip.cid}`;
  pre.appendChild(code);
  // Git-host bridge (docs/issues-car.md phase 12): the pre-push hook reads
  // this file — run the export command, then activate the hooks with
  // `npm run githooks:activate` in a clone of the repo.
  const exportPre = document.createElement('pre');
  exportPre.style.margin = '0.2rem 0 0 0';
  const exportCode = document.createElement('code');
  exportCode.textContent = `printf '%s\\n' '${tip.cid}' > "$(git rev-parse --git-path ipfs-index-tip)"`;
  exportPre.appendChild(exportCode);
  el.appendChild(meta);
  el.appendChild(pre);
  el.appendChild(exportPre);
}

// Phase 10 cross-surface sync (docs/interop.md step 4): resolve our index
// IPNS name and hand the tip to the shared merge. Fire-and-forget on load;
// the git-host bridge (phase 12) feeds the same merge via the button below.
async function syncIndexFromIpns() {
  if (!heliaNode) return;
  try {
    const name = await indexIpnsName();
    const result = await ipns(heliaNode).resolve(name, { timeout: 8000 }).catch(() => null);
    if (!result) return;
    const remoteCid = result.value || result.path || result;
    const remoteStr = remoteCid.toString().replace(/^\/ipfs\//, '');
    await syncIndexFromTip(remoteStr);
  } catch {}
}

// Merge a remote index tip per the Chronology protocol (docs/issues-car.md):
// fetch the entry (prefix closure on walk), union missing notes into the
// local list — OR-Set semantics, so the union happens even when the chain
// decision is noop — then adopt the remote chain or write a two-parent
// merge entry (shared js/index-merge.js decision). Returns
// { action, merged, tip }; throws when the tip cannot be fetched.
async function syncIndexFromTip(remoteStr) {
  if (!heliaNode) throw new Error('IPFS node not ready');
  const local = loadChainTip();
  if (!remoteStr || (local && remoteStr === local.cid)) {
    return { action: 'noop', merged: 0, tip: (local && local.cid) || remoteStr || null };
  }
  const remoteEntry = await getDagJson(CID.parse(remoteStr));
  if (!remoteEntry || remoteEntry.type !== 'index-entry') {
    throw new Error(`${remoteStr} is not an index entry`);
  }

  const descendsFrom = async (tipCid, ancestorCid, maxSteps = 50) => {
    let cursor = tipCid;
    for (let i = 0; i < maxSteps && cursor; i++) {
      if (cursor === ancestorCid) return true;
      try {
        const entry = await getDagJson(CID.parse(cursor));
        cursor = Array.isArray(entry?.prev) ? entry.prev[0] : null;
      } catch { break; }
    }
    return false;
  };

  // Collect remote notes missing locally (bounded) — feeds both the
  // issues view and the merge entry's `added`.
  const missingNotes = [];
  {
    const known = new Set(loadIssues().map((i) => i.cid));
    let cursor = remoteEntry;
    let walked = 0;
    while (cursor && walked < 50) {
      for (const noteCid of cursor.added || []) {
        if (known.has(noteCid)) continue;
        try {
          const note = await getDagJson(CID.parse(noteCid));
          if (note && note.ns === 'issues' && note.type === 'issue' && note.title) {
            missingNotes.push({ cid: noteCid, title: note.title, timestamp: note.timestamp });
            known.add(noteCid);
          }
        } catch {}
      }
      const prev = Array.isArray(cursor.prev) ? cursor.prev[0] : null;
      if (!prev) break;
      try { cursor = await getDagJson(CID.parse(prev)); } catch { break; }
      walked++;
    }
  }

  const decision = classifyIndexSync(
    local,
    { cid: remoteStr, height: Number(remoteEntry?.height) || 0, lamport: Number(remoteEntry?.lamport) || 0 },
    local ? await descendsFrom(remoteStr, local.cid) : false,
    local ? await descendsFrom(local.cid, remoteStr) : false
  );
  if (decision.action === 'adopt-remote') {
    localStorage.setItem(CHAIN_KEY, JSON.stringify({
      cid: remoteStr,
      height: Number(remoteEntry.height) || 0,
      lamport: Number(remoteEntry.lamport) || 0,
      added: Array.isArray(remoteEntry.added) ? remoteEntry.added.length : 0
    }));
    try { localStorage.setItem(LAMPORT_KEY, String(Number(remoteEntry.lamport) || 0)); } catch {}
  } else if (decision.action === 'merge') {
    // Divergence: merge entry, both parents, union of missing notes.
    const { envelope } = await signNote({
      type: 'index-entry',
      added: missingNotes.map((n) => n.cid),
      prev: [local.cid, remoteStr],
      height: decision.height,
      lamport: decision.lamport,
      timestamp: new Date().toISOString()
    });
    const tipCid = await publishNote(envelope);
    localStorage.setItem(CHAIN_KEY, JSON.stringify({ cid: tipCid, height: decision.height, lamport: decision.lamport, added: missingNotes.length }));
    publishIndexTip(tipCid);
  }

  if (missingNotes.length) {
    const issues = loadIssues();
    issues.unshift(...missingNotes);
    localStorage.setItem(ISSUES_KEY, JSON.stringify(issues.slice(0, 200)));
  }
  if (decision.action !== 'noop' || missingNotes.length) {
    renderChainStatus();
    renderIssues();
  }
  return { action: decision.action, merged: missingNotes.length, tip: loadChainTip()?.cid || remoteStr };
}

// Git-host bridge inbound (docs/issues-car.md phase 12): a fetched notes ref
// (the post-merge hook prints it) or a peer hands us a tip CID — paste it
// here to merge it into the local chain and issue list.
const indexSyncBtn = document.getElementById('btn-index-sync');
if (indexSyncBtn) {
  indexSyncBtn.addEventListener('click', async () => {
    const input = document.getElementById('index-sync-cid');
    const status = document.getElementById('index-sync-status');
    const raw = (input?.value || '').trim().replace(/^\/ipfs\//, '');
    if (!raw) {
      if (status) status.textContent = 'Paste an index tip CID first.';
      return;
    }
    indexSyncBtn.disabled = true;
    if (status) status.textContent = `Fetching ${raw}…`;
    try {
      const r = await syncIndexFromTip(raw);
      if (r.action === 'noop') {
        if (status) status.textContent = `Already current — ${raw} needs no merge.`;
      } else {
        if (status) status.textContent = `${r.action === 'merge' ? 'Merged' : 'Adopted'} ${raw} · ${r.merged} new note(s) · tip now ${r.tip}`;
      }
    } catch (err) {
      if (status) status.textContent = `Sync failed for ${raw}: ${err.message}`;
    } finally {
      indexSyncBtn.disabled = false;
    }
  });
}

function renderIssues() {
  const listEl = document.getElementById('issues-list');
  if (!listEl) return;
  const issues = loadIssues();
  listEl.innerHTML = '';
  if (issues.length === 0) {
    listEl.innerHTML = '<li class="f6 color-fg-muted">(none yet)</li>';
    return;
  }
  for (const issue of issues) {
    const li = document.createElement('li');
    li.style.cssText = 'padding: 0.3rem 0; border-bottom: 1px solid var(--color-border-muted);';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex; flex-wrap:wrap; gap: 0.5rem; align-items: baseline;';
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = issue.title || '(untitled)';
    a.title = `Open and verify ${issue.cid}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openIssue(issue.cid);
    });
    const when = document.createElement('span');
    when.className = 'f6 color-fg-muted';
    when.textContent = issue.timestamp;
    head.appendChild(a);
    head.appendChild(when);
    // Per-issue command, own line, yellow — the delegated design-pattern
    // listener makes it single-click copy automatically.
    const cmd = document.createElement('pre');
    cmd.style.margin = '0.2rem 0 0.1rem 0';
    const codeEl = document.createElement('code');
    codeEl.textContent = `ipfs pin add ${issue.cid}`;
    cmd.appendChild(codeEl);
    li.appendChild(head);
    li.appendChild(cmd);
    listEl.appendChild(li);
  }
}

async function publishNote(envelope) {
  const cid = await addDagJson(envelope);
  heliaNode.routing?.provide?.(cid).catch(() => {});
  return cid.toString();
}

// Rehost records (docs/ipfs-rehost-service.md phase 4): a completed
// rehost is written to the issues chain as a signed {ns:'rehost'} note,
// so mirrors (scripts/rehost-mirror.mjs) can pin the set without the
// origin or the original rehoster. The renderer calls this when the
// image policy is "rehost" (js/rehost.js returns a CID).
async function recordRehost(url, cid) {
  const { envelope } = await signNote({
    ns: 'rehost',
    type: 'rehost',
    url,
    cid,
    timestamp: new Date().toISOString()
  });
  const noteCid = await publishNote(envelope);
  await extendChain([noteCid]);
  return noteCid;
}

async function createIssue() {
  const titleEl = document.getElementById('issue-title');
  const bodyEl = document.getElementById('issue-body');
  const statusEl = document.getElementById('issue-status');
  const title = (titleEl?.value || '').trim();
  const body = (bodyEl?.value || '').trim();
  if (!title) {
    if (statusEl) statusEl.textContent = 'Give the issue a title first.';
    return;
  }
  if (!heliaNode) {
    if (statusEl) statusEl.textContent = 'Wait for the node to come online.';
    return;
  }
  if (statusEl) statusEl.textContent = 'Signing and publishing…';
  try {
    const anchors = pendingIssueAnchor ? [pendingIssueAnchor.cid] : [];
    const { envelope, signer } = await signNote({
      ns: 'issues',
      type: 'issue',
      anchors,
      title,
      body,
      timestamp: new Date().toISOString()
    });
    const cid = await publishNote(envelope);
    const issues = loadIssues();
    issues.unshift({ cid, title, timestamp: envelope.timestamp, signer, anchors });
    try { localStorage.setItem(ISSUES_KEY, JSON.stringify(issues)); } catch {}
    await extendChain([cid]);
    if (titleEl) titleEl.value = '';
    if (bodyEl) bodyEl.value = '';
    if (statusEl) statusEl.textContent = `Created — ${cid}${pendingIssueAnchor ? ` — anchored to ${pendingIssueAnchor.name}` : ''}`;
    pendingIssueAnchor = null;
    // Hand the user the real command at the moment of creation, on its own
    // line (yellow by the global command rule).
    const resultPre = document.getElementById('issue-result');
    if (resultPre) {
      resultPre.style.display = 'block';
      resultPre.querySelector('code').textContent = `ipfs pin add ${cid}`;
    }
    const pinCmd = document.getElementById('issue-pin-cmd');
    if (pinCmd) pinCmd.textContent = `ipfs pin add ${cid}`;
    renderIssues();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Failed: ${err.message}`;
  }
}

// A comment is a note whose parent is the issue (or another comment) —
// the git-commit-parent analog; threads are chains, nothing is mutated.
async function createComment(issueCid, body) {
  const statusEl = document.getElementById('issue-reply-status');
  if (!heliaNode) {
    if (statusEl) statusEl.textContent = 'Wait for the node to come online.';
    return;
  }
  if (statusEl) statusEl.textContent = 'Signing…';
  try {
    const { envelope } = await signNote({
      ns: 'issues',
      type: 'comment',
      parent: issueCid,
      body,
      timestamp: new Date().toISOString()
    });
    const cid = await publishNote(envelope);
    const index = loadCommentIndex();
    (index[issueCid] = index[issueCid] || []).push(cid);
    try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(index)); } catch {}
    await extendChain([cid]);
    const replyEl = document.getElementById('issue-reply');
    if (replyEl) replyEl.value = '';
    if (statusEl) statusEl.textContent = `Commented — ${cid}`;
    openIssue(issueCid);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Failed: ${err.message}`;
  }
}

// Re-fetch by CID (bitswap if a stranger's node serves it) and verify the
// signature before showing anything — the issue equivalent of "verify then
// trust". Renders the thread into the detail panel.
async function openIssue(cid) {
  const statusEl = document.getElementById('issue-status');
  const detailEl = document.getElementById('issue-detail');
  const bodyEl = document.getElementById('issue-detail-body');
  if (!statusEl || !heliaNode) return;
  currentIssueCid = cid;
  const pinCmd = document.getElementById('issue-pin-cmd');
  if (pinCmd) pinCmd.textContent = `ipfs pin add ${cid}`;
  statusEl.textContent = `Fetching ${cid}…`;
  if (detailEl) detailEl.style.display = 'block';
  if (bodyEl) bodyEl.innerHTML = '';
  try {
    const { ok, signed, signer } = await verifyNote(await getDagJson(CID.parse(cid)));
    if (!ok) {
      statusEl.textContent = `✗ signature INVALID for ${cid}`;
      return;
    }
    statusEl.textContent = '';
    if (bodyEl) {
      const h = document.createElement('h4');
      h.style.marginTop = '0';
      h.textContent = signed.title || '(untitled)';
      const meta = document.createElement('div');
      meta.className = 'f6 color-fg-muted';
      meta.style.wordBreak = 'break-all';
      meta.textContent = `✓ ${signer} · ${signed.timestamp} · ${cid}`;
      const body = document.createElement('p');
      body.textContent = signed.body || '';
      bodyEl.appendChild(h);
      bodyEl.appendChild(meta);
      if (signed.body) {
        // Network content renders in a sandboxed iframe (no origin
        // access even if sanitization missed something).
        bodyEl.appendChild(sandboxedFrame(sanitizeMarkdownHtml(signed.body), { title: 'issue body' }));
      }
      if (Array.isArray(signed.anchors) && signed.anchors.length > 0) {
        const anchLabel = document.createElement('div');
        anchLabel.className = 'f6 color-fg-muted';
        anchLabel.style.marginTop = '0.4rem';
        anchLabel.textContent = 'Anchored to (the note does not change this CID):';
        const anch = document.createElement('pre');
        anch.style.margin = '0.2rem 0 0 0';
        const anchCode = document.createElement('code');
        anchCode.textContent = `ipfs pin add ${signed.anchors[0]}`;
        anch.appendChild(anchCode);
        bodyEl.appendChild(anchLabel);
        bodyEl.appendChild(anch);
      }
    }
    // Comment chain: fetch each locally-known comment CID, verify, render.
    const commentCids = (loadCommentIndex()[cid] || []).slice().reverse();
    for (const ccid of commentCids) {
      try {
        const c = await verifyNote(await getDagJson(CID.parse(ccid)));
        const div = document.createElement('div');
        div.style.cssText = 'margin-top: 0.5rem; padding-left: 0.75rem; border-left: 2px solid var(--color-border-muted);';
        const cmeta = document.createElement('div');
        cmeta.className = 'f6';
        cmeta.style.color = c.ok ? 'var(--color-fg-muted)' : 'var(--fgColor-danger, #cf222e)';
        cmeta.style.wordBreak = 'break-all';
        cmeta.textContent = `${c.ok ? '✓' : '✗ invalid'} ${c.signer} · ${c.signed.timestamp}`;
        const cbody = document.createElement('div');
        cbody.textContent = c.signed.body || '';
        div.appendChild(cmeta);
        if (c.signed.body) {
          div.appendChild(sandboxedFrame(sanitizeMarkdownHtml(c.signed.body), { title: 'issue comment' }));
        } else {
          div.appendChild(cbody);
        }
        if (bodyEl) bodyEl.appendChild(div);
      } catch {
        const div = document.createElement('div');
        div.className = 'f6 color-fg-muted';
        div.textContent = `${ccid} — unavailable (no provider)`;
        if (bodyEl) bodyEl.appendChild(div);
      }
    }
    const index = loadCommentIndex();
    if (bodyEl && (index[cid] || []).length === 0) {
      const none = document.createElement('div');
      none.className = 'f6 color-fg-muted';
      none.style.marginTop = '0.5rem';
      none.textContent = '(no comments yet — comments from other browsers arrive with the index, phase 4)';
      bodyEl.appendChild(none);
    }
  } catch (err) {
    statusEl.textContent = `Fetch failed: ${err.message} — no provider online? Pin the CID or keep a tab open.`;
  }
}

const issueCreateBtn = document.getElementById('btn-issue-create');
if (issueCreateBtn) issueCreateBtn.addEventListener('click', createIssue);
// Phase 3: from the file tree, route to the issues view with the anchor
// prefilled — the note is attached to that exact CID, non-invasively.
const issueOnFileBtn = document.getElementById('btn-issue-on-file');
if (issueOnFileBtn) {
  issueOnFileBtn.addEventListener('click', () => {
    if (!selectedFileCid) return;
    pendingIssueAnchor = { cid: selectedFileCid, name: selectedFileName };
    const statusEl = document.getElementById('issue-status');
    if (statusEl) {
      statusEl.textContent = `Anchored to ${selectedFileName} (${selectedFileCid}) — describe the issue`;
    }
    window.location.hash = '/issues';
    activateTab('issues');
    const titleEl = document.getElementById('issue-title');
    if (titleEl) titleEl.focus();
  });
}
const issueReplyBtn = document.getElementById('btn-issue-reply');
if (issueReplyBtn) {
  issueReplyBtn.addEventListener('click', () => {
    const replyEl = document.getElementById('issue-reply');
    const body = (replyEl?.value || '').trim();
    if (!body || !currentIssueCid) return;
    createComment(currentIssueCid, body);
  });
}
renderIssues();
renderChainStatus();
// Phase 10: adopt a winning remote index tip (cross-surface issues).
// Runs once the Helia node is up; resolves quietly when offline.
const syncIndexWhenReady = setInterval(() => {
  if (window.__heliaNode) {
    clearInterval(syncIndexWhenReady);
    syncIndexFromIpns();
  }
}, 2000);

// DESIGN IDIOM — single-click copy (keep this pattern; see the matching
// block in index.html's CSS): EVERY command displayed anywhere on the page
// copies with one click, and the WHOLE surrounding box is the target — any
// <pre><code> block or kubo chip, current or added later, is covered by
// this one delegated listener. The inner code element flashes confirmation
// so styling and live updates (real CIDs, never placeholders) survive.
document.addEventListener('click', (e) => {
  const el = e.target.closest('pre:has(> code), code.kubo-chip');
  if (!el) return;
  const v = el.textContent.trim();
  if (!v || v.includes('Copied to clipboard')) return;
  const flashTarget = el.tagName === 'PRE' ? (el.querySelector('code') || el) : el;
  if (!el.title) el.title = 'Click to copy';
  const done = () => {
    const orig = flashTarget.textContent;
    flashTarget.textContent = 'Copied to clipboard';
    setTimeout(() => { if (flashTarget.textContent === 'Copied to clipboard') flashTarget.textContent = orig; }, 900);
  };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(v).then(done).catch(done);
  } else {
    done();
  }
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

// Clone help modal (Files → Clone card "?" top right)
const cloneHelpModal = document.getElementById('clone-help-modal');
const cloneHelpBtn = document.getElementById('btn-clone-help');
if (cloneHelpModal && cloneHelpBtn) {
  cloneHelpBtn.addEventListener('click', () => {
    cloneHelpModal.hidden = false;
  });
  const closeBtn = document.getElementById('btn-close-clone-help');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      cloneHelpModal.hidden = true;
    });
  }
  cloneHelpModal.addEventListener('click', (e) => {
    if (e.target === cloneHelpModal) cloneHelpModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !cloneHelpModal.hidden) cloneHelpModal.hidden = true;
  });
}

initHelia();