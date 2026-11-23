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
  build: {
    target: 'es2022',
  },
});
