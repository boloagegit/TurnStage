import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { zipSync } from 'fflate';

const repository = resolve(import.meta.dirname, '..');
const output = resolve(repository, 'web-dist');
const packageJson = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
const files = await collect(output);
const documentation = ['web-deployment.md', 'web-user-guide.md'];
const archive = Object.fromEntries(await Promise.all([
  ...files.map(async (path) => [relative(output, path).replaceAll('\\', '/'), new Uint8Array(await readFile(path))]),
  ...documentation.map(async (name) => [`docs/${name}`, new Uint8Array(await readFile(resolve(repository, 'docs', name)))]),
]));
const target = resolve(repository, `turnstage-web-${packageJson.version}.zip`);
await writeFile(target, zipSync(archive, { level: 9 }));
console.log(`Created ${relative(repository, target)} with ${Object.keys(archive).length} files.`);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? collect(path) : [path];
  }))).flat();
}
