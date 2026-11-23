import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// HTTPS=1 (npm run dev:https) serves over https with a self-signed certificate, because
// phones only allow microphone access (voice chat) on secure pages.
const https = process.env.HTTPS === '1';

export default defineConfig({
  root: here,
  plugins: https ? [basicSsl({ name: 'tank-you-dev' })] : [],
  server: {
    // Listen on the LAN so a phone on the same Wi-Fi can join.
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/stats': { target: 'http://localhost:8787' },
      '/admin': { target: 'http://localhost:8787' },
      '/api': { target: 'http://localhost:8787' },
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
    // Fonts always stay files. Vite folds small files into the CSS as data: addresses, and the
    // page's own security header (font-src 'self', static.ts) refuses a font that arrives that way.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // The chat filter's word lists get their own file, so it stays cached through game
              // updates and only downloads again when the lists themselves change.
              name: 'chat-filter',
              test: /[\\/]node_modules[\\/]obscenity[\\/]|[\\/]shared[\\/]src[\\/]chatFilter\.ts$/,
              // Only those: the small files it uses are the first page's too, which would then
              // fetch the word lists with them.
              includeDependenciesRecursively: false,
            },
            // What names and the filter share, on its own, so an update doesn't rename the filter's file.
            { name: 'look-alike', test: /[\\/]shared[\\/]src[\\/](lookAlike|chatModes)\.ts$/ },
          ],
        },
      },
    },
  },
});
