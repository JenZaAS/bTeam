// Server-rendered HTML views. No scripts, no external assets, only relative links,
// so the UI works on its own, behind a path prefix and inside a sandboxed iframe.
import { escapeHtml as e, isMarkdown } from './util.js';
import { localized } from './config.js';

const q = encodeURIComponent;

/** Order for the signed-in nav. Unset order sorts last; equal ranks keep input order. Does not mutate. */
export function sortNavBoxes(boxes) {
  return boxes
    .map((box, index) => ({ box, index }))
    .sort((a, b) => {
      const ao = a.box.order == null;
      const bo = b.box.order == null;
      if (ao || bo) return (ao - bo) || (a.index - b.index);
      return (a.box.order - b.box.order) || (a.index - b.index);
    })
    .map(({ box }) => box);
}

/** Split a list into primary and advanced. Does not sort. A missing nav stays primary. */
export function splitNavBoxes(boxes) {
  return {
    primary: boxes.filter((b) => b.nav !== 'advanced'),
    advanced: boxes.filter((b) => b.nav === 'advanced'),
  };
}

export function layout({ t, locale, status, primaryBoxes, title, body, currentBox = null, query = '', user = null, section = null, flash = null }) {
  const nav = primaryBoxes
    .map((b) => `<li><a href="box?id=${q(b.id)}"${b.id === currentBox ? ' aria-current="page"' : ''}>${e(localized(b.title, locale))}</a></li>`)
    .join('');
  return `<!doctype html>
<html lang="${e(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${e(title ? `${title} · ` : '')}${e(status.instance.title)}</title>
<link rel="stylesheet" href="assets/base.css">
<link rel="stylesheet" href="theme.css">
</head>
<body>
<header class="bt-header">
  <a class="bt-brand" href="./">${e(status.instance.title)}</a>
  ${user ? `<form class="bt-search" action="search" method="get" role="search">
    <input type="search" name="q" value="${e(query)}" placeholder="${e(t.searchPlaceholder)}" aria-label="${e(t.search)}" minlength="2" maxlength="200">
    <button type="submit">${e(t.search)}</button>
  </form>` : ''}
</header>
${user ? `<nav class="bt-nav" aria-label="${e(t.mainNav)}"><ul><li><a href="./"${currentBox === '' ? ' aria-current="page"' : ''}>${e(t.home)}</a></li>${nav}${
    user.workshop ? `<li class="bt-nav-app"><a href="workshop"${section === 'workshop' ? ' aria-current="page"' : ''}>${e(t.workshop)}</a></li>` : ''
  }${user.inbox ? `<li class="bt-nav-app"><a href="inbox"${section === 'inbox' ? ' aria-current="page"' : ''}>${e(t.inbox)}</a></li>` : ''}<li class="bt-nav-more"><a href="advanced"${section === 'advanced' ? ' aria-current="page"' : ''}>${e(t.more)}</a></li></ul></nav>` : ''}
${user?.dev ? `<p class="bt-warn bt-dev">${e(t.devOverride)}</p>` : ''}
<main class="bt-main">
${flash ? `<p class="bt-flash" role="status">${e(flash)}</p>` : ''}
${body}
</main>
<footer class="bt-footer"><span>${user ? `<a class="bt-nav-more" href="advanced">${e(t.more)}</a>` : ''}${
    currentBox === '' && user && status.links?.length
      ? status.links.map((l) => ` <a class="bt-ext" href="${e(l.url)}" rel="noopener noreferrer">${e(l.label)}</a>`).join('')
      : ''
  }</span>${
    user
      ? `<span>${e(t.signedInAs)} ${currentBox === '' ? e(user.id) : `<code>${e(user.id)}</code>`} (${e(t.role)}: ${currentBox === '' ? e(user.role) : `<code>${e(user.role)}</code>`})${
          user.dev ? '' : ` <form class="bt-logout" action="logout" method="post"><input type="hidden" name="csrf" value="${e(user.csrf)}"><button type="submit">${e(t.logout)}</button></form>`
        }</span>`
      : ''
  }</footer>
</body>
</html>`;
}

const docLink = (p, label) => `<a href="doc?path=${q(p)}">${e(label)}</a>`;
const pathNote = (p) => `<span class="bt-path">${e(p)}</span>`;

function issueItems(t, list) {
  if (!list.length) return `<p class="bt-empty">${e(t.empty)}</p>`;
  return `<ul class="bt-issues">${list
    .map(
      (i) => `<li class="bt-issue bt-${e(i.state)}">
  <div class="bt-issue-head"><span class="bt-num">#${e(i.number)}</span> ${i.url ? `<a href="${e(i.url)}" rel="noopener noreferrer">${e(i.title)}</a>` : e(i.title)}
  <span class="bt-state">${e(i.state === 'open' ? t.open : t.closed)}</span></div>
  ${i.labels.length ? `<div class="bt-labels">${i.labels.map((l) => `<span class="bt-label">${e(l)}</span>`).join('')}</div>` : ''}
  ${i.bodyHtml ? `<details><summary>${e(t.contents)}</summary><div class="bt-md">${i.bodyHtml}</div></details>` : ''}
</li>`,
    )
    .join('')}</ul>`;
}

