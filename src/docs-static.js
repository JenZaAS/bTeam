// Signed-in static files for /docs. The directory comes from config or DOCS_DIR.
// A missing directory is a 404, not a startup failure.
import fs from 'node:fs';
import path from 'node:path';
import { hasDotSegment } from './util.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Theme files with a content hash in the name (for example main.01234567.min.css). */
export function isHashedAsset(rel) {
  return /\.[a-f0-9]{8,}\./i.test(path.posix.basename(String(rel)));
}

export function cacheControlFor(rel) {
  const name = String(rel).split('/').pop();
  if (name.endsWith('.html')) return 'private, no-store';
  if (isHashedAsset(rel)) return 'private, max-age=604800';
  return 'private, no-store';
}

/** DOCS_DIR wins over docs.dir. Empty or unset means the feature is off. */
export function resolveDocsDir(config, env = {}) {
  const fromEnv = typeof env.DOCS_DIR === 'string' ? env.DOCS_DIR.trim() : '';
  const raw = fromEnv || config?.docs?.dir || '';
  if (!raw) return null;
  return path.resolve(raw);
}

/** True when rel is exactly a configured prefix, or a path under that prefix. */
export function isHiddenDocsPath(rel, hidePaths) {
  if (!hidePaths?.length) return false;
  const norm = String(rel).replace(/^\/+/, '');
  const forms = new Set([norm]);
  if (norm.endsWith('/index.html')) forms.add(norm.slice(0, -'/index.html'.length));
  for (const raw of hidePaths) {
    const prefix = String(raw).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!prefix) continue;
    for (const form of forms) {
      if (form === prefix || form.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

/**
 * Read one file under root for a /docs pathname.
 * pathname is the URL parser's decoded path. rawPath is the request path before that decode.
 * hidePaths are prefixes under /docs that answer as missing.
 * Returns { body, type, rel } or { error: 'bad' | 'missing' | 'off' }.
 */
export function readDocsFile(root, pathname, rawPath = pathname, { hidePaths = [] } = {}) {
  if (!root) return { error: 'off' };
  if (pathname !== '/docs' && !pathname.startsWith('/docs/')) return { error: 'bad' };
  if (/%2e|%2f|%5c/i.test(rawPath) || rawPath.includes('\\') || rawPath.includes('\0')) return { error: 'bad' };

  let rel = pathname.slice('/docs'.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  if (rel.includes('\\') || rel.includes('\0') || rel.includes('%')) return { error: 'bad' };
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/');
  if (parts.some((p) => p === '') || hasDotSegment(rel)) return { error: 'bad' };
  if (isHiddenDocsPath(rel, hidePaths)) return { error: 'missing' };

  let rootReal;
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) return { error: 'missing' };
    rootReal = fs.realpathSync(root);
  } catch {
    return { error: 'missing' };
  }

  const abs = path.resolve(rootReal, ...parts);
  const relCheck = path.relative(rootReal, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return { error: 'bad' };

  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { error: 'missing' };
  }
  const inside = path.relative(rootReal, real);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return { error: 'bad' };

  let fileStat;
  try {
    fileStat = fs.statSync(real);
  } catch {
    return { error: 'missing' };
  }
  if (!fileStat.isFile()) return { error: 'missing' };
  return {
    body: fs.readFileSync(real),
    type: contentTypeFor(real),
    rel: inside.split(path.sep).join('/'),
  };
}
