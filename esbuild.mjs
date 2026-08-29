import esbuild from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = !watch;
const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info', loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]' };
const builds = [
  { ...common, entryPoints: ['src/extension/activate.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', mainFields: ['module', 'main'], external: ['vscode'], target: 'node20' },
  { ...common, entryPoints: ['src/webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' },
  { ...common, entryPoints: ['test/integration/suite/index.ts'], outfile: 'dist/test/index.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20', minify: false },
  { ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', platform: 'node', format: 'cjs', mainFields: ['module', 'main'], target: 'node20', define: { __TURNSTAGE_VERSION__: JSON.stringify(packageJson.version) }, banner: { js: '#!/usr/bin/env node' } }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await chmod('dist/cli.js', 0o755);
}
