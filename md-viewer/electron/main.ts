import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, shell } from 'electron';
import { readFile, writeFile, mkdir, realpath, stat, rename, unlink } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const customProfile = app.commandLine.getSwitchValue('user-data-dir');
if (customProfile) app.setPath('userData', path.resolve(customProfile));
protocol.registerSchemesAsPrivileged([
  { scheme: 'md-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'md-media', privileges: { standard: true, secure: true } }
]);
type Doc = { id: string; path: string; text: string; version: string; error?: string };
type Draft = { text: string; version: string };
const drafts = new Map<string, Draft>();
const saving = new Set<string>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Settings = { theme: 'light' | 'dark'; fontSize: number; toc: boolean };
const docs = new Map<string, Doc>();
const watchers = new Map<string, FSWatcher>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let win: BrowserWindow | undefined;
let ready = false;
let queued: string[] = [];
let settings: Settings = { theme: 'light', fontSize: 17, toc: true };
const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
const key = (p: string) => path.resolve(p).toLowerCase();
const emit = (channel: string, data: unknown) => { if (ready && win && !win.isDestroyed()) win.webContents.send(channel, data); };
const errorText = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT' ? '文件已删除或移动，等待文件恢复。' : `无法读取文件：${(e as Error).message}`;
async function refresh(doc: Doc) {
  try {
    const info = await stat(doc.path);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('仅支持不超过 20 MB 的 Markdown 文件。');
    const bytes = await readFile(doc.path);
    doc.version = digest(bytes);
    doc.text = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    delete doc.error;
  } catch (e) { doc.error = errorText(e); }
}
function watchDoc(doc: Doc) {
  try {
    const watcher = watch(path.dirname(doc.path), (_, filename) => {
      if (filename && key(path.join(path.dirname(doc.path), filename.toString())) !== key(doc.path)) return;
      clearTimeout(timers.get(doc.id));
      timers.set(doc.id, setTimeout(async () => { await refresh(doc); if (docs.has(doc.id)) emit('document-update', doc); }, 180));
    });
    watcher.on('error', () => { doc.error = '文件监听已中断，请关闭后重新打开文件。'; emit('document-update', doc); });
    watchers.set(doc.id, watcher);
  } catch { doc.error = '无法监听所在目录，请关闭后重新打开文件。'; }
}
async function openFiles(files: string[]) {
  for (const raw of files.slice(0, 100)) {
    if (typeof raw !== 'string' || !isMd(raw)) continue;
    let p = path.resolve(raw);
    try { p = await realpath(p); } catch { /* Show the missing-file tab. */ }
    const existing = [...docs.values()].find(d => key(d.path) === key(p));
    if (existing) { emit('document-open', existing); continue; }
    const doc: Doc = { id: randomUUID(), path: p, text: '', version: '' };
    docs.set(doc.id, doc);
    await refresh(doc);
    watchDoc(doc);
    emit('document-open', doc);
  }
}
function argumentsFiles(args: string[], cwd: string) {
  return args.filter(a => !a.startsWith('-') && isMd(a)).map(a => path.resolve(cwd, a));
}
function validateSettings(v: unknown): Settings {
  const s = (v || {}) as Partial<Settings>;
  return { theme: s.theme === 'dark' ? 'dark' : 'light', fontSize: Math.max(12, Math.min(28, Number(s.fontSize) || 17)), toc: s.toc !== false };
}
function trusted(event: Electron.IpcMainInvokeEvent) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('非法调用。');
}
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => { trusted(event); return fn(...args); });
}
let settingsWrite = Promise.resolve();
async function saveDoc(id: string, draft: Draft): Promise<{ document?: Doc; error?: string }> {
  const doc = docs.get(id);
  if (!doc || typeof draft?.text !== 'string' || typeof draft.version !== 'string') return { error: '无效的文档。' };
  if (Buffer.byteLength(draft.text, 'utf8') > 20 * 1024 * 1024) return { error: '文件不能超过 20 MB。' };
  if (saving.has(id)) return { error: '正在保存，请稍后重试。' };
  saving.add(id);
  const temp = path.join(path.dirname(doc.path), `.${path.basename(doc.path)}.${randomUUID()}.tmp`);
  try {
    let disk: Buffer;
    try { disk = await readFile(doc.path); } catch { return { error: '原文件已删除或无法读取。为保护草稿，未进行保存；请先恢复原文件。' }; }
    if (digest(disk) !== draft.version) {
      const result = await dialog.showMessageBox(win!, { type: 'warning', title: '文件已在外部修改', message: `${path.basename(doc.path)} 已被其他程序修改。`, detail: '覆盖将以当前编辑内容替换磁盘上的版本。取消可保留草稿，或返回文档选择“重新载入”。', buttons: ['取消', '覆盖磁盘版本'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return { error: '已取消保存，草稿仍保留。' };
    }
    const info = await stat(doc.path);
    if (!(info.mode & 0o200)) return { error: '文件为只读，无法保存。' };
    const decoded = disk.toString('utf8');
    const text = draft.text.replace(/\r\n/g, '\n');
    const output = (decoded.startsWith('\uFEFF') ? '\uFEFF' : '') + (decoded.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
    await writeFile(temp, output, { encoding: 'utf8', flag: 'wx', mode: info.mode });
    // Recheck after any confirmation and temporary-file write; do not overwrite a newer change.
    if (digest(await readFile(doc.path)) !== digest(disk)) return { error: '保存期间文件再次发生变化，请重新保存并确认。' };
    if (key(await realpath(doc.path)) !== key(doc.path)) return { error: '文件目标已改变，已停止保存。' };
    await rename(temp, doc.path);
    await refresh(doc);
    if (doc.error) return { error: doc.error };
    if (drafts.get(id)?.text === draft.text) drafts.delete(id);
    return { document: { ...doc } };
  } catch (e) { return { error: `保存失败，草稿仍保留：${(e as Error).message}` }; }
  finally { saving.delete(id); await unlink(temp).catch(() => {}); }
}
let closePrompt = false;
async function confirmChanges(ids: string[]): Promise<boolean> {
  const dirty = ids.filter(id => drafts.has(id));
  if (!dirty.length) return true;
  const result = await dialog.showMessageBox(win!, { type: 'question', title: '保存修改', message: dirty.length === 1 ? `保存“${path.basename(docs.get(dirty[0])!.path)}”的修改？` : `有 ${dirty.length} 个文档尚未保存。`, buttons: ['保存并关闭', '放弃修改', '取消'], defaultId: 0, cancelId: 2, noLink: true });
  if (result.response === 2) return false;
  if (result.response === 0) {
    for (const id of dirty) {
      const draft = drafts.get(id); if (!draft) continue;
      const result = await saveDoc(id, { ...draft });
      if (result.error) { emit('save-error', result.error); return false; }
      if (result.document) emit('document-saved', result.document);
    }
    if (dirty.some(id => drafts.has(id))) return false;
  }
  return true;
}
async function boot() {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = validateSettings(JSON.parse(await readFile(settingsFile, 'utf8'))); } catch { /* First launch. */ }
  protocol.handle('md-app', async request => {
    const url = new URL(request.url);
    const p = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (url.host !== 'viewer' || !p.startsWith(dist + path.sep)) return new Response('', { status: 403 });
    return net.fetch(pathToFileURL(p).href);
  });
  protocol.handle('md-media', async request => {
    try {
      const url = new URL(request.url);
      const doc = docs.get(url.host);
      if (!doc) return new Response('', { status: 403 });
      const rel = url.searchParams.get('path') || '';
      if (path.isAbsolute(rel) || /^[a-z][a-z\d+.-]*:/i.test(rel)) return new Response('', { status: 403 });
      const p = await realpath(path.resolve(path.dirname(doc.path), rel));
      if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(p)) return new Response('', { status: 403 });
      // Explicitly opened documents grant image access inside their own directory tree.
      const root = await realpath(path.dirname(doc.path));
      if (!key(p).startsWith(key(root) + path.sep)) return new Response('', { status: 403 });
      return net.fetch(pathToFileURL(p).href);
    } catch { return new Response('', { status: 404 }); }
  });
  win = new BrowserWindow({ width: 1220, height: 840, minWidth: 760, minHeight: 520, backgroundColor: '#f5f5f9', title: '墨阅', icon: path.join(here, 'icon.ico'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  Menu.setApplicationMenu(null);
  win.on('close', event => {
    if (!drafts.size) return;
    event.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    void confirmChanges([...docs.keys()]).then(approved => { if (approved) win?.destroy(); }).finally(() => { closePrompt = false; });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(wc === win?.webContents && permission === 'clipboard-sanitized-write'));
  handle('initial', async () => {
    const files = queued; queued = [];
    await openFiles(files);
    ready = true;
    return { settings, documents: [...docs.values()] };
  });
  handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(win!, { title: '打开 Markdown 文件', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }] });
    if (!r.canceled) await openFiles(r.filePaths);
  });
  handle('drop-files', async (files: unknown) => {
    if (Array.isArray(files) && files.every(f => typeof f === 'string')) await openFiles(files);
  });
  handle('draft', (id: string, draft: Draft | null) => {
    if (!docs.has(id)) return;
    if (draft === null) { drafts.delete(id); return; }
    if (typeof draft?.text === 'string' && typeof draft.version === 'string') drafts.set(id, { text: draft.text, version: draft.version });
  });
  handle('save-document', saveDoc);
  handle('reload-document', async (id: string) => {
    const doc = docs.get(id); if (!doc) return;
    if (drafts.has(id)) {
      const result = await dialog.showMessageBox(win!, { type: 'warning', message: '重新载入将放弃当前文档的未保存修改。', buttons: ['取消', '放弃修改并载入'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
    }
    await refresh(doc); if (doc.error) return { error: doc.error };
    drafts.delete(id); return { document: { ...doc } };
  });
  handle('close-document', async (id: string) => {
    if (!docs.has(id) || !(await confirmChanges([id]))) return false;
    drafts.delete(id); docs.delete(id); watchers.get(id)?.close(); watchers.delete(id); clearTimeout(timers.get(id)); timers.delete(id); return true;
  });
  handle('save-settings', (value: unknown) => {
    settings = validateSettings(value);
    const text = JSON.stringify(settings, null, 2);
    settingsWrite = settingsWrite.catch(() => {}).then(async () => { await mkdir(path.dirname(settingsFile), { recursive: true }); await writeFile(settingsFile + '.tmp', text); const { rename } = await import('node:fs/promises'); await rename(settingsFile + '.tmp', settingsFile); });
    return settingsWrite;
  });
  handle('link', async (id: string, href: string) => {
    const doc = docs.get(id);
    if (!doc || typeof href !== 'string' || href.length > 8192) return { error: '无效链接。' };
    if (/^https?:\/\//i.test(href)) { await shell.openExternal(new URL(href).href); return {}; }
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return { error: '已拦截不受支持的链接。' };
    const [filename, hash] = href.split('#', 2);
    let decoded: string;
    try { decoded = decodeURIComponent(filename.split('?')[0]); } catch { return { error: '链接路径编码有误。' }; }
    if (!isMd(decoded)) return { error: '仅支持 Markdown 文档和 http/https 网页链接。' };
    await openFiles([path.resolve(path.dirname(doc.path), decoded)]);
    return { hash: hash ? decodeURIComponent(hash) : undefined };
  });
  await win.loadURL('md-app://viewer/index.html');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  queued.push(...argumentsFiles(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()));
  app.on('second-instance', (_event, argv, cwd) => {
    const files = argumentsFiles(argv.slice(app.isPackaged ? 1 : 2), cwd);
    if (ready) void openFiles(files); else queued.push(...files);
    if (win?.isMinimized()) win.restore(); win?.show(); win?.focus();
  });
  app.whenReady().then(boot).catch(e => { dialog.showErrorBox('启动失败', String(e)); app.quit(); });
  app.on('window-all-closed', () => { for (const w of watchers.values()) w.close(); app.quit(); });
}
