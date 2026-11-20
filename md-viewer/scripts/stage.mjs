import fs from 'node:fs/promises';
import path from 'node:path';
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
await fs.copyFile('build/icon.ico', 'dist-electron/icon.ico');
await fs.mkdir('app', { recursive: true });
for (const entry of ['dist', 'dist-electron', 'THIRD-PARTY-NOTICES.txt', 'LICENSE']) {
  const target = path.resolve('app', entry);
  if (!target.startsWith(path.resolve('app') + path.sep)) throw new Error('Invalid staging path');
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(entry, `app/${entry}`, { recursive: true, force: true });
}
const { name, version, description, author, license, type, main } = pkg;
await fs.writeFile('app/package.json', JSON.stringify({ name, version, description, author, license, type, main }, null, 2));
