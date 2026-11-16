import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  server: {
    // Listen on the LAN so a phone on the same Wi-Fi can join.
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/stats': { target: 'http://localhost:8787' },
    },
  },
  preview: {
    host: true,
    port: 4173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
});
