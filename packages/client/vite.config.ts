import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Puzzle pictures that live only on this computer (the git-ignored local-puzzles folder at the
 * top of the repo; see .gitignore). The dev server serves them at /puzzles/local/; a build never
 * includes them, so they can't reach the hosted site.
 */
function localPuzzles(): Plugin {
  const dir = path.resolve(here, '../../local-puzzles');
  const types: Record<string, string> = { '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  return {
    name: 'local-puzzles',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/puzzles/local', (req, res) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        const file = path.resolve(dir, rel);
        const type = types[path.extname(file)];
        if (!type || !file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', type);
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// HTTPS=1 (npm run dev:https) serves over https with a self-signed certificate, because
// phones only allow microphone access (voice chat) on secure pages.
const https = process.env.HTTPS === '1';

export default defineConfig({
  root: here,
  plugins: [localPuzzles(), ...(https ? [basicSsl({ name: 'tank-you-dev' })] : [])],
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
            },
          ],
        },
      },
    },
  },
});
