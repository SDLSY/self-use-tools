import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import katex from 'katex';
import DOMPurify from 'dompurify';

const md: InstanceType<typeof MarkdownIt> = new MarkdownIt({ html: true, linkify: true, typographer: true,
  highlight(code, lang): string {
    if (lang === 'mermaid') return `<pre class="mermaid-source"><code>${md.utils.escapeHtml(code)}</code></pre>`;
    const highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : md.utils.escapeHtml(code);
    return `<pre class="hljs"><code>${highlighted}</code></pre>`;
  }
}).use(taskLists, { enabled: false });

// Math rules run before Markdown escape handling; currency dollars require no closing pair.
md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== '$' || state.src[start + 1] === '$' || /\s/.test(state.src[start + 1] || ' ')) return false;
  let end = start + 1;
  while ((end = state.src.indexOf('$', end)) >= 0) {
    if (state.src[end - 1] !== '\\') break;
    end++;
  }
  if (end < 0 || /\s/.test(state.src[end - 1])) return false;
  if (!silent) { const token = state.push('math_inline', 'math', 0); token.content = state.src.slice(start + 1, end); }
  state.pos = end + 1; return true;
});
md.block.ruler.before('fence', 'math_block', (state, start, end, silent) => {
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (!line.startsWith('$$')) return false;
  let content = line.slice(2), next = start;
  if (content.trimEnd().endsWith('$$')) content = content.trimEnd().slice(0, -2);
  else {
    let closed = false;
    for (next = start + 1; next < end; next++) {
      const current = state.src.slice(state.bMarks[next], state.eMarks[next]);
      if (current.trimEnd().endsWith('$$')) { content += '\n' + current.trimEnd().slice(0, -2); closed = true; break; }
      content += '\n' + current;
    }
    if (!closed) return false;
  }
  if (!silent) { const token = state.push('math_block', 'math', 0); token.content = content; token.block = true; }
  state.line = next + 1; return true;
});
let formulas: { id: string; html: string }[] = [];
const math = (content: string, displayMode: boolean) => {
  const id = crypto.randomUUID();
  formulas.push({ id, html: katex.renderToString(content, { displayMode, throwOnError: false, trust: false, strict: 'warn', maxExpand: 1000, maxSize: 20 }) });
  return `<span data-formula="${id}"></span>`;
};
md.renderer.rules.math_inline = (tokens, i) => math(tokens[i].content, false);
md.renderer.rules.math_block = (tokens, i) => math(tokens[i].content, true);

export function renderMarkdown(text: string, docId: string): { html: string; headings: { id: string; text: string; level: number }[] } {
  formulas = [];
  const html = DOMPurify.sanitize(md.render(text), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'button', 'textarea', 'video', 'audio', 'source', 'link', 'meta', 'base', 'foreignObject'],
    FORBID_ATTR: ['style', 'srcset', 'autofocus', 'contenteditable'],
    ADD_TAGS: ['input'], ADD_ATTR: ['disabled', 'checked', 'type'],
    SANITIZE_NAMED_PROPS: true
  });
  const template = document.createElement('template'); template.innerHTML = html;
  // Only parser-generated formulas regain KaTeX layout styles after document sanitization.
  for (const formula of formulas) {
    const el = template.content.querySelector(`[data-formula="${formula.id}"]`);
    if (el) el.innerHTML = formula.html;
  }
  template.content.querySelectorAll('input').forEach(el => { el.type = 'checkbox'; el.disabled = true; });
  template.content.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (/^https?:\/\//i.test(src) || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('/')) { img.removeAttribute('src'); return; }
    try { img.src = `md-media://${docId}/image?path=${encodeURIComponent(decodeURIComponent(src.split('#')[0].split('?')[0]))}`; }
    catch { img.removeAttribute('src'); }
  });
  const counts = new Map<string, number>();
  const usedIds = new Set<string>();
  const headings: { id: string; text: string; level: number }[] = [];
  template.content.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => {
    const label = el.textContent || '标题';
    const base = label.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    let count = counts.get(base) || 0;
    let slug = count ? `${base}-${count}` : base;
    while (usedIds.has(slug)) { count++; slug = `${base}-${count}`; }
    counts.set(base, count + 1); usedIds.add(slug);
    el.id = `md-h-${slug}`;
    headings.push({ id: el.id, text: label, level: Number(el.tagName[1]) });
  });
  template.content.querySelectorAll('pre:not(.mermaid-source)').forEach(pre => {
    const button = document.createElement('button'); button.className = 'copy-code'; button.textContent = '复制'; button.type = 'button'; pre.append(button);
  });
  return { html: template.innerHTML, headings };
}
