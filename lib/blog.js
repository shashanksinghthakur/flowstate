// Markdown blog: posts live in content/blog/*.md with a small front-matter block.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../content/blog/', import.meta.url));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[\w-]+|\/[\w./#-]*)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(md) {
  const out = []; let list = null, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushP(); flushL(); continue; }
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) { flushP(); if (!list || list.tag !== 'ul') { flushL(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) { flushP(); if (!list || list.tag !== 'ol') { flushL(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flushL(); para.push(line.trim());
  }
  flushP(); flushL();
  return out.join('\n');
}

export function parsePost(slug, text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  const body = m ? m[2] : text;
  return { slug, title: meta.title || slug, date: meta.date || '', author: meta.author || 'Flowstate', summary: meta.summary || '', tags: (meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean), draft: meta.draft === 'true', html: renderMarkdown(body) };
}

let cache = null;
export async function loadPosts() {
  if (cache && Date.now() - cache.t < 60_000) return cache.posts;
  let files = [];
  try { files = (await readdir(DIR)).filter((f) => f.endsWith('.md')); } catch {}
  const posts = [];
  for (const f of files) posts.push(parsePost(f.replace(/\.md$/, ''), await readFile(DIR + f, 'utf8')));
  const list = posts.filter((p) => !p.draft).sort((a, b) => b.date.localeCompare(a.date));
  cache = { t: Date.now(), posts: list };
  return list;
}