function plainText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Items for one Overview teaser. An empty list means the teaser is left out.
 * Decision records only: a box fallback section is never a teaser.
 */
export function teaserItems(kind, data, max = 3) {
  const limit = Number.isInteger(max) && max > 0 ? max : 3;
  if (kind === 'decisions') {
    return (data?.entries ?? []).slice(0, limit).map((x) => ({
      label: x.title,
      href: `doc?path=${q(x.path)}`,
    }));
  }
  if (kind === 'digest') {
    return (data?.entries ?? []).slice(0, limit).filter((x) => x.title).map((entry, i) => {
      const item = { label: entry.title, href: `doc?path=${q(entry.path)}` };
      if (i === 0 && entry.html) {
        const para = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(entry.html);
        let text = plainText(para ? para[1] : entry.html);
        if (text.startsWith(entry.title)) text = text.slice(entry.title.length).trim();
        if (text.length > 180) text = `${text.slice(0, 179).trimEnd()}…`;
        if (text) item.detail = text;
      }
      return item;
    });
  }
  if (kind === 'questions') {
    const out = [];
    for (const issue of data?.issues ?? []) {
      if (out.length >= limit || !issue.title) continue;
      const href = typeof issue.url === 'string' && /^https:\/\//.test(issue.url) ? issue.url : null;
      out.push({ label: issue.title, href, external: Boolean(href) });
    }
    for (const doc of data?.documents ?? []) {
      if (out.length >= limit || !doc.title) continue;
      out.push({ label: doc.title, href: `doc?path=${q(doc.path)}` });
    }
    return out;
  }
  return [];
}

function featureLinks(t, features) {
  const items = [];
  if (features.docs) items.push(`<a href="docs/">${e(t.docs)}</a>`);
  if (features.workshop) items.push(`<a href="workshop">${e(t.workshop)}</a>`);
  if (features.inbox) items.push(`<a href="inbox">${e(t.inbox)}</a>`);
  if (!items.length) return '';
  return `<nav class="bt-home-links" aria-label="${e(t.links)}">${items.join('')}</nav>`;
}

function doorCard(door, locale) {
  const tag = localized(door.tag, locale);
  const blurb = localized(door.blurb, locale);
  return `<li><a class="bt-door" href="${e(door.href)}">${
    tag ? `<p class="bt-door-tag">${e(tag)}</p>` : ''
  }<h2>${e(localized(door.label, locale))}</h2>${blurb ? `<p class="bt-door-blurb">${e(blurb)}</p>` : ''}</a></li>`;
}

function smallLinks(t, links, locale) {
  if (!links?.length) return '';
  const inner = links.map((l) => `<a href="${e(l.href)}">${e(localized(l.label, locale))}</a>`).join('');
  return `<nav class="bt-home-links" aria-label="${e(t.links)}">${inner}</nav>`;
}

function teaserSection(teasers) {
  if (!teasers.length) return '';
  const blocks = teasers.map((teaser) => {
    const items = teaser.items.map((item) => {
      const href = item.href || `box?id=${q(teaser.boxId)}`;
      const rel = item.external ? ' rel="noopener noreferrer"' : '';
      const detail = item.detail ? `<span class="bt-teaser-detail">${e(item.detail)}</span>` : '';
      return `<li><a href="${e(href)}"${rel}>${e(item.label)}${detail}</a></li>`;
    }).join('');
    return `<article class="bt-teaser"><h2><a href="box?id=${q(teaser.boxId)}">${e(teaser.title)}</a></h2><ul>${items}</ul></article>`;
  }).join('');
  return `<section class="bt-teasers">${blocks}</section>`;
}

/**
 * Overview. With a home block: one-sentence hero, configured doors, optional small links
 * and teasers that already have items. Without one: a generic welcome and links to the
 * features that are turned on. Project wording stays in the instance config.
 */
export function homeView({ t, locale, status, home = null, teasers = [], features = {} }) {
  const err = status?.source?.error ? `<p class="bt-warn">${e(status.source.error)}</p>` : '';
  if (!home) return `${err}<h1 class="bt-hero">${e(t.homeFallback)}</h1>${featureLinks(t, features)}`;
  const doors = (home.doors ?? []).map((d) => doorCard(d, locale)).join('');
  return `${err}<h1 class="bt-hero">${e(localized(home.hero, locale))}</h1><ul class="bt-doors">${doors}</ul>${smallLinks(t, home.links, locale)}${teaserSection(teasers)}`;
}

