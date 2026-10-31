// Markdown rendering for read-only views. Raw HTML in sources is always shown as text,
// links are restricted to safe schemes, and relative links are rewritten to bTeam routes.
import { Marked } from 'marked';
import YAML from 'yaml';
import { escapeHtml, resolveRepoLink, isMarkdown, imageType } from './util.js';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split optional YAML front matter from a Markdown document. */
export function splitFrontMatter(text) {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { data: {}, body: text };
  let data = {};
  try {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    /* ignore malformed front matter */
  }
  return { data, body: text.slice(m[0].length) };
}

export function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'section'
  );
}

/** Plain text of inline Markdown (for headings, titles and search). */
export function plainText(md) {
  return String(md)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

/** Headings of a Markdown document: [{depth, text, slug}]. */
export function headings(md) {
  const out = [];
  const seen = new Map();
  for (const t of new Marked().lexer(md)) {
    if (t.type !== 'heading') continue;
    const text = plainText(t.text);
    out.push({ depth: t.depth, text, slug: uniqueSlug(seen, slugify(text)) });
  }
  return out;
}

function uniqueSlug(seen, base) {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/**
 * Split a document into sections at headings of depth <= level.
 * Returns [{heading, depth, markdown}] (content before the first heading is skipped).
 */
export function sections(md, level = 2) {
  const out = [];
  let cur = null;
  for (const t of new Marked().lexer(md)) {
    if (t.type === 'heading' && t.depth <= level) {
      cur = { heading: plainText(t.text), depth: t.depth, markdown: t.raw };
      out.push(cur);
    } else if (cur) cur.markdown += t.raw;
  }
  return out;
}

function safeExternal(href) {
  return /^(https?:|mailto:)/i.test(href);
}

/**
 * Render Markdown to safe HTML.
 * @param {string} md
 * @param {object} ctx
 * @param {string} ctx.file  repo path of the document (for relative links)
 * @param {(p:string)=>boolean} [ctx.exists]  whether a repo path can be linked
 */
export function renderMarkdown(md, { file = '', exists = () => false } = {}) {
  const seen = new Map();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      heading({ tokens, depth, text }) {
        const slug = uniqueSlug(seen, slugify(plainText(text)));
        return `<h${depth} id="${escapeHtml(slug)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = rewriteHref(href, file, exists);
        if (!target) return `<span class="bt-deadlink">${inner}</span>`;
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const rel = safeExternal(href) ? ' rel="noopener noreferrer"' : '';
        return `<a href="${escapeHtml(target)}"${t}${rel}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const alt = escapeHtml(text);
        if (safeExternal(href) || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return `<span class="bt-ext-image">[${alt}]</span>`;
        const [p] = href.split(/[?#]/);
        const resolved = resolveRepoLink(file, decodeSafe(p));
        if (!resolved || !imageType(resolved) || !exists(resolved)) return `<span class="bt-deadlink">[${alt}]</span>`;
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="raw?path=${encodeURIComponent(resolved)}" alt="${alt}"${t} loading="lazy">`;
      },
    },
  });
  return marked.parse(md);
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function rewriteHref(href, file, exists) {
  if (!href) return null;
  if (href.startsWith('#')) return `#${encodeURIComponent(decodeSafe(href.slice(1)))}`;
  if (safeExternal(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null; // javascript:, data:, etc.
  const [pathPart, ...rest] = href.split('#');
  const anchor = rest.length ? `#${encodeURIComponent(decodeSafe(rest.join('#')))}` : '';
  const resolved = resolveRepoLink(file, decodeSafe(pathPart.split('?')[0]));
  if (!resolved || !exists(resolved)) return null;
  if (isMarkdown(resolved)) return `doc?path=${encodeURIComponent(resolved)}${anchor}`;
  if (imageType(resolved)) return `raw?path=${encodeURIComponent(resolved)}`;
  return `file?path=${encodeURIComponent(resolved)}`;
}

/** Title of a Markdown document: front matter title, first H1, or the file name. */
export function documentTitle(text, file) {
  const { data, body } = splitFrontMatter(text);
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return plainText(h1[1]);
  return file.split('/').pop().replace(/\.(md|markdown)$/i, '');
}
