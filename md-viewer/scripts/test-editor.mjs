import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
await fs.mkdir('test-results', { recursive: true });
const run = await fs.mkdtemp(path.resolve('test-results/edit-'));
const file = path.join(run, '中文 空格.md');
const other = path.join(run, '另一个.md');
const initial = '# 编辑样例\n\n原始正文。\n';
await fs.writeFile(file, '\uFEFF' + initial.replace(/\n/g, '\r\n'));
await fs.writeFile(other, '# 其他文档\n');
const checks = [], errors = [];
let app, page;
async function waitFor(fn, message) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${message}`);
}
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function reply(response) {
  await app.evaluate(({ dialog }, response) => { dialog.showMessageBox = async options => { globalThis.lastPrompt = options; return { response, checkboxChecked: false }; }; }, response);
}
async function saved() { await waitFor(async () => (await page.locator('#save-state').textContent()) === '已保存', 'save complete'); }
const executablePath = process.env.MD_VIEWER_EXE;
try {
  app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(run, 'profile')}`, file, other] });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.locator('.tab-name').filter({ hasText: '中文 空格.md' }).click();
  await check('默认分栏可编辑，正文预览正常', async () => {
    await page.locator('#editor').waitFor(); assert.equal(await page.locator('#editor').inputValue(), initial);
    assert.equal(await page.locator('#content h1').textContent(), '编辑样例');
  });
  const changed = initial + '\n## 新标题\n\n**编辑后的内容**。\n';
  await check('编辑不自动写盘，实时预览与未保存提示', async () => {
    await page.locator('#editor').fill(changed); await page.getByRole('heading', { name: '新标题' }).waitFor();
    assert.equal(await page.locator('#save-state').textContent(), '未保存修改'); assert.ok((await page.title()).startsWith('●'));
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF' + initial.replace(/\n/g, '\r\n'));
  });
  await check('切换标签与重复打开保留各自草稿', async () => {
    await page.locator('.tab-name').filter({ hasText: '另一个.md' }).click(); await page.locator('#editor').fill('# 另一份草稿\n');
    await page.locator('.tab-name').filter({ hasText: '中文 空格.md' }).click(); assert.equal(await page.locator('#editor').inputValue(), changed);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.locator('#open').click(); assert.equal(await page.locator('#editor').inputValue(), changed); assert.equal(await page.locator('.tab').count(), 2);
  });
  await check('Ctrl+S 保存并保留 UTF-8 BOM 与 CRLF', async () => {
    await page.locator('#editor').focus(); await page.keyboard.press('Control+s'); await saved();
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF' + changed.replace(/\n/g, '\r\n'));
    await page.waitForTimeout(400); assert.equal(await page.locator('#notice').isVisible(), false);
  });
  const draft = changed + '\n本地草稿\n';
  await check('外部修改不覆盖草稿，保存冲突取消与覆盖', async () => {
    await page.locator('#editor').fill(draft); await fs.writeFile(file, '# 外部版本\n');
    await waitFor(async () => (await page.locator('#save-state').textContent()).includes('外部'), 'external change');
    assert.equal(await page.locator('#editor').inputValue(), draft);
    await reply(0); await page.locator('#save').click(); await page.getByRole('status').filter({ hasText: '已取消保存' }).waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), '# 外部版本\n'); assert.equal(await page.locator('#editor').inputValue(), draft);
    await reply(1); await page.locator('#save').click(); await saved(); assert.equal(await fs.readFile(file, 'utf8'), draft);
  });
  await check('重新载入取消保留草稿，确认后读取磁盘', async () => {
    await page.locator('#editor').fill(draft + '未保存');
    await reply(0); await page.locator('#reload').click(); assert.equal(await page.locator('#editor').inputValue(), draft + '未保存');
    await reply(1); await page.locator('#reload').click(); await saved(); assert.equal(await page.locator('#editor').inputValue(), draft);
  });
  await check('文件删除后保存失败保留草稿', async () => {
    await page.locator('#editor').fill('# 删除后的草稿\n'); await fs.unlink(file);
    await page.locator('#save').click(); await waitFor(async () => (await page.locator('#toast').textContent()).includes('原文件已删除'), 'missing file failure');
    assert.equal(await page.locator('#editor').inputValue(), '# 删除后的草稿\n');
    await fs.writeFile(file, draft); await reply(1); await page.locator('#reload').click(); await saved();
  });
  await check('只读文件保存失败时不丢失草稿', async () => {
    await page.locator('#editor').fill('# 只读保存测试\n'); await fs.chmod(file, 0o444);
    try { await page.locator('#save').click(); await waitFor(async () => (await page.locator('#toast').textContent()).includes('只读'), 'read-only save'); assert.equal(await fs.readFile(file, 'utf8'), draft); }
    finally { await fs.chmod(file, 0o666); }
    await reply(1); await page.locator('#reload').click(); await saved();
  });
  await check('关闭标签时取消、保存并关闭、放弃修改', async () => {
    await page.locator('#editor').fill('# 关闭时保存\n'); await reply(2);
    await page.locator('.tab-close').first().click(); await page.waitForTimeout(150); assert.equal(await page.locator('.tab').count(), 2);
    await reply(0); await page.locator('.tab-close').first().click(); await waitFor(async () => await page.locator('.tab').count() === 1, 'save and close'); assert.equal(await fs.readFile(file, 'utf8'), '# 关闭时保存\n');
    await reply(1); await page.locator('.tab-close').click(); await page.locator('#empty').waitFor(); assert.equal(await fs.readFile(other, 'utf8'), '# 其他文档\n');
  });
  await page.locator('#open').click(); await page.locator('#editor').waitFor();
  await check('编辑、预览、分栏切换不丢失内容', async () => {
    await page.locator('#editor').fill('# 夜间编辑\n\n修改中的 Markdown。\n');
    await page.locator('[data-view=preview]').click(); assert.equal(await page.locator('#editor-pane').isVisible(), false);
    await page.locator('[data-view=edit]').click(); assert.equal(await page.locator('#reader').isVisible(), false);
    await page.locator('[data-view=split]').click(); assert.equal(await page.locator('#editor').inputValue(), '# 夜间编辑\n\n修改中的 Markdown。\n');
  });
  await check('编辑视图搜索能定位源文本', async () => {
    await page.locator('[data-view=edit]').click(); await page.keyboard.press('Control+f'); await page.locator('#search').fill('Markdown');
    await waitFor(async () => (await page.locator('#search-count').textContent()) === '1 / 1', 'source search');
    assert.equal(await page.locator('#editor').evaluate(e => e.value.slice(e.selectionStart, e.selectionEnd)), 'Markdown');
    await page.keyboard.press('Escape'); await page.locator('[data-view=split]').click();
  });
  await check('深灰夜间主题、按钮和代码块无绿色背景', async () => {
    await page.locator('#theme').click();
    const colors = await page.evaluate(() => ['--bg', '--paper', '--soft'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim()));
    assert.deepEqual(colors, ['#1b1b1f', '#222226', '#303039']);
    assert.equal(await page.locator('#save').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(88, 106, 171)');
    await page.waitForTimeout(3700); await page.screenshot({ path: 'test-results/editor-dark.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 520));
    const bounds = await page.locator('#save').boundingBox(); assert.ok(bounds.x + bounds.width <= 760);
    await page.screenshot({ path: 'test-results/editor-small.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 840));
  });
  await check('关闭窗口取消后保留草稿，保存并退出真正落盘', async () => {
    await reply(2); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await page.waitForTimeout(150);
    assert.equal(page.isClosed(), false); assert.ok((await page.locator('#editor').inputValue()).includes('夜间编辑'));
    await reply(0); const exited = app.waitForEvent('close'); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {}); await exited;
    assert.equal(await fs.readFile(file, 'utf8'), '# 夜间编辑\n\n修改中的 Markdown。\n'); app = undefined;
  });
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error); errors.push(error.stack); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/editor-failure.png' }).catch(() => {});
} finally {
  if (app) { await reply(1).catch(() => {}); await app.close().catch(() => {}); }
  await fs.writeFile('test-results/editor-report.json', JSON.stringify({ runtime: executablePath || 'development Electron', checks, errors }, null, 2));
  console.log(`Completed ${checks.length} editor checks.`);
}
