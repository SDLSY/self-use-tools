import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const run = await fs.mkdtemp(path.join(results, 'run-'));
const fixtures = path.join(run, '中文 空格文档');
await fs.cp(path.join(root, 'samples'), fixtures, { recursive: true });
const sample = path.join(fixtures, '阅读示例.md');
const other = path.join(fixtures, '中文 空格', '另一篇.markdown');
const unsafe = path.join(fixtures, '安全与异常.md');
const profile = path.join(run, 'profile');
const executablePath = process.env.MD_VIEWER_EXE;
const prefix = executablePath ? [] : [root];
const launchArgs = [...prefix, `--user-data-dir=${profile}`, sample];
const report = { runtime: executablePath || 'development Electron', checks: [], errors: [], consoleErrors: [], screenshot: '' };
let application, page;
const waitFor = async (fn, label) => {
  const until = Date.now() + 15000;
  while (Date.now() < until) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timeout: ${label}`);
};
const check = async (name, fn) => { await fn(); report.checks.push(name); console.log(`PASS ${name}`); };
const hash = async p => createHash('sha256').update(await fs.readFile(p)).digest('hex');
const originalHash = await hash(sample);
try {
  application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: launchArgs, timeout: 30000 });
  page = await application.firstWindow();
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  await page.locator('#content h1').waitFor();
  await page.locator('.diagram svg').waitFor();
  await check('中文路径、表格、任务列表、高亮、公式、有效及错误 Mermaid', async () => {
    assert.match(await page.locator('#content h1').textContent(), /墨阅/);
    assert.equal(await page.locator('#content table').count(), 1);
    assert.equal(await page.locator('#content input[type=checkbox]:disabled').count(), 3);
    assert.ok(await page.locator('#content .hljs-keyword').count());
    assert.equal(await page.locator('#content .katex').count(), 2);
    assert.ok(await page.locator('.katex [style]').count());
    assert.equal(await page.locator('.diagram-error').count(), 1);
    assert.ok((await page.locator('.diagram svg').textContent()).includes('打开文件'));
  });
  await check('本地图片及重复标题唯一锚点', async () => {
    await waitFor(() => page.locator('#content img').evaluate(img => img.complete && img.naturalWidth > 0), 'local image');
    assert.equal(await page.locator('#content #md-h-重复标题').count(), 1);
    assert.equal(await page.locator('#content #md-h-重复标题-1').count(), 1);
  });
  await check('搜索数量、下一个、关闭搜索', async () => {
    await page.keyboard.press('Control+f'); await page.locator('#search').fill('标题');
    await waitFor(async () => (await page.locator('#search-count').textContent()).startsWith('1 / '), 'search');
    await page.keyboard.press('Enter'); assert.match(await page.locator('#search-count').textContent(), /^2 \/ /);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#search-bar').isVisible(), false);
  });
  await check('代码复制', async () => {
    const backup = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await page.locator('.copy-code').click();
      await waitFor(async () => (await page.locator('.copy-code').textContent()) === '已复制', 'clipboard copy');
      assert.match(await application.evaluate(({ clipboard }) => clipboard.readText()), /greeting/);
    } finally { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), backup); }
  });
  await check('目录跳转、折叠、字号与深浅主题', async () => {
    await page.locator('#outline button').filter({ hasText: '数学公式' }).click();
    await page.waitForTimeout(500);
    assert.ok(await page.locator('#reader').evaluate(el => el.scrollTop > 0));
    await page.locator('#toc-toggle').click(); assert.equal(await page.locator('#sidebar').isVisible(), false);
    await page.locator('#toc-toggle').click();
    await page.locator('#larger').click(); assert.equal(await page.locator('#font-label').textContent(), '18');
    await page.locator('#theme').click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('.diagram svg').waitFor();
    await page.screenshot({ path: path.join(results, 'reading-dark.png') });
    await page.locator('#theme').click(); await page.locator('#smaller').click();
  });
  await check('跨文档链接与重复打开去重', async () => {
    await page.getByRole('link', { name: '打开另一篇文档' }).click();
    await waitFor(async () => (await page.locator('#content h1').textContent()) === '另一篇文档', 'other document');
    assert.equal(await page.locator('.tab').count(), 2);
    await page.getByRole('link', { name: '返回阅读示例' }).click();
    await page.locator('.diagram svg').waitFor();
    assert.equal(await page.locator('.tab').count(), 2);
  });
  await check('默认浏览器外链分发（拦截系统调用验证 URL）', async () => {
    await application.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.testExternalUrl = url; }; });
    await page.getByRole('link', { name: 'Markdown 项目网页' }).click();
    await waitFor(async () => (await application.evaluate(() => globalThis.testExternalUrl)) === 'https://commonmark.org/', 'external link');
  });
  await check('离线重新加载文档、字体、公式、图表和本地图片', async () => {
    await page.context().setOffline(true);
    await page.reload();
    await page.locator('.tab-name').filter({ hasText: '阅读示例.md' }).click();
    await page.locator('.diagram svg').waitFor();
    await waitFor(() => page.locator('#content img').evaluate(img => img.complete && img.naturalWidth > 0), 'offline image');
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.fonts.check('16px "Noto Sans SC"', '中文阅读')));
    assert.equal(await page.locator('.katex').count(), 2);
    await page.context().setOffline(false);
  });
  // Reload restores main-process documents in insertion order, with the last tab active.
  await page.locator('.tab-name').filter({ hasText: '阅读示例.md' }).click();
  await page.locator('.diagram svg').waitFor();
  await check('阅读不改写源文件', async () => assert.equal(await hash(sample), originalHash));
  await check('监听外部更新并保留滚动位置', async () => {
    await page.locator('#reader').evaluate(el => el.scrollTop = 350);
    await fs.appendFile(sample, '\n\n## 自动刷新验证\n\n外部修改已生效。\n');
    await page.getByRole('heading', { name: '自动刷新验证' }).waitFor();
    await page.locator('.diagram svg').waitFor();
    assert.ok(Math.abs(await page.locator('#reader').evaluate(el => el.scrollTop) - 350) < 35);
  });
  await check('删除文件提示、其他标签正常、文件恢复', async () => {
    const text = await fs.readFile(sample, 'utf8'); await fs.unlink(sample);
    await waitFor(async () => (await page.locator('#notice').textContent()).includes('删除'), 'deletion notice');
    await page.locator('.tab-name').filter({ hasText: '另一篇.markdown' }).click();
    assert.equal(await page.locator('#notice').isVisible(), false);
    await fs.writeFile(sample, text);
    await page.locator('.tab-name').filter({ hasText: '阅读示例.md' }).click();
    await waitFor(async () => !(await page.locator('#notice').isVisible()), 'file recovery');
  });
  await check('文件选择器多文件打开', async () => {
    await application.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [unsafe, other]);
    await page.locator('#open').click();
    await waitFor(async () => (await page.locator('.tab').count()) === 3, 'file dialog');
  });
  await page.locator('.tab-name').filter({ hasText: '安全与异常.md' }).click();
  await page.locator('.diagram-error').waitFor();
  await check('不执行脚本、事件和危险链接；渲染器无 Node 权限', async () => {
    assert.equal(await page.evaluate(() => window.__unsafeExecuted), undefined);
    assert.equal(await page.locator('#content script,#content iframe,#content [onclick],#content [onerror],#content [style]:not(.katex *)').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
    const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.ok(await page.getByRole('heading', { name: '其余内容' }).count());
  });
  await check('自定义图片协议拒绝任意文件及目录外图片', async () => {
    const id = await page.evaluate(() => document.querySelector('#content img').src.split('/')[2]);
    const results = await application.evaluate(async ({ net }, id) => {
      const paths = ['../../../../Windows/win.ini', '../outside.png'];
      return Promise.all(paths.map(async p => (await net.fetch(`md-media://${id}/image?path=${encodeURIComponent(p)}`)).status));
    }, id);
    assert.ok(results.every(s => s >= 400));
  });
  await check('多文件原生拖入及去重', async () => {
    const dropOne = path.join(fixtures, '拖入一.md'), dropTwo = path.join(fixtures, '拖入二.md');
    await fs.writeFile(dropOne, '# 拖入一'); await fs.writeFile(dropTwo, '# 拖入二');
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [dropOne, dropTwo, other], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 600, y: 300, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: 600, y: 300, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: 600, y: 300, data });
    await waitFor(async () => (await page.locator('.tab').count()) === 5, 'drop two files');
    await cdp.detach();
  });
  await check('运行中命令行打开进入同一窗口', async () => {
    const next = path.join(fixtures, '第二实例.md'); await fs.writeFile(next, '# 第二实例\n已进入现有窗口。');
    const exe = executablePath || (await import('electron')).default;
    const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [...prefix, `--user-data-dir=${profile}`, next], { windowsHide: true, stdio: 'ignore', env: childEnv });
    await new Promise((resolve, reject) => { child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Second instance exit ${code}`))); child.on('error', reject); });
    await page.getByRole('heading', { name: '第二实例', exact: true }).waitFor();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await page.locator('.tab').count(), 6);
  });
  await check('关闭标签与 Ctrl+W', async () => {
    await page.keyboard.press('Control+w'); await waitFor(async () => await page.locator('.tab').count() === 5, 'close with shortcut');
    await page.locator('.tab-close').last().click(); await waitFor(async () => await page.locator('.tab').count() === 4, 'close with button');
  });
  await check('窗口布局无横向溢出、工具栏始终可见', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 520));
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, themeRight: document.getElementById('theme').getBoundingClientRect().right, footerBottom: document.querySelector('footer').getBoundingClientRect().bottom, height: innerHeight }));
    assert.ok(fit.scroll <= fit.width); assert.ok(fit.themeRight <= fit.width); assert.ok(fit.footerBottom <= fit.height);
    await page.screenshot({ path: path.join(results, 'minimum-window.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 840));
  });
  await page.locator('.tab-name').filter({ hasText: '阅读示例.md' }).click();
  await page.locator('.diagram svg').waitFor();
  await page.locator('#reader').evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: path.join(results, 'reading-light.png') });
  report.screenshot = 'reading-light.png';
  await check('用户目录设置保存', async () => {
    await page.locator('#larger').click(); await page.locator('#theme').click();
    await waitFor(async () => { try { const s = JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')); return s.fontSize === 18 && s.theme === 'dark'; } catch { return false; } }, 'settings persisted');
    await application.close(); application = undefined;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...prefix, `--user-data-dir=${profile}`] });
    page = await application.firstWindow(); await page.locator('#empty h1').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); assert.equal(await page.locator('#font-label').textContent(), '18');
    await page.screenshot({ path: path.join(results, 'empty.png') });
  });
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = error.stack; console.error(error); if (page) await page.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally {
  await application?.close().catch(() => {});
  await fs.writeFile(path.join(results, executablePath ? 'installed-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Completed ${report.checks.length} checks. Report: ${results}`);
}