/** Mirror commit and sync time, copied from the old signed-in footer. Ignores source and issue errors. */
function sourceLine(t, status) {
  const c = status.source.commit;
  return c
    ? `${e(t.sourceCommit)}: <code>${e(c.short)}</code> (${e(String(c.date).slice(0, 16).replace('T', ' '))})${status.source.lastSync ? ` · ${e(t.syncedAt)} ${e(status.source.lastSync.slice(0, 16).replace('T', ' '))} UTC` : ''}`
    : e(t.notSynced);
}

export function advancedView({ t, locale, advancedBoxes, status }) {
  const items = advancedBoxes
    .map((b) => {
      const desc = localized(b.description, locale);
      return `<li><a class="bt-advanced-link" href="box?id=${q(b.id)}">${e(localized(b.title, locale))}</a>${desc ? `<p>${e(desc)}</p>` : ''}</li>`;
    })
    .join('');
  const list = advancedBoxes.length ? `<ul>${items}</ul>` : '';
  return `<h1>${e(t.advanced)}</h1>${list}<p class="bt-source bt-source-meta">${sourceLine(t, status)}</p>`;
}

export function boxView({ t, locale, data, params }) {
  const { box } = data;
  const title = localized(box.title, locale);
  const desc = box.description ? `<p class="bt-desc">${e(localized(box.description, locale))}</p>` : '';
  let body = '';
  switch (box.type) {
    case 'digest': {
      const latest = data.entries.filter((x) => x.html);
      const older = data.entries.filter((x) => !x.html);
      body =
        (latest.length ? latest.map((x) => `<article class="bt-md">${x.html}<p>${pathNote(x.path)}</p></article>`).join('') : `<p class="bt-empty">${e(t.empty)}</p>`) +
        (older.length ? `<h2>${e(t.older)}</h2><ul>${older.map((x) => `<li>${docLink(x.path, x.title)}</li>`).join('')}</ul>` : '');
      break;
    }
    case 'decisions': {
      if (data.entries.length)
        body = `<ul class="bt-list">${data.entries
          .map((x) => `<li>${docLink(x.path, x.title)}${x.date ? ` <span class="bt-date">${e(x.date)}</span>` : ''}${x.status ? ` <span class="bt-label">${e(x.status)}</span>` : ''}</li>`)
          .join('')}</ul>`;
      else if (data.fallback?.sections.length)
        body = `<p class="bt-note">${e(t.fallbackNote)} ${docLink(data.fallback.file, data.fallback.file)}</p>${data.fallback.sections.map((s) => `<article class="bt-md">${s.html}</article>`).join('')}`;
      else body = `<p class="bt-empty">${e(t.empty)}</p>`;
      break;
    }
    case 'gallery': {
      if (data.folder === undefined) {
        body = data.folders.length
          ? `<h2>${e(t.folders)}</h2><ul class="bt-list">${data.folders.map((f) => `<li><a href="box?id=${q(box.id)}&amp;folder=${q(f.folder)}">${e(f.folder || '/')}</a> <span class="bt-count">${f.count}</span></li>`).join('')}</ul>`
          : `<p class="bt-empty">${e(t.empty)}</p>`;
        break;
      }
      const base = `box?id=${q(box.id)}&folder=${q(data.folder)}`;
      const filterHtml = Object.entries(data.filters)
        .map(([g, values]) => {
          const other = Object.entries(data.active).filter(([k]) => k !== g).map(([k, v]) => `&${q(k)}=${q(v)}`).join('');
          const opt = (v, label) => `<a href="${e(base + other + (v ? `&${q(g)}=${q(v)}` : ''))}"${(data.active[g] ?? '') === v ? ' aria-current="true"' : ''}>${e(label)}</a>`;
          return `<div class="bt-filter"><span>${e(g)}:</span> ${opt('', t.all)} ${values.map((v) => opt(v, v)).join(' ')}</div>`;
        })
        .join('');
      const folderNav = data.folders.length > 1 ? `<p><a href="box?id=${q(box.id)}">${e(t.folders)}</a> / <strong>${e(data.folder || '/')}</strong></p>` : '';
      const groups = data.groups
        .map(
          (g) => `<section class="bt-group">${g.key ? `<h3>${e(g.key)}</h3>` : ''}<div class="bt-grid">${g.items
            .map((it) => {
              const cap = it.groups ? Object.entries(it.groups).filter(([k]) => k !== 'page').map(([, v]) => v).join(' · ') : it.name;
              return `<figure><a href="raw?path=${q(it.path)}"><img src="raw?path=${q(it.path)}" alt="${e(it.name)}" loading="lazy"></a><figcaption>${e(cap || it.name)}</figcaption></figure>`;
            })
            .join('')}</div></section>`,
        )
        .join('');
      const notes = data.notes
        ? `<details class="bt-notes"><summary>${e(t.notes)}: ${e(data.notes.path.split('/').pop())}</summary><div class="bt-md">${data.notes.html}</div></details>`
        : '';
      body = folderNav + filterHtml + notes + (groups || `<p class="bt-empty">${e(t.empty)}</p>`);
      break;
    }
    case 'documents': {
      if (data.sections)
        body = data.sections.length
          ? data.sections.map((s) => `<article class="bt-md">${s.html}<p>${docLink(s.path, s.path)}</p></article>`).join('')
          : `<p class="bt-empty">${e(t.empty)}</p>`;
      else
        body = data.documents.length
          ? `<ul class="bt-list">${data.documents.map((d) => `<li>${docLink(d.path, d.title)} ${pathNote(d.path)}</li>`).join('')}</ul>`
          : `<p class="bt-empty">${e(t.empty)}</p>`;
      break;
    }
    case 'open-questions':
    case 'issues': {
      const err = data.error ? `<p class="bt-warn">${e(t.issuesUnavailable)}</p>` : '';
      body = err + issueItems(t, data.issues ?? []);
      if (data.documents?.length) body += data.documents.map((d) => `<article class="bt-md">${d.html}<p>${pathNote(d.path)}</p></article>`).join('');
      break;
    }
    case 'source-browser': {
      const crumbs = [`<a href="box?id=${q(box.id)}">${e(t.root)}</a>`];
      let acc = '';
      for (const part of data.dir ? data.dir.split('/') : []) {
        acc = acc ? `${acc}/${part}` : part;
        crumbs.push(`<a href="box?id=${q(box.id)}&amp;dir=${q(acc)}">${e(part)}</a>`);
      }
      body = `<p class="bt-crumbs">${crumbs.join(' / ')}</p><ul class="bt-tree">${data.dirs
        .map((d) => `<li class="bt-dir"><a href="box?id=${q(box.id)}&amp;dir=${q(d.path)}">${e(d.name)}/</a></li>`)
        .join('')}${data.files.map((f) => `<li class="bt-file"><a href="file?path=${q(f.path)}">${e(f.name)}</a> <span class="bt-count">${f.size} B</span></li>`).join('')}</ul>`;
      break;
    }
  }
  return { title, html: `<h1>${e(title)}</h1>${desc}${body}` };
}

