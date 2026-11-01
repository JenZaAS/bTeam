// Server-rendered HTML views. No scripts, no external assets, only relative links,
// so the UI works on its own, behind a path prefix and inside a sandboxed iframe.
import { escapeHtml as e } from './util.js';
import { localized } from './config.js';

const q = encodeURIComponent;

export function layout({ t, locale, status, boxes, title, body, currentBox = null, query = '', user = null, section = null, flash = null }) {
  const nav = boxes
    .map((b) => `<li><a href="box?id=${q(b.id)}"${b.id === currentBox ? ' aria-current="page"' : ''}>${e(localized(b.title, locale))}</a></li>`)
    .join('');
  const c = status.source.commit;
  const src = c
    ? `${e(t.sourceCommit)}: <code>${e(c.short)}</code> (${e(String(c.date).slice(0, 16).replace('T', ' '))})${status.source.lastSync ? ` · ${e(t.syncedAt)} ${e(status.source.lastSync.slice(0, 16).replace('T', ' '))} UTC` : ''}`
    : e(t.notSynced);
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
${user ? `<nav class="bt-nav" aria-label="${e(t.home)}"><ul><li><a href="./"${currentBox === '' ? ' aria-current="page"' : ''}>${e(t.home)}</a></li>${nav}${
    user.workshop ? `<li class="bt-nav-app"><a href="workshop"${section === 'workshop' ? ' aria-current="page"' : ''}>${e(t.workshop)}</a></li>` : ''
  }${user.inbox ? `<li class="bt-nav-app"><a href="inbox"${section === 'inbox' ? ' aria-current="page"' : ''}>${e(t.inbox)}</a></li>` : ''}</ul></nav>` : ''}
${user?.dev ? `<p class="bt-warn bt-dev">${e(t.devOverride)}</p>` : ''}
<main class="bt-main">
${flash ? `<p class="bt-flash" role="status">${e(flash)}</p>` : ''}
${body}
</main>
<footer class="bt-footer"><span>${user ? src : ''}</span>${
    user
      ? `<span>${e(t.signedInAs)} <code>${e(user.id)}</code> (${e(t.role)}: <code>${e(user.role)}</code>)${
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

export function homeView({ t, locale, boxes, status }) {
  const cards = boxes
    .map(
      (b) => `<li class="bt-card"><a href="box?id=${q(b.id)}"><strong>${e(localized(b.title, locale))}</strong></a>${
        b.description ? `<p>${e(localized(b.description, locale))}</p>` : ''
      }<span class="bt-type">${e(b.type)}</span></li>`,
    )
    .join('');
  const links = status.links.length
    ? `<section><h2>${e(t.links)}</h2><ul>${status.links.map((l) => `<li><a href="${e(l.url)}" rel="noopener noreferrer">${e(l.label)}</a></li>`).join('')}</ul></section>`
    : '';
  const err = status.source.error ? `<p class="bt-warn">${e(status.source.error)}</p>` : '';
  return `<h1>${e(t.home)}</h1>${err}<ul class="bt-cards">${cards}</ul>${links}`;
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
        : `<li>${docLink(r.path, r.title)} ${pathNote(r.path)}<p>${e(r.snippet)}</p></li>`,
    )
    .join('');
  return `<h1>${e(t.search)}: ${e(result.query)}</h1>${items ? `<ul class="bt-results">${items}</ul>` : `<p class="bt-empty">${e(t.noResults)}</p>`}`;
}

export function notFoundView({ t }) {
  return `<h1>${e(t.notFound)}</h1><p>${e(t.notFoundText)}</p><p><a href="./">${e(t.home)}</a></p>`;
}
