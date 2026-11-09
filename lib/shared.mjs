export function formatSize(bytes) {
  if (bytes == null) return '';
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function buildRepoTree(paths) {
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

export function isBrowserDialable(addr) {
  return addr.includes('/ws') || addr.includes('/wss') || addr.includes('/webrtc') || addr.includes('/webtransport');
}

export function normalizeAddressForProxy(addr, proxyPort) {
  // Replace /tcp/4002/ws with /tcp/<proxyPort>/wss for LAN use behind the local TLS proxy
  return addr.replace(/\/tcp\/\d+\/ws$/, `/tcp/${proxyPort}/wss`);
}
