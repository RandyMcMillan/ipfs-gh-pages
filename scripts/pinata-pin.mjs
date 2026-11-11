// Pinata public-IPFS upload — dependency-free (native fetch/FormData/Blob).
// Used by the action when the consumer wires `pinata-jwt: ${{ secrets.PINATA_JWT }}`:
// the built release CAR goes to Pinata's public network with car=true, so the
// CAR's roots (the repo root CID) are what gets pinned.
//
// Env: PINATA_JWT (required — never printed, never logged).
// Usage: node scripts/pinata-pin.mjs <file> [name] [--car]
import fs from 'node:fs';
import path from 'node:path';

export const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';

// Upload one file to Pinata's public IPFS network.
// fetchImpl is injectable for tests. Throws on missing JWT / HTTP error —
// error text carries the status and Pinata's body snippet (which never
// contains the JWT), never the token itself.
export async function pinataUpload({ file, name, car = false, jwt, fetchImpl = fetch }) {
  if (!jwt) throw new Error('PINATA_JWT is not set');
  const bytes = fs.readFileSync(file);
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', new Blob([bytes]), path.basename(file));
  if (name) form.append('name', name);
  if (car) form.append('car', 'true');
  const res = await fetchImpl(PINATA_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`pinata upload HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2).filter((a) => a !== '--car');
  const car = process.argv.includes('--car');
  const [file, name] = args;
  if (!file || !fs.existsSync(file)) {
    console.error(`pinata-pin: file not found: ${file || '(none given)'}`);
    process.exit(1);
  }
  try {
    const out = await pinataUpload({ file, name, car, jwt: process.env.PINATA_JWT });
    const d = out.data || {};
    console.log(`pinata-pin: pinned ${d.cid} (id ${d.id}, name ${d.name || path.basename(file)})`);
    if (car && d.cid) console.log(`pinata-pin: CAR roots are live at https://<your-gateway>/ipfs/${d.cid}`);
  } catch (e) {
    console.error(`pinata-pin: ${e.message}`);
    process.exit(1);
  }
}
