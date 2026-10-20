import { createHelia } from 'helia';
import { strings } from '@helia/strings';
import { CID } from 'multiformats/cid';

let heliaNode = null;
let heliaStrings = null;

const statusEl = document.getElementById('node-status');
const peerIdEl = document.getElementById('peer-id');
const publishBtn = document.getElementById('btn-publish');
const fetchBtn = document.getElementById('btn-fetch');
const inputContent = document.getElementById('input-content');
const outputCid = document.getElementById('output-cid');
const inputCid = document.getElementById('input-cid');
const outputContent = document.getElementById('output-content');

async function initHelia() {
  try {
    // Spawn an in-browser IPFS node
    heliaNode = await createHelia();
    heliaStrings = strings(heliaNode);

    const peerId = heliaNode.libp2p.peerId.toString();
    
    statusEl.textContent = 'Online & Connected to Peer-to-Peer Network';
    peerIdEl.textContent = peerId;

    publishBtn.disabled = false;
    fetchBtn.disabled = false;
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

// Fetch IPFS content from any peer across the network using CID
fetchBtn.addEventListener('click', async () => {
  const cidStr = inputCid.value.trim();
  if (!cidStr) return;

  fetchBtn.disabled = true;
  outputContent.textContent = 'Resolving blocks from IPFS network...';

  try {
    const cid = CID.parse(cidStr);
    const content = await heliaStrings.get(cid);
    outputContent.textContent = content;
  } catch (err) {
    outputContent.textContent = `Error retrieving CID: ${err.message}`;
  } finally {
    fetchBtn.disabled = false;
  }
});

initHelia();