export function documentView({ t, doc }) {
  const toc =
    doc.toc.length > 2
      ? `<details class="bt-toc" open><summary>${e(t.contents)}</summary><ul>${doc.toc.map((h) => `<li class="bt-toc-${h.depth}"><a href="#${q(h.slug)}">${e(h.text)}</a></li>`).join('')}</ul></details>`
      : '';
  return `<p>${pathNote(doc.path)} · <a href="file?path=${q(doc.path)}">${e(t.download)}</a></p>${toc}<article class="bt-md">${doc.html}</article>`;
}

export function fileView({ t, file }) {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  let inner;
  if (file.kind === 'image') inner = `<img class="bt-full" src="raw?path=${q(file.path)}" alt="${e(file.path)}">`;
  else if (file.kind === 'markdown') inner = `<p><a href="doc?path=${q(file.path)}">${e(file.path)}</a> · <a href="raw?path=${q(file.path)}">${e(t.download)}</a></p>`;
  else if (file.kind === 'text') inner = `<pre class="bt-code"><code>${e(file.text)}</code></pre>`;
  else inner = `<p class="bt-empty">${e(t.binary)}</p>`;
  return `<h1>${e(file.path.split('/').pop())}</h1><p>${pathNote(dir || '/')} · ${file.size} B</p>${inner}`;
}

export function searchView({ t, result }) {
  const items = result.results
    .map((r) =>
      r.kind === 'issue'
        ? `<li>#${e(r.number)} ${r.url ? `<a href="${e(r.url)}" rel="noopener noreferrer">${e(r.title)}</a>` : e(r.title)}<p>${e(r.snippet)}</p></li>`
        : `<li>${isMarkdown(r.path) ? docLink(r.path, r.title) : `<a href="file?path=${q(r.path)}">${e(r.title)}</a>`} ${pathNote(r.path)}<p>${e(r.snippet)}</p></li>`,
    )
    .join('');
  return `<h1>${e(t.search)}: ${e(result.query)}</h1>${items ? `<ul class="bt-results">${items}</ul>` : `<p class="bt-empty">${e(t.noResults)}</p>`}`;
}

export function notFoundView({ t }) {
  return `<h1>${e(t.notFound)}</h1><p>${e(t.notFoundText)}</p><p><a href="./">${e(t.home)}</a></p>`;
}
