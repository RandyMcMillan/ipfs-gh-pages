// Filebase IPFS pinning — dependency-free AWS Signature Version 4 PUT of
// the CAR to Filebase's S3-compatible endpoint (https://s3.filebase.io,
// region 'auto'). Uploading a .car pins its roots to Filebase's IPFS
// network; the CID comes back in the x-amz-meta-cid response header.
// Used by the action when the consumer wires the filebase-* inputs.
//
// Env: FILEBASE_ACCESS_KEY_ID, FILEBASE_SECRET_ACCESS_KEY, FILEBASE_BUCKET
//      (required — never printed, never logged). Filebase's terms:
//      accessKeyId / secretAccessKey from the dashboard's Access Keys.
//      FILEBASE_ENDPOINT (default https://s3.filebase.io)
//      FILEBASE_REGION   (default auto)
// Usage: node scripts/filebase-pin.mjs <file> [name]
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FILEBASE_ENDPOINT = 'https://s3.filebase.io';
export const FILEBASE_REGION = 'auto';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmacSha256 = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 URI-encode: encodeURIComponent keeps ! ~ * ' ( ), SigV4 needs
// every reserved byte percent-encoded (unreserved = A-Z a-z 0-9 - _ . ~).
const rfc3986 = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Sign one request with AWS Signature Version 4 (single payload hash, no
// chunked encoding). `date` is injectable so tests can pin a vector.
export function sigV4Sign({ method, host, path: rawPath, query = {}, headers = {}, payload = '', service, region, accessKeyId, secretAccessKey, date = new Date() }) {
  const pad = (n) => String(n).padStart(2, '0');
  const amzdate = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const datestamp = amzdate.slice(0, 8);
  const canonicalUri = String(rawPath).split('/').map(rfc3986).join('/');
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join('&');
  const all = { host, 'x-amz-date': amzdate, ...headers };
  const signed = Object.keys(all).map((n) => n.toLowerCase()).sort();
  // Canonical header values: trim + squeeze sequential whitespace.
  const canonicalHeaders = signed.map((n) => `${n}:${String(all[Object.keys(all).find((k) => k.toLowerCase() === n)]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const payloadHash = sha256hex(payload);
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signed.join(';'), payloadHash].join('\n');
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmacSha256(`AWS4${secretAccessKey}`, datestamp);
  for (const part of [region, service, 'aws4_request']) k = hmacSha256(k, part);
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');
  return {
    amzdate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`
  };
}

// Upload one file to a Filebase bucket (S3 PUT, SigV4). fetchImpl is
// injectable for tests. Throws on missing credentials / HTTP error — error
// text carries the status and Filebase's body snippet, never the keys.
export async function filebaseUpload({ file, bucket, name, key, secret, region = FILEBASE_REGION, endpoint = FILEBASE_ENDPOINT, fetchImpl = fetch }) {
  if (!key) throw new Error('FILEBASE_ACCESS_KEY_ID is not set');
  if (!secret) throw new Error('FILEBASE_SECRET_ACCESS_KEY is not set');
  if (!bucket) throw new Error('FILEBASE_BUCKET is not set');
  const bytes = fs.readFileSync(file);
  const objectKey = String(name || path.basename(file)).split('/').map(rfc3986).join('/');
  const url = new URL(`/${rfc3986(bucket)}/${objectKey}`, endpoint);
  const payloadHash = sha256hex(bytes);
  const signed = sigV4Sign({
    method: 'PUT',
    host: url.host,
    path: url.pathname,
    headers: { 'x-amz-content-sha256': payloadHash },
    payload: bytes,
    service: 's3',
    region,
    accessKeyId: key,
    secretAccessKey: secret
  });
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'X-Amz-Date': signed.amzdate,
      'X-Amz-Content-Sha256': payloadHash,
      Authorization: signed.authorization
    },
    body: bytes
  });
  if (!res.ok) {
    const text = await res.text();
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
    // accessKeyId + bucket are identifiers, not secrets — they make a 403
    // debuggable against the Filebase dashboard.
    throw new Error(`filebase upload HTTP ${res.status}${code ? ` ${code}` : ''} (bucket "${bucket}", accessKeyId "${key}")${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  // Filebase returns the pinned IPFS CID for CAR uploads; ETag is the
  // fallback for plain objects.
  const cid = res.headers.get('x-amz-meta-cid') || (res.headers.get('etag') || '').replace(/"/g, '') || null;
  return { cid, status: res.status };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [file, name] = process.argv.slice(2);
  if (!file || !fs.existsSync(file)) {
    console.error(`filebase-pin: file not found: ${file || '(none given)'}`);
    process.exit(1);
  }
  try {
    const out = await filebaseUpload({
      file,
      name,
      bucket: process.env.FILEBASE_BUCKET,
      key: process.env.FILEBASE_ACCESS_KEY_ID,
      secret: process.env.FILEBASE_SECRET_ACCESS_KEY,
      region: process.env.FILEBASE_REGION || FILEBASE_REGION,
      endpoint: process.env.FILEBASE_ENDPOINT || FILEBASE_ENDPOINT
    });
    console.log(`filebase-pin: pinned ${out.cid || '(no CID header)'} (${path.basename(file)} -> ${process.env.FILEBASE_BUCKET})`);
    if (out.cid) console.log(`filebase-pin: CAR roots are live at https://<your-gateway>/ipfs/${out.cid}`);
  } catch (e) {
    console.error(`filebase-pin: ${e.message}`);
    process.exit(1);
  }
}
