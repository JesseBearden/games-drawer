/**
 * Build a release bundle: everything the server needs, with no npm install on the box.
 *
 *   npm run release            -> release/ (run it with: node release/server.mjs)
 *   npm run release -- --tar   -> also release.tar.gz, which CI uploads for deploys
 *
 * Layout:
 *   server.mjs          the game server, bundled with its dependencies
 *   client/             the built web client
 *   client-hashes.json  each client file's fingerprint (its ETag)
 *   blocklist.txt       extra chat filter words
 *   deploy/             setup.sh, rollout.mjs and config templates used on the server
 *   RELEASE             the git commit this was built from
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeFingerprints } from '../packages/server/src/static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const tar = process.argv.includes('--tar');

function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const release = gitCommit();
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'deploy'), { recursive: true });

console.log('Building the client…');
execSync('npx vite build --config packages/client/vite.config.ts --logLevel warn', { cwd: root, stdio: 'inherit' });
fs.cpSync(path.join(root, 'packages/client/dist'), path.join(out, 'client'), { recursive: true });
// The page's security header only lets in fonts that are files of the site's own (font-src 'self'
// in static.ts). One folded into the CSS as a data: address would be refused by every browser.
for (const f of fs.readdirSync(path.join(out, 'client/assets'))) {
  if (f.endsWith('.css') && /url\(["']?data:font/.test(fs.readFileSync(path.join(out, 'client/assets', f), 'utf8'))) {
    throw new Error(`${f} has a font folded into it as a data: address, which the page's security header blocks. See assetsInlineLimit in packages/client/vite.config.ts.`);
  }
}

writeFingerprints(path.join(out, 'client'));

// ws and other CommonJS packages call require(); give the ES module bundle one.
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: banner }, logLevel: 'warning', legalComments: 'none' } as const;

console.log('Bundling the server…');
await build({
  ...common,
  entryPoints: [path.join(root, 'packages/server/src/main.ts')],
  outfile: path.join(out, 'server.mjs'),
  // Optional native speed-ups for ws; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
});
await build({ ...common, entryPoints: [path.join(root, 'deploy/rollout.ts')], outfile: path.join(out, 'deploy/rollout.mjs') });

fs.copyFileSync(path.join(root, 'packages/server/blocklist.txt'), path.join(out, 'blocklist.txt'));
for (const f of ['setup.sh', 'turnserver.conf', 'relay-firewall.sh', 'Caddyfile.cloudfront', 'Caddyfile.direct', 'games-drawer@.service', 'games-drawer-deploy']) {
  fs.copyFileSync(path.join(root, 'deploy', f), path.join(out, 'deploy', f));
}
fs.writeFileSync(path.join(out, 'RELEASE'), release + '\n');

if (tar) {
  const file = path.join(root, 'release.tar.gz');
  fs.rmSync(file, { force: true });
  // Relative paths: on Windows, GNU tar takes the "C:" of a full path for a remote machine.
  execFileSync('tar', ['-czf', path.relative(root, file), '-C', path.relative(root, out), '.'], { cwd: root, stdio: 'inherit' });
  console.log(`Wrote release.tar.gz (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
}
console.log(`Release ${release.slice(0, 7)} is in release/`);
