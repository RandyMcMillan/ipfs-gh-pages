import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CERT_DIR = process.env.KUBO_CERT_DIR || path.join(process.cwd(), 'certs');
const CERT_FILE = process.env.KUBO_CERT_FILE || path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = process.env.KUBO_KEY_FILE || path.join(CERT_DIR, 'key.pem');
const DAYS = parseInt(process.env.CERT_DAYS || '365', 10);
const COMMON_NAME = process.env.CERT_CN || 'kubo-local';

const sans = ['DNS:localhost', 'IP:127.0.0.1'];
if (process.env.CERT_SANS) {
  for (const entry of process.env.CERT_SANS.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.includes(':')) {
      sans.push(trimmed);
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed) || /^[0-9a-fA-F:]+$/.test(trimmed)) {
      sans.push(`IP:${trimmed}`);
    } else {
      sans.push(`DNS:${trimmed}`);
    }
  }
}

fs.mkdirSync(CERT_DIR, { recursive: true });

const configPath = path.join(CERT_DIR, 'openssl.cnf');
const cnf = [
  '[req]',
  'distinguished_name = req_distinguished_name',
  'x509_extensions = v3_req',
  'prompt = no',
  '',
  '[req_distinguished_name]',
  `CN = ${COMMON_NAME}`,
  '',
  '[v3_req]',
  'keyUsage = keyEncipherment, dataEncipherment',
  'extendedKeyUsage = serverAuth',
  `subjectAltName = ${sans.join(',')}`
].join('\n');

fs.writeFileSync(configPath, cnf);

try {
  execSync('openssl version', { stdio: 'ignore' });
} catch {
  console.error('openssl is required but not found in PATH.');
  process.exit(1);
}

console.log('Generating self-signed certificate...');
console.log('Certificate:', CERT_FILE);
console.log('Key:', KEY_FILE);
console.log('SANs:', sans.join(', '));

execSync(
  `openssl req -x509 -nodes -days ${DAYS} -newkey rsa:2048 ` +
  `-keyout "${KEY_FILE}" -out "${CERT_FILE}" -config "${configPath}"`,
  { stdio: 'inherit' }
);

console.log('Done.');
console.log('To include an IP like 192.168.1.74, run:');
console.log('  CERT_SANS=192.168.1.74 npm run cert:generate');
