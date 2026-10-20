import { defineConfig } from 'vite';

export default defineConfig({
  // Base relative path ensures assets resolve correctly on GitHub Pages
  base: './',
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext'
    }
  }
});