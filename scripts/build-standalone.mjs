import { build } from 'esbuild';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

await build({
  entryPoints: ['standalone/worker-entry.ts'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  plugins: [{
    name: 'node-tcp',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
        path: resolve('standalone/sockets.mjs'),
      }));
    },
  }],
});

await build({
  entryPoints: ['standalone/account-entry.ts'], outfile: 'dist/account.js',
  bundle: true, platform: 'browser', target: 'es2022', format: 'iife', minify: true,
});

// PWA assets (manifest, service worker, icons) are served straight from disk by
// standalone/server.mjs; the worker bundle only inlines the app shell.
const publicSource = resolve('frontend/public');
const publicTarget = resolve('dist/public');
mkdirSync(publicTarget, { recursive: true });
mkdirSync(join(publicTarget, 'icons'), { recursive: true });
for (const file of ['manifest.webmanifest', 'sw.js', 'favicon.svg']) {
  copyFileSync(join(publicSource, file), join(publicTarget, file));
}
for (const file of readdirSync(join(publicSource, 'icons'))) {
  if (file.endsWith('.png')) copyFileSync(join(publicSource, 'icons', file), join(publicTarget, 'icons', file));
}
