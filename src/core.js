// The content-neutral core: read tools over one instance (config + mirror + issue source).
// Every tool takes a viewer (see visibility.js) and only returns what that viewer may see.
// The web UI, the CLI and (later) an MCP server all call these same tools.
import path from 'node:path';
import { globMatcher, imageType, isMarkdown, looksLikeText, snippet, safeRepoPath } from './util.js';
import { renderMarkdown, splitFrontMatter, documentTitle, headings, sections, plainText } from './markdown.js';

const SEARCHABLE_TYPES = new Set(['digest', 'decisions', 'documents', 'open-questions', 'gallery']);
const MAX_RENDER_BYTES = 2 * 1024 * 1024;

export class NotFound extends Error {}

const isReadme = (p) => /^readme\.(md|markdown)$/i.test(path.posix.basename(p));

export function createCore({ config, mirror, issues = null }) {
  const matchers = new Map();
  for (const box of config.boxes) matchers.set(box.id, boxMatcher(box));

  function boxMatcher(box) {
    switch (box.type) {
      case 'digest':
        return globMatcher(box.pattern);
      case 'decisions': {
        const m = globMatcher(box.paths);
        return (p) => m(p) || (box.fallback && p === box.fallback.file);
      }
      case 'gallery':
        return (p) => box.roots.some((r) => p.startsWith(r)) && (Boolean(imageType(p)) || (box.notesFile && path.posix.basename(p) === box.notesFile));
      case 'documents':
      case 'open-questions':
        return globMatcher(box.paths ?? []);
      case 'source-browser': {
        const inc = globMatcher(box.include);
        const exc = globMatcher(box.exclude);
        return (p) => inc(p) && !exc(p);
      }
      default:
        return () => false;
    }
  }

  const visibleBoxes = (viewer) => config.boxes.filter((b) => viewer.canSeeBox(b));

  function getBoxOrThrow(viewer, id) {
    const box = config.boxes.find((b) => b.id === id);
    if (!box || !viewer.canSeeBox(box)) throw new NotFound(`no box "${id}"`);
    return box;
  }

  /** Whether `p` may be shown to `viewer`: inside a visible box and not hidden for the role. */
  function reachable(viewer, p) {
    if (!viewer.canSeePath(p)) return false;
    return visibleBoxes(viewer).some((b) => matchers.get(b.id)(p));
  }

  async function filesFor(viewer, box) {
    const m = matchers.get(box.id);
    return (await mirror.files()).filter((f) => m(f.path) && viewer.canSeePath(f.path));
  }

  async function existsFn(viewer) {
    const set = new Set((await mirror.files()).map((f) => f.path));
    return (p) => set.has(p) && reachable(viewer, p);
  }

  async function renderFile(viewer, p, text) {
    const exists = await existsFn(viewer);
    return renderMarkdown(splitFrontMatter(text).body, { file: p, exists });
  }

  async function readText(p) {
    const info = await mirror.stat(p);
    if (!info) throw new NotFound(p);
    if (info.size > MAX_RENDER_BYTES) return null;
    return mirror.readText(p);
  }

  function issueList(viewer, spec) {
    if (!issues) return { issues: [], error: 'no issue source configured' };
    const list = issues.query(spec).filter((i) => viewer.canSeeIssue(i));
    return {
      issues: list.map(({ body, ...rest }) => ({ ...rest, bodyHtml: body ? renderMarkdown(body) : '' })),
      error: issues.lastError,
      lastSync: issues.lastSync,
    };
  }

  const builders = {
    async digest(viewer, box) {
      const files = (await filesFor(viewer, box))
        .filter((f) => isMarkdown(f.path) && !isReadme(f.path))
        .sort((a, b) => b.path.localeCompare(a.path));
      const entries = [];
      for (const [i, f] of files.entries()) {
        const text = await readText(f.path);
        const entry = { path: f.path, title: text ? documentTitle(text, f.path) : path.posix.basename(f.path) };
        if (i < box.latest && text) entry.html = await renderFile(viewer, f.path, text);
        entries.push(entry);
      }
      return { entries };
    },

    async decisions(viewer, box) {
      const files = (await filesFor(viewer, box)).filter((f) => isMarkdown(f.path) && (!box.fallback || f.path !== box.fallback.file));
      const entries = [];
      for (const f of files) {
        if (isReadme(f.path)) continue;
        const text = (await readText(f.path)) ?? '';
        const { data, body } = splitFrontMatter(text);
        const field = (name) => data[name] ?? (new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*(.+)$`, 'im').exec(body)?.[1]?.trim() ?? null);
        const meta = { date: field('date'), status: field('status') };
        if (meta.date instanceof Date) meta.date = meta.date.toISOString().slice(0, 10);
        if (box.frontMatter) {
          const ok = Object.entries(box.frontMatter).every(([k, allowed]) => {
            const v = k === 'date' || k === 'status' ? meta[k] : data[k];
            return Array.isArray(allowed) ? allowed.map((a) => String(a).toLowerCase()).includes(String(v).toLowerCase()) : String(v) === String(allowed);
          });
          if (!ok) continue;
        }
        entries.push({ path: f.path, title: documentTitle(text, f.path), date: meta.date ? String(meta.date) : null, status: meta.status ? String(meta.status) : null });
      }
      entries.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.path.localeCompare(a.path));
      const out = { entries };
      if (!entries.length && box.fallback && viewer.canSeePath(box.fallback.file) && (await mirror.has(box.fallback.file))) {
        const text = (await readText(box.fallback.file)) ?? '';
        const secs = sections(splitFrontMatter(text).body, 6).filter((s) => !box.fallback.heading || box.fallback.heading.test(s.heading));
        const exists = await existsFn(viewer);
        out.fallback = { file: box.fallback.file, sections: secs.map((s) => ({ heading: s.heading, html: renderMarkdown(s.markdown, { file: box.fallback.file, exists }) })) };
      }
      return out;
    },

    async gallery(viewer, box, params = {}) {
      const files = await filesFor(viewer, box);
      const folderOf = (p) => {
        const root = box.roots.find((r) => p.startsWith(r));
        const rel = p.slice(root.length);
        const parts = rel.split('/');
        return { root, rel, folder: box.groupBy === 'none' || parts.length === 1 ? '' : parts[0] };
      };
      const images = files.filter((f) => imageType(f.path)).map((f) => ({ ...f, ...folderOf(f.path) }));
      const folders = new Map();
      for (const img of images) {
        const f = folders.get(img.folder) ?? { folder: img.folder, count: 0 };
        f.count++;
        folders.set(img.folder, f);
      }
      const folderList = [...folders.values()].sort((a, b) => (box.groupBy === 'date' ? b.folder.localeCompare(a.folder) : a.folder.localeCompare(b.folder)));
      const folder = typeof params.folder === 'string' ? params.folder : folderList.length === 1 ? folderList[0].folder : null;
      if (folder === null) return { folders: folderList };
      if (!folders.has(folder)) throw new NotFound(`no folder "${folder}"`);

      const items = images
        .filter((i) => i.folder === folder)
        .map((i) => {
          const name = path.posix.basename(i.path);
          const m = box.filenamePattern ? box.filenamePattern.exec(name) : null;
          const sub = path.posix.dirname(i.rel).split('/').slice(folder ? 1 : 0).join('/');
          return { path: i.path, name, subfolder: sub === '.' ? '' : sub, groups: m?.groups ? Object.fromEntries(Object.entries(m.groups).filter(([, v]) => v !== undefined)) : null };
        });
      const groupNames = box.filenamePattern ? [...box.filenamePattern.source.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]) : [];
      const filters = {};
      for (const g of groupNames) {
        const values = [...new Set(items.map((i) => i.groups?.[g]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (values.length > 1 || (values.length === 1 && items.some((i) => !i.groups?.[g]))) filters[g] = values;
      }
      const active = {};
      for (const g of Object.keys(filters)) if (typeof params[g] === 'string' && filters[g].includes(params[g])) active[g] = params[g];
      const shown = items.filter((i) => Object.entries(active).every(([g, v]) => i.groups?.[g] === v));
      const groupKey = groupNames.includes('page') ? 'page' : groupNames[0];
      const groups = new Map();
      for (const it of shown) {
        const key = it.subfolder ? `${it.subfolder}/` : groupKey && it.groups?.[groupKey] ? it.groups[groupKey] : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      let notes = null;
      if (box.notesFile) {
        for (const root of box.roots) {
          const np = `${root}${folder ? `${folder}/` : ''}${box.notesFile}`;
          if (viewer.canSeePath(np) && (await mirror.has(np))) {
            const text = (await readText(np)) ?? '';
            notes = { path: np, toc: headings(splitFrontMatter(text).body), html: await renderFile(viewer, np, text) };
            break;
          }
        }
      }
      return {
        folder,
        folders: folderList,
        filters,
        active,
        groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => ({ key, items: list })),
        notes,
      };
    },

    async documents(viewer, box) {
      const files = (await filesFor(viewer, box)).filter((f) => isMarkdown(f.path));
      if (box.sections) {
        const out = [];
        const exists = await existsFn(viewer);
        for (const f of files) {
          const text = (await readText(f.path)) ?? '';
          let secs = sections(splitFrontMatter(text).body, box.sections.level).filter((s) => box.sections.heading.test(s.heading));
          if (box.sections.latest) secs = secs.slice(-box.sections.latest).reverse();
          for (const s of secs) out.push({ path: f.path, heading: s.heading, html: renderMarkdown(s.markdown, { file: f.path, exists }) });
        }
        return { sections: out };
      }
      const documents = [];
      for (const f of files) {
        const text = await readText(f.path);
        documents.push({ path: f.path, title: text ? documentTitle(text, f.path) : path.posix.basename(f.path) });
      }
      return { documents };
    },

    async 'open-questions'(viewer, box) {
      const out = box.issues ? issueList(viewer, box.issues) : { issues: [] };
      out.documents = [];
      for (const f of (await filesFor(viewer, box)).filter((x) => isMarkdown(x.path))) {
        const text = (await readText(f.path)) ?? '';
        out.documents.push({ path: f.path, title: documentTitle(text, f.path), html: await renderFile(viewer, f.path, text) });
      }
      return out;
    },

    async issues(viewer, box) {
      return issueList(viewer, box.issues);
    },

    async 'source-browser'(viewer, box, params = {}) {
      const dir = typeof params.dir === 'string' && params.dir ? safeRepoPath(params.dir.replace(/\/$/, '')) : '';
      if (dir === null) throw new NotFound('bad dir');
      const prefix = dir ? `${dir}/` : '';
      const dirs = new Set();
      const files = [];
      for (const f of await filesFor(viewer, box)) {
        if (!f.path.startsWith(prefix)) continue;
        const rest = f.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash >= 0) dirs.add(prefix + rest.slice(0, slash));
        else files.push({ path: f.path, name: rest, size: f.size });
      }
      if (dir && !dirs.size && !files.length) throw new NotFound(`no folder "${dir}"`);
      return { dir, dirs: [...dirs].sort().map((d) => ({ path: d, name: d.slice(prefix.length) })), files };
    },
  };

  return {
    config,
    reachable,

    /** True once the source has been mirrored (no user data; used by /healthz). */
    healthy() {
      return Boolean(mirror.commitInfo);
    },

    status(viewer) {
      return {
        instance: { id: config.instance.id, title: config.instance.title, locale: config.instance.locale },
        role: viewer.role,
        policy: viewer.policy,
        source: { branch: config.source.branch, commit: mirror.commitInfo, lastSync: mirror.lastSync, error: mirror.lastError },
        issues: issues ? { lastSync: issues.lastSync, error: issues.lastError } : null,
        links: config.links,
      };
    },

    list_boxes(viewer) {
      return visibleBoxes(viewer).map((b) => ({ id: b.id, type: b.type, title: b.title, description: b.description, nav: b.nav, order: b.order }));
    },

    async get_box(viewer, id, params = {}) {
      const box = getBoxOrThrow(viewer, id);
      const data = await builders[box.type](viewer, box, params);
      return { box: { id: box.id, type: box.type, title: box.title, description: box.description, nav: box.nav, order: box.order }, ...data };
    },

    async get_document(viewer, p) {
      const safe = safeRepoPath(p);
      if (!safe || !isMarkdown(safe) || !reachable(viewer, safe) || !(await mirror.has(safe))) throw new NotFound(String(p));
      const text = await readText(safe);
      if (text === null) throw new NotFound('document too large');
      const body = splitFrontMatter(text).body;
      return {
        path: safe,
        title: documentTitle(text, safe),
        toc: headings(body).filter((h) => h.depth <= 3),
        html: await renderFile(viewer, safe, text),
        boxes: visibleBoxes(viewer).filter((b) => matchers.get(b.id)(safe)).map((b) => b.id),
      };
    },

    async get_file(viewer, p) {
      const safe = safeRepoPath(p);
      if (!safe || !reachable(viewer, safe)) throw new NotFound(String(p));
      const info = await mirror.stat(safe);
      if (!info) throw new NotFound(safe);
      if (isMarkdown(safe)) return { path: safe, kind: 'markdown', size: info.size, boxes: visibleBoxes(viewer).filter((b) => matchers.get(b.id)(safe)).map((b) => b.id) };
      if (imageType(safe)) return { path: safe, kind: 'image', size: info.size, boxes: visibleBoxes(viewer).filter((b) => matchers.get(b.id)(safe)).map((b) => b.id) };
      if (info.size > MAX_RENDER_BYTES) return { path: safe, kind: 'binary', size: info.size, boxes: visibleBoxes(viewer).filter((b) => matchers.get(b.id)(safe)).map((b) => b.id) };
      const buf = await mirror.read(safe);
      if (!looksLikeText(buf)) return { path: safe, kind: 'binary', size: info.size, boxes: visibleBoxes(viewer).filter((b) => matchers.get(b.id)(safe)).map((b) => b.id) };
      return { path: safe, kind: 'text', size: info.size, text: buf.toString('utf8'), boxes: visibleBoxes(viewer).filter((b) => matchers.get(b.id)(safe)).map((b) => b.id) };
    },

    /** Raw bytes for images (and plain text for anything else). */
    async read_raw(viewer, p) {
      const safe = safeRepoPath(p);
      if (!safe || !reachable(viewer, safe) || !(await mirror.has(safe))) throw new NotFound(String(p));
      const type = imageType(safe);
      return { path: safe, contentType: type ?? 'text/plain; charset=utf-8', body: await mirror.read(safe) };
    },

    async search(viewer, q, { limit = 50 } = {}) {
      const query = String(q ?? '').trim();
      if (query.length < 2 || query.length > 200) return { query, results: [] };
      const needle = query.toLowerCase();
      const results = [];
      const seen = new Set();
      for (const box of visibleBoxes(viewer)) {
        if (!SEARCHABLE_TYPES.has(box.type)) continue;
        for (const f of await filesFor(viewer, box)) {
          if (seen.has(f.path) || !isMarkdown(f.path) || f.size > MAX_RENDER_BYTES) continue;
          seen.add(f.path);
          const text = await mirror.readText(f.path);
          if (!text.toLowerCase().includes(needle) && !f.path.toLowerCase().includes(needle)) continue;
          results.push({ kind: 'document', path: f.path, box: box.id, title: documentTitle(text, f.path), snippet: snippet(plainText(text), query) });
          if (results.length >= limit) return { query, results };
        }
      }
      if (issues) {
        const seenIssues = new Set();
        for (const box of visibleBoxes(viewer)) {
          if (!box.issues) continue;
          for (const i of issues.query({ labels: box.issues.labels, state: 'all' })) {
            if (seenIssues.has(i.number) || !viewer.canSeeIssue(i)) continue;
            if (!`${i.title}\n${i.body}`.toLowerCase().includes(needle)) continue;
            seenIssues.add(i.number);
            results.push({ kind: 'issue', number: i.number, title: i.title, url: i.url, state: i.state, box: box.id, snippet: snippet(i.body || i.title, query) });
            if (results.length >= limit) return { query, results };
          }
        }
      }
      return { query, results };
    },
  };
}
