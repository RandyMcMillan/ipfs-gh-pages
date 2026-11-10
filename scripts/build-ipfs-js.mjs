// Bundles js/ipfs-node.js into a single browser ESM file that trunk copies
// into dist (via the copy-file link in index-rust.html) and index-rust.html
// loads as a module. Produces assets/ipfs-node.js.

import { build } from 'esbuild';

await build({
  entryPoints: ['js/ipfs-node.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  mainFields: ['browser', 'module', 'main'],
  sourcemap: false,
  outfile: 'assets/ipfs-node.js',
  logLevel: 'info'
});
