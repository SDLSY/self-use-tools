import './style.css';
import './editor.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/600.css';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown';
import logoUrl from './logo.svg';

document.querySelector('#app')!.innerHTML = `
<header><div class="brand"><img class="brand-icon" src="${logoUrl}" alt="" width="35" height="35"><strong>墨阅</strong><span class="brand-note">MARKDOWN READER</span></div><button id="open" class="primary">＋ 打开文件</button><div class="tools"><button id="toc-toggle" title="显示或隐藏目录">☷ 目录</button><button id="search-toggle" title="文内搜索 Ctrl+F">⌕ 搜索</button><span class="divider"></span><button id="smaller" title="缩小字号 Ctrl+-">A−</button><span id="font-label"></span><button id="larger" title="放大字号 Ctrl++">A＋</button><button id="theme" title="切换深浅主题">◐</button></div></header>
<nav id="tabs" aria-label="已打开文档"></nav>
<section id="edit-bar" hidden><div class="view-modes" aria-label="文档视图"><button data-view="edit">编辑</button><button data-view="split">分栏</button><button data-view="preview">预览</button></div><span id="save-state">已保存</span><button id="reload" title="重新载入磁盘版本">重新载入</button><button id="save" class="primary" title="保存 Ctrl+S">保存</button></section>
<section id="search-bar" hidden><input id="search" placeholder="在当前文档中搜索…" aria-label="搜索内容"><span id="search-count">0 / 0</span><button id="prev" title="上一个 Shift+Enter">↑</button><button id="next" title="下一个 Enter">↓</button><button id="search-close" title="关闭搜索 Esc">✕</button></section>
<main><aside id="sidebar"><div class="aside-label">文档目录 <span>OUTLINE</span></div><nav id="outline"></nav><div class="aside-foot">本地文档 · 编辑与预览</div></aside><section id="editor-pane" hidden><label for="editor">MARKDOWN <span>Ctrl+S 保存</span></label><textarea id="editor" aria-label="Markdown 编辑器" spellcheck="false" placeholder="在这里编辑 Markdown…"></textarea></section><section id="reader"><div id="notice" role="status" hidden></div><article id="content" class="markdown-body"></article><div id="empty"><div class="empty-symbol">M<span>↓</span></div><div class="eyebrow">安静地，写一份文档</div><h1>让文字回到阅读本身。</h1><p>拖入 Markdown 文件，或选择本地文档。<br>随时编辑，实时预览，按 Ctrl+S 保存。</p><button id="empty-open" class="primary">打开 Markdown 文件 <span>↗</span></button><div class="empty-hints"><span>多标签编辑</span><span>离线可用</span><span>实时预览</span></div></div></section></main>
<footer><span id="status">准备就绪</span><span id="meta">支持 .md / .markdown</span></footer><div id="toast" role="status" hidden></div><div id="drop-overlay" hidden>松开以打开 Markdown 文档</div>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type Tab = DocumentData & { scroll: number; savedText: string; conflict: boolean; editorScroll: number; selection: [number, number] };
const tabs: Tab[] = [];
let active = '';
let view: 'edit' | 'split' | 'preview' = 'split';
let previewTimer: ReturnType<typeof setTimeout>;
let settings: ViewerSettings = { theme: 'light', fontSize: 17, toc: true };
let generation = 0;
let searchIndex = -1;
let matches: Range[] = [];
let sourceMatches: number[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
const current = () => tabs.find(t => t.id === active);
const dirty = (tab: Tab) => tab.text !== tab.savedText;
function syncDraft(tab: Tab) { void window.viewer.draft(tab.id, dirty(tab) ? { text: tab.text, version: tab.version } : null); }
function updateChrome() {
  const tab = current();
  document.title = tab ? `${dirty(tab) ? '● ' : ''}${tab.path.split(/[\\/]/).pop()} — 墨阅` : '墨阅 · Markdown';
  $('edit-bar').hidden = !tab;
  $('editor-pane').hidden = !tab || view === 'preview';
  $('reader').hidden = !!tab && view === 'edit';
  document.querySelector('main')!.dataset.view = tab ? view : 'empty';
  $('save-state').textContent = tab ? tab.conflict ? '外部文件已变化 · 草稿已保留' : dirty(tab) ? '未保存修改' : '已保存' : '';
  $<HTMLButtonElement>('save').disabled = !tab || !dirty(tab);
  $('meta').textContent = tab ? `${tab.text.length.toLocaleString()} 字符 · UTF-8 · ${dirty(tab) ? '未保存' : '可编辑'}` : '支持 .md / .markdown';
  $('notice').hidden = !tab?.error && !tab?.conflict;
  $('notice').textContent = tab?.error || (tab?.conflict ? '文件已在外部修改。当前草稿已保留；保存时可选择覆盖，或点击“重新载入”使用磁盘版本。' : '');
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
}
function toast(message: string) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3600); }
function applySettings(save = true) {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--reading-size', `${settings.fontSize}px`);
  $('font-label').textContent = `${settings.fontSize}`;
  $('sidebar').hidden = !settings.toc;
  $('toc-toggle').setAttribute('aria-pressed', String(settings.toc));
  $('theme').setAttribute('aria-label', settings.theme === 'dark' ? '切换浅色主题' : '切换深色主题');
  if (save) void window.viewer.saveSettings(settings).catch(() => toast('设置保存失败，请检查用户目录权限。'));
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const tab of tabs) {
    const wrapper = document.createElement('div'); wrapper.className = `tab ${tab.id === active ? 'active' : ''}`;
    const button = document.createElement('button'); button.className = 'tab-name'; button.textContent = `${dirty(tab) ? '● ' : ''}${tab.path.split(/[\\/]/).pop()!}`; button.title = tab.path; button.onclick = () => select(tab.id);
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-label', `关闭 ${tab.path.split(/[\\/]/).pop()}`); close.onclick = () => void closeTab(tab.id);
    wrapper.append(button, close); $('tabs').append(wrapper);
  }
  $('tabs').hidden = tabs.length === 0;
}
async function render() {
  const version = ++generation;
  const tab = current(); renderTabs();
  updateChrome();
  $('empty').hidden = !!tab; $('content').hidden = !tab;
  $('outline').replaceChildren();
  $('status').textContent = tab?.path || '准备就绪'; $('status').title = tab?.path || '';
  if (!tab) { $('content').replaceChildren(); updateSearch(); return; }
  const editor = $<HTMLTextAreaElement>('editor');
  if (editor.value !== tab.text) { editor.value = tab.text; editor.setSelectionRange(...tab.selection); editor.scrollTop = tab.editorScroll; }
  const result = renderMarkdown(tab.text, tab.id);
  $('content').innerHTML = result.html;
  for (const h of result.headings) {
    const button = document.createElement('button'); button.textContent = h.text; button.style.paddingLeft = `${14 + (h.level - 1) * 13}px`; button.className = `outline-link level-${h.level}`; button.onclick = () => jump(h.id); $('outline').append(button);
  }
  if (!result.headings.length) $('outline').textContent = '此文档暂无标题';
  $('reader').scrollTop = tab.scroll;
  mermaid.initialize({ startOnLoad: false, htmlLabels: false, securityLevel: 'strict', theme: settings.theme === 'dark' ? 'dark' : 'neutral', suppressErrorRendering: true, maxTextSize: 50000, fontFamily: 'Noto Sans SC, sans-serif', flowchart: { htmlLabels: false } });
  const blocks = [...$('content').querySelectorAll<HTMLElement>('.mermaid-source')];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]; const code = block.textContent || '';
    try {
      const { svg } = await mermaid.render(`diagram-${version}-${i}`, code);
      if (version !== generation) return;
      const figure = document.createElement('figure'); figure.className = 'diagram';
      figure.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script'], FORBID_ATTR: ['onload', 'onclick'] });
      block.replaceWith(figure);
    } catch {
      if (version !== generation) return;
      const error = document.createElement('div'); error.className = 'diagram-error'; error.textContent = 'Mermaid 图表语法有误，已保留源代码。'; block.before(error);
    }
  }
  if (version !== generation) return;
  $('reader').scrollTop = tab.scroll;
  updateSearch();
}
function select(id: string) {
  const previous = current();
  if (previous) { previous.scroll = $('reader').scrollTop; previous.editorScroll = $('editor').scrollTop; previous.selection = [$<HTMLTextAreaElement>('editor').selectionStart, $<HTMLTextAreaElement>('editor').selectionEnd]; }
  active = id; void render();
}
function openDoc(doc: DocumentData) {
  const tab = tabs.find(t => t.id === doc.id);
  if (tab) { if (!dirty(tab)) Object.assign(tab, doc, { savedText: doc.text, error: doc.error }); }
  else tabs.push({ ...doc, scroll: 0, savedText: doc.text, conflict: false, editorScroll: 0, selection: [0, 0] });
  select(doc.id);
}
async function closeTab(id: string) {
  if (!(await window.viewer.closeDocument(id))) return;
  const index = tabs.findIndex(t => t.id === id); if (index < 0) return;
  tabs.splice(index, 1);
  if (active === id) { active = tabs[Math.min(index, tabs.length - 1)]?.id || ''; void render(); } else renderTabs();
}
function acceptSaved(doc: DocumentData, savedText: string) {
  const tab = tabs.find(t => t.id === doc.id); if (!tab) return;
  tab.savedText = savedText; tab.version = doc.version; tab.conflict = false; tab.error = doc.error;
  syncDraft(tab); renderTabs(); updateChrome();
}
async function save(tab = current()) {
  if (!tab || !dirty(tab)) return true;
  const text = tab.text;
  try {
    const result = await window.viewer.saveDocument(tab.id, { text, version: tab.version });
    if (result.error || !result.document) { toast(result.error || '保存失败，草稿仍保留。'); return false; }
    acceptSaved(result.document, text); toast('已保存'); return true;
  } catch { toast('保存失败，草稿仍保留。'); return false; }
}
$('save').onclick = () => void save();
$('reload').onclick = async () => {
  const tab = current(); if (!tab) return;
  const result = await window.viewer.reloadDocument(tab.id);
  if (result?.error) toast(result.error);
  else if (result?.document) { Object.assign(tab, result.document, { savedText: result.document.text, conflict: false, error: undefined }); if (tab.id === active) void render(); }
};
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view as typeof view; updateChrome(); updateSearch(); if (view !== 'preview') $('editor').focus(); });
$('editor').oninput = () => {
  const tab = current(); if (!tab) return;
  tab.text = $<HTMLTextAreaElement>('editor').value;
  tab.scroll = $('reader').scrollTop;
  syncDraft(tab); renderTabs(); updateChrome();
  clearTimeout(previewTimer); previewTimer = setTimeout(() => void render(), 300);
};
function jump(id: string) {
  let decoded = id; try { decoded = decodeURIComponent(id); } catch { /* Literal fragment. */ }
  const target = [...$('content').querySelectorAll('[id]')].find(el => el.id === decoded || el.id === `md-h-${decoded}` || el.id === `user-content-${decoded}`);
  if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' }); else toast('未找到链接指向的标题。');
}
let searchTimer: ReturnType<typeof setTimeout>;
function updateSearch() {
  matches = []; sourceMatches = []; searchIndex = -1;
  const query = $<HTMLInputElement>('search').value.toLocaleLowerCase();
  if (query && !$('search-bar').hidden) {
    if (view === 'edit' && current()) {
      const text = $<HTMLTextAreaElement>('editor').value.toLocaleLowerCase(); let start = 0;
      while ((start = text.indexOf(query, start)) !== -1 && sourceMatches.length < 10000) { sourceMatches.push(start); start += query.length; }
    }
    const walker = document.createTreeWalker($('content'), NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('.copy-code,svg,.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    while (walker.nextNode()) {
      const node = walker.currentNode; const text = node.textContent!.toLocaleLowerCase(); let start = 0;
      while ((start = text.indexOf(query, start)) !== -1) {
        const range = new Range(); range.setStart(node, start); range.setEnd(node, start + query.length); matches.push(range); start += query.length;
        if (matches.length >= 10000) break;
      }
      if (matches.length >= 10000) break;
    }
  }
  const css = CSS as unknown as { highlights: Map<string, unknown> };
  const HighlightClass = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  css.highlights.set('search-results', new HighlightClass(...matches));
  css.highlights.delete('search-active');
  const count = view === 'edit' ? sourceMatches.length : matches.length;
  $('search-count').textContent = `0 / ${count}`;
  if (count) moveSearch(1);
}
function moveSearch(direction: number) {
  if (view === 'edit') {
    if (!sourceMatches.length) return;
    searchIndex = (searchIndex + direction + sourceMatches.length) % sourceMatches.length;
    const editor = $<HTMLTextAreaElement>('editor'); const start = sourceMatches[searchIndex];
    editor.setSelectionRange(start, start + $<HTMLInputElement>('search').value.length);
    editor.scrollTop = (editor.value.slice(0, start).split('\n').length - 1) * parseFloat(getComputedStyle(editor).lineHeight) - editor.clientHeight / 3;
    $('search-count').textContent = `${searchIndex + 1} / ${sourceMatches.length}`;
    return;
  }
  if (!matches.length) return;
  searchIndex = (searchIndex + direction + matches.length) % matches.length;
  const range = matches[searchIndex];
  const HighlightClass = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  (CSS as unknown as { highlights: Map<string, unknown> }).highlights.set('search-active', new HighlightClass(range));
  const rect = range.getBoundingClientRect(), parent = $('reader').getBoundingClientRect();
  $('reader').scrollTop += rect.top - parent.top - parent.height / 3;
  $('search-count').textContent = `${searchIndex + 1} / ${matches.length}`;
}
function showSearch(show: boolean) { $('search-bar').hidden = !show; if (show) { $('search').focus(); $<HTMLInputElement>('search').select(); } updateSearch(); }
const open = () => void window.viewer.pickFiles().catch(e => toast(String(e)));
$('open').onclick = open; $('empty-open').onclick = open;
$('theme').onclick = () => { settings.theme = settings.theme === 'light' ? 'dark' : 'light'; if (current()) current()!.scroll = $('reader').scrollTop; applySettings(); void render(); };
$('toc-toggle').onclick = () => { settings.toc = !settings.toc; applySettings(); };
function font(delta: number) { settings.fontSize = Math.min(28, Math.max(12, settings.fontSize + delta)); applySettings(); }
$('larger').onclick = () => font(1); $('smaller').onclick = () => font(-1);
$('search-toggle').onclick = () => showSearch($('search-bar').hidden); $('search-close').onclick = () => showSearch(false);
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(updateSearch, 120); };
$('next').onclick = () => moveSearch(1); $('prev').onclick = () => moveSearch(-1);
$('content').onclick = async event => {
  const el = event.target as HTMLElement;
  const copy = el.closest('.copy-code');
  if (copy) { try { await navigator.clipboard.writeText(copy.parentElement!.querySelector('code')!.textContent || ''); copy.textContent = '已复制'; setTimeout(() => copy.textContent = '复制', 1500); } catch { toast('无法访问剪贴板。'); } return; }
  const link = el.closest('a'); if (!link) return;
  event.preventDefault(); const href = link.getAttribute('href'); if (!href || !active) return;
  if (href.startsWith('#')) { jump(href.slice(1)); return; }
  try { const result = await window.viewer.link(active, href); if (result.error) toast(result.error); else if (result.hash) setTimeout(() => jump(result.hash!), 100); } catch { toast('无法打开此链接。'); }
};
$('content').addEventListener('error', e => { const target = e.target; if (target instanceof HTMLImageElement) { target.alt = `图片无法加载：${target.alt || '请检查路径或网络'}`; target.classList.add('broken-image'); } }, true);
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); open(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); showSearch(true); }
  if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (active) void closeTab(active); }
  if (e.ctrlKey && ['+', '=', '-'].includes(e.key)) { e.preventDefault(); font(e.key === '-' ? -1 : 1); }
  if (e.key === 'Escape') showSearch(false);
  if (e.key === 'Enter' && document.activeElement === $('search')) { e.preventDefault(); moveSearch(e.shiftKey ? -1 : 1); }
});
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop-overlay').hidden = false; } });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; const files = [...(e.dataTransfer?.files || [])]; if (!files.some(f => /\.(md|markdown)$/i.test(f.name))) toast('请拖入 .md 或 .markdown 文件。'); void window.viewer.dropFiles(files).catch(() => toast('文件打开失败。')); });
window.viewer.onOpen(openDoc);
window.viewer.onUpdate(doc => {
  const tab = tabs.find(t => t.id === doc.id); if (!tab) return;
  if (dirty(tab)) { tab.conflict = doc.version !== tab.version || !!doc.error; tab.error = doc.error; if (active === doc.id) updateChrome(); return; }
  if (active === doc.id) tab.scroll = $('reader').scrollTop;
  Object.assign(tab, doc, { savedText: doc.text, conflict: false, error: doc.error }); if (active === doc.id) void render();
});
window.viewer.onSaved(doc => acceptSaved(doc, doc.text));
window.viewer.onSaveError(toast);
void window.viewer.initial().then(initial => { settings = initial.settings; applySettings(false); for (const doc of initial.documents) openDoc(doc); if (!tabs.length) void render(); }).catch(() => toast('初始化失败，请重启应用。'));

