import fs from 'node:fs';
import path from 'node:path';
const visited = new Set();
const blocks = ['墨阅 - 第三方组件许可\n由 scripts/licenses.mjs 从已锁定的生产依赖生成。\n'];
function visit(name, from = process.cwd()) {
  let root = from, dir;
  while (true) {
    const candidate = path.join(root, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) { dir = candidate; break; }
    const parent = path.dirname(root); if (parent === root) return; root = parent;
  }
  if (visited.has(dir)) return; visited.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter(f => /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
  blocks.push(`\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${JSON.stringify(pkg.license || 'See package repository')}\nRepository: ${JSON.stringify(pkg.repository || pkg.homepage || '')}\n`);
  for (const file of files) blocks.push(`${file}\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n`);
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir);
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.viewerLibraries.forEach(name => visit(name));
blocks.push('\nElectron includes Chromium and Node.js. The distribution includes LICENSE.electron.txt and LICENSES.chromium.html.\n');
fs.writeFileSync('THIRD-PARTY-NOTICES.txt', blocks.join('\n'));
console.log(`Generated third-party notices for ${visited.size} packages.`);
