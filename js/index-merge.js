// Pure index-sync decision (docs/issues-car.md chronology): given the
// local tip, a remote tip, and descendancy facts, decide the merge action.
// Shared by main.js and js/ipfs-node.js so both surfaces resolve forks
// identically; unit-tested in tests/index-merge.test.mjs.

// local/remote: { cid, height, lamport } | null (null = genesis).
// remoteDescendsLocal / localDescendsRemote: booleans from the prev-walk.
// Returns { action: 'adopt-remote' | 'noop' | 'merge', height, lamport } —
// 'merge' carries the heights/lamports to build a two-parent entry with.
export function classifyIndexSync(local, remote, remoteDescendsLocal, localDescendsRemote) {
  if (!local) {
    return { action: 'adopt-remote', height: remote.height, lamport: remote.lamport };
  }
  if (remoteDescendsLocal) {
    return { action: 'adopt-remote', height: remote.height, lamport: remote.lamport };
  }
  if (localDescendsRemote) {
    return { action: 'noop' };
  }
  const height = Math.max(local.height || 0, remote.height || 0) + 1;
  const lamport = Math.max(local.lamport || 0, remote.lamport || 0) + 1;
  return { action: 'merge', height, lamport };
}
