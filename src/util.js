// Small generic helpers. No project-specific knowledge lives here.
import picomatch from 'picomatch';
import path from 'node:path';

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a duration like "30s", "10m", "1h" or "1d" into milliseconds. */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 1000;
  const m = /^(\d+)\s*([smhd])$/.exec(String(value ?? '').trim());
  if (!m) throw new Error(`invalid duration "${value}" (use e.g. 30s, 10m, 1h)`);
  const ms = Number(m[1]) * UNITS[m[2]];
  if (ms <= 0) throw new Error(`duration must be positive: "${value}"`);
  return ms;
}

const globCache = new Map();

/** Compile a list of glob patterns into a single matcher (dotfiles included). */
export function globMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean).map(String);
  const key = JSON.stringify(list);
  if (!globCache.has(key)) {
    const fn = list.length ? picomatch(list, { dot: true }) : () => false;
    globCache.set(key, fn);
  }
  return globCache.get(key);
}

/** Case-insensitive glob matcher for labels (e.g. "sev:*"). */
export function labelMatcher(patterns) {
  const list = (patterns ?? []).map((p) => String(p).toLowerCase());
  if (!list.length) return () => false;
  const fn = picomatch(list, { dot: true });
  return (label) => fn(String(label).toLowerCase());
}

/** True when any slash-separated segment starts with "." ("..", ".env", ".git", ".well-known"). */
export function hasDotSegment(p) {
  return String(p).split('/').some((s) => s.startsWith('.'));
}

/** Validate a repository-relative path coming from a request. */
export function safeRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return null;
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s.startsWith('.'))) return null;
  return p;
}

/** Resolve a relative link from one repo file to another repo path (posix). */
export function resolveRepoLink(fromFile, href) {
  const dir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, href));
  if (joined.startsWith('..') || joined.startsWith('/')) return null;
  return joined === '.' ? null : joined.replace(/\/$/, '');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A trimmed plain-text snippet around the first match of `needle`. */
export function snippet(text, needle, radius = 80) {
  const lower = text.toLowerCase();
  const i = lower.indexOf(needle.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

export function imageType(p) {
  return IMAGE_TYPES[path.posix.extname(p).toLowerCase()] ?? null;
}

export const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.svelte', '.vue', '.html', '.css', '.scss', '.sql', '.sh', '.ps1', '.bat', '.py', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.h', '.cpp', '.xml', '.svg', '.ini', '.cfg', '.conf', '.env.example',
  '.gitignore', '.dockerignore', '.npmrc', '.prettierignore', '.gitattributes', '.lock', '.inlang',
]);

export function isMarkdown(p) {
  return /\.(md|markdown)$/i.test(p);
}

/** Lowercase extension without the dot, or "" when the path has none. */
export function fileExtension(p) {
  const ext = path.posix.extname(String(p ?? '')).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : '';
}

/** Guess whether a buffer is text (no NUL bytes in the first 8 KB). */
export function looksLikeText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}
