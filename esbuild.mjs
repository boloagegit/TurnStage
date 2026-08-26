import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = !watch;
const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info', loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]' };
const builds = [
  { ...common, entryPoints: ['src/extension/activate.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', mainFields: ['module', 'main'], external: ['vscode'], target: 'node20' },
  { ...common, entryPoints: ['src/webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' },
  { ...common, entryPoints: ['test/integration/suite/index.ts'], outfile: 'dist/test/index.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20', minify: false }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
