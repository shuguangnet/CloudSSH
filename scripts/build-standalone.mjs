import { build } from 'esbuild';
import { resolve } from 'node:path';

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
