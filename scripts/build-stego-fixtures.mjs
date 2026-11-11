// Builds the stego attack-vector fixtures (tests/fixtures/stego/) from the
// pinned gnostr.svg (the interop vector, tests/fixtures/interop-vectors.json),
// implementing the three PoC techniques from the owner's gists (STATUS.md
// "Backlog — potential attack vectors"):
//
//   1. feColorMatrix  — bytes as 3-decimal coefficients (gist 55e56ac5…)
//   2. phantom polyline — bytes in coordinate decimal places (gist 7b7b0de0…)
//   3. PPM LSB — bytes in the blue channel's low bit (gist 524a2d81…)
//
// Run: node scripts/build-stego-fixtures.mjs   (fixtures are committed;
// tests/stego-fixtures.test.mjs decodes them back and asserts the payloads.)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'stego');
const CLEAN = path.join(OUT, 'gnostr-clean.svg');

const readClean = () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'interop-vectors.json'), 'utf8'));
  return vectors.find((v) => v.name === 'gnostr.svg');
};

const PAYLOADS = {
  matrix: 'gnostr-stego-matrix',
  phantom: 'gnostr-stego-phantom',
  lsb: 'gnostr-stego-lsb'
};

// ---- technique 1: feColorMatrix coefficients (bytes as value/1000) ----
function matrixStego(svg, payload) {
  const slots = [];
  for (const byte of Buffer.from(payload, 'utf8')) slots.push((byte / 1000).toFixed(3));
  while (slots.length < 20) slots.push('0');
  const filter = `<defs><filter id="stegoFilter"><feColorMatrix type="matrix" values='${slots.join(' ')}' /></filter></defs>`;
  const carrier = `<rect x='0' y='0' width='1024' height='1024' fill='none' filter='url(#stegoFilter)' />`;
  return svg.replace(/(<svg[^>]*>)/, `$1\n${filter}`).replace('</svg>', `${carrier}\n</svg>`);
}

// ---- technique 2: phantom polyline (bytes in coordinate decimals) ----
function phantomStego(svg, payload) {
  const points = [...Buffer.from(payload, 'utf8')].map((byte, i) => `${i * 5}.${String(byte).padStart(3, '0')},${i * 2}`).join(' ');
  const poly = `<polyline points='${points}' fill='none' stroke='none' pointer-events='none' />`;
  return svg.replace('</svg>', `${poly}\n</svg>`);
}

// ---- PNG decode (8-bit RGBA non-interlaced — what rsvg-convert emits) ----
function decodePng(buf) {
  let pos = 8; // skip signature
  const idat = [];
  let width = 0;
  let height = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA non-interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, rgba: out };
}

// ---- technique 3: PPM with blue-channel LSB payload ----
function lsbPpm(png, payload) {
  const { width, height, rgba } = png;
  const bits = [...Buffer.from(payload, 'utf8')].flatMap((byte) =>
    [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >> shift) & 1)
  );
  const ppm = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const withPayload = i < bits.length ? (b & 0xfe) | bits[i] : b;
    ppm[i * 3] = r;
    ppm[i * 3 + 1] = g;
    ppm[i * 3 + 2] = withPayload;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), ppm]);
}

const vector = readClean();
const clean = fs.readFileSync(CLEAN, 'utf8');
fs.mkdirSync(OUT, { recursive: true });

// provenance check: the committed clean copy must BE the pinned vector
import('multiformats/hashes/sha2').then(async ({ sha256 }) => {
  const { CID } = await import('multiformats/cid');
  const digest = await sha256.digest(fs.readFileSync(CLEAN));
  const cid = CID.create(1, 0x55, digest).toString();
  if (cid !== vector.cid) throw new Error(`clean carrier mismatch: ${cid} != ${vector.cid}`);

  fs.writeFileSync(path.join(OUT, 'gnostr-matrix-stego.svg'), matrixStego(clean, PAYLOADS.matrix));
  fs.writeFileSync(path.join(OUT, 'gnostr-phantom-stego.svg'), phantomStego(clean, PAYLOADS.phantom));

  const pngPath = path.join(OUT, '.gnostr-raster.png');
  execFileSync('rsvg-convert', ['-w', '64', '-h', '64', CLEAN, '-o', pngPath]);
  const png = decodePng(fs.readFileSync(pngPath));
  fs.writeFileSync(path.join(OUT, 'gnostr-lsb.ppm'), lsbPpm(png, PAYLOADS.lsb));
  fs.rmSync(pngPath, { force: true });

  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify({
    carrier: { name: vector.name, cid: vector.cid, sha256: vector.sha256, file: 'gnostr-clean.svg' },
    fixtures: [
      { file: 'gnostr-matrix-stego.svg', technique: 'svg-feColorMatrix-coefficients', payload: PAYLOADS.matrix, gist: 'https://gist.github.com/RandyMcMillan/55e56ac549b4c31ac16ce7f7c7d381bd' },
      { file: 'gnostr-phantom-stego.svg', technique: 'svg-phantom-polyline-decimals', payload: PAYLOADS.phantom, gist: 'https://gist.github.com/RandyMcMillan/7b7b0de098cd26a341fc4a7390d22254' },
      { file: 'gnostr-lsb.ppm', technique: 'ppm-blue-channel-lsb', payload: PAYLOADS.lsb, gist: 'https://gist.github.com/RandyMcMillan/524a2d81ee8f0df35fcf2b08f0e1222c', raster: 'rsvg-convert 64x64 of the carrier' }
    ]
  }, null, 2)}\n`);
  console.log('stego fixtures written to', OUT);
});
