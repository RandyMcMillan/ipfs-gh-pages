import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function detectIpfs() {
  try {
    execSync('ipfs version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function requireIpfs() {
  if (!detectIpfs()) {
    console.error('ipfs command not found. Make sure Kubo is installed and in your PATH.');
    console.error('Install: https://docs.ipfs.tech/install/ipfs-desktop/');
    process.exit(1);
  }
}

export function readConfig() {
  const out = execSync('ipfs config show --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out);
}

export function writeConfig(config) {
  const tmpFile = path.join(os.tmpdir(), `kubo-config-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
  try {
    execSync(`ipfs config replace "${tmpFile}"`, { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

export function hasSwarmAddress(config, addr) {
  const swarm = config?.Addresses?.Swarm || [];
  return swarm.includes(addr);
}

export function addSwarmAddress(config, addr) {
  if (!config.Addresses) config.Addresses = {};
  if (!config.Addresses.Swarm) config.Addresses.Swarm = [];
  if (!config.Addresses.Swarm.includes(addr)) {
    config.Addresses.Swarm.push(addr);
    return true;
  }
  return false;
}
