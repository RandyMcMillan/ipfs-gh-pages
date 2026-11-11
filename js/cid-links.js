// CID linkification (docs/ipfs-uri-providers.md steps 3–4): pure helpers
// for finding CIDs in text and building the affordance model shown in the
// per-CID popover. DOM-free and unit-tested; main.js owns the rendering.

// CIDv1 base32 (baf…/bag…) and CIDv0 base58 (Qm…). Peer IDs (12D3Koo…)
// are deliberately NOT matched — they are not content addresses.
export const CID_RE = /\b(?:baf|bag)[a-z2-7]{20,}\b|\bQm[1-9A-HJ-NP-Za-km-z]{20,}\b/g;

// All CID-shaped tokens in a text, with offsets: [{ start, end, cid }].
export function findCidTokens(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const m of text.matchAll(CID_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, cid: m[0] });
  }
  return out;
}

// The affordance model for one CID (docs/ipfs-uri-providers.md §2):
// gateway / ipfs:// links, the local pin command, and one
// `ipfs swarm connect` command per provider address. Full values only.
export function cidAffordanceModel(cid, providers = []) {
  return {
    cid,
    ipfsUri: `ipfs://${cid}`,
    gatewayUrl: `https://ipfs.io/ipfs/${cid}`,
    subdomainUrl: `https://${cid}.ipfs.dweb.link`,
    pinCmd: `ipfs pin add ${cid}`,
    providers,
    swarmConnects: providers.flatMap((p) =>
      (p.Addrs || []).map((addr) => ({ id: p.ID, cmd: `ipfs swarm connect '${addr}'` }))
    )
  };
}
