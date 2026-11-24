import { defineConfig } from 'vite';

const buildId = Date.now().toString(36);

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 4173,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // In-browser clang (custom bots): it locates its ~100 MB of wasm / sysroot next to its own module via
    // `new URL('./…', import.meta.url)`, which dependency pre-bundling would break.
    exclude: ['@yowasp/clang'],
  },
  build: {
    target: 'es2022',
  },
});
