// Views for login, the per-user Workshop and the Inbox. Server-rendered, no scripts.
import { escapeHtml as e } from './util.js';
import { renderMarkdown } from './markdown.js';
import { WORKSHOP_KINDS } from './workshop.js';
import { INBOX_KINDS } from './inbox.js';

const q = encodeURIComponent;
const csrfField = (csrf) => `<input type="hidden" name="csrf" value="${e(csrf)}">`;
const when = (iso) => e(String(iso).slice(0, 16).replace('T', ' ')) + ' UTC';
const errorBox = (t, error) => (error ? `<p class="bt-warn" role="alert">${e(t.formError)}: ${e(error)}</p>` : '');
const md = (text) => renderMarkdown(text ?? '', { file: '', exists: () => false });

export function loginView({ t, error = false, next = './', pre }) {
  return `<h1>${e(t.login)}</h1>
${error ? `<p class="bt-warn" role="alert">${e(error === true ? t.loginFailed : error)}</p>` : ''}
<form class="bt-form" action="login" method="post">
  <input type="hidden" name="pre" value="${e(pre)}">
  <input type="hidden" name="next" value="${e(next)}">
  <label>${e(t.userId)} <input name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="64"></label>
  <label>${e(t.password)} <input name="password" type="password" autocomplete="current-password" required maxlength="256"></label>
  <button type="submit">${e(t.login)}</button>
</form>`;
}

function kindOptions(t, kinds, selected) {
  return kinds.map((k) => `<option value="${e(k)}"${k === selected ? ' selected' : ''}>${e(t.kinds[k] ?? k)}</option>`).join('');
}

export function workshopListView({ t, items, csrf, error = null, draft = {} }) {
  const list = items.length
    ? `<ul class="bt-list">${items
        .map((i) => `<li><a href="workshop-item?id=${i.id}">${e(i.title)}</a> <span class="bt-label">${e(t.kinds[i.kind] ?? i.kind)}</span> <span class="bt-date">${when(i.updatedAt)}</span></li>`)
        .join('')}</ul>`
    : `<p class="bt-empty">${e(t.empty)}</p>`;
  return `<h1>${e(t.workshop)}</h1><p class="bt-desc">${e(t.workshopIntro)}</p>${errorBox(t, error)}${list}
<details class="bt-new"${error ? ' open' : ''}><summary>${e(t.newItem)}</summary>${workshopForm(t, { csrf, item: draft })}</details>`;
}

function workshopForm(t, { csrf, item = {} }) {
  return `<form class="bt-form" action="workshop-save" method="post">${csrfField(csrf)}
  ${item.id ? `<input type="hidden" name="id" value="${e(item.id)}"><input type="hidden" name="version" value="${e(item.version)}">` : ''}
  <label>${e(t.kind)} <select name="kind">${kindOptions(t, WORKSHOP_KINDS, item.kind ?? 'note')}</select></label>
  <label>${e(t.title)} <input name="title" required maxlength="200" value="${e(item.title ?? '')}"></label>
  <label>${e(t.text)} <textarea name="body" rows="14" maxlength="50000">${e(item.body ?? '')}</textarea></label>
  <button type="submit">${e(t.save)}</button>
</form>`;
}

export function workshopItemView({ t, item, history, csrf, editing = false, error = null }) {
  const view = editing
    ? workshopForm(t, { csrf, item })
    : `<article class="bt-md">${md(item.body)}</article><p><a href="workshop-item?id=${item.id}&amp;edit=1">${e(t.edit)}</a></p>`;
  const hist = history.length
    ? `<details><summary>${e(t.history)} (${history.length})</summary><ul class="bt-list">${history
        .map((h) => `<li>${e(t.version)} ${h.version}: ${e(h.title)} <span class="bt-date">${when(h.createdAt)}</span><details><summary>${e(t.text)}</summary><div class="bt-md">${md(h.body)}</div></details></li>`)
        .join('')}</ul></details>`
    : '';
  return `<p><a href="workshop">${e(t.workshop)}</a></p><h1>${e(item.title)}</h1>
<p><span class="bt-label">${e(t.kinds[item.kind] ?? item.kind)}</span> <span class="bt-date">${e(t.updated)} ${when(item.updatedAt)}</span></p>
${errorBox(t, error)}${view}${hist}
<details class="bt-danger"><summary>${e(t.delete)}</summary><form action="workshop-delete" method="post">${csrfField(csrf)}<input type="hidden" name="id" value="${e(item.id)}"><button type="submit">${e(t.confirmDelete)}</button></form></details>
<details><summary>${e(t.sendToInbox)}</summary>${inboxForm(t, { csrf, refs: [], draft: { title: item.title, body: item.body, workshopItemId: item.id, kind: item.kind === 'idea' ? 'idea' : 'ui' } })}</details>`;
}

function inboxForm(t, { csrf, refs, draft = {} }) {
  const refOptions = [`<option value="">${e(t.nothing)}</option>`, ...refs.map((r) => `<option value="${e(r.value)}"${r.value === draft.ref ? ' selected' : ''}>${e(r.label)}</option>`)].join('');
  return `<form class="bt-form" action="inbox-submit" method="post">${csrfField(csrf)}
  ${draft.workshopItemId ? `<input type="hidden" name="workshop_item_id" value="${e(draft.workshopItemId)}">` : ''}
  <label>${e(t.kind)} <select name="kind">${kindOptions(t, INBOX_KINDS, draft.kind ?? 'idea')}</select></label>
  <label>${e(t.title)} <input name="title" required maxlength="200" value="${e(draft.title ?? '')}"></label>
  <label>${e(t.text)} <textarea name="body" rows="10" maxlength="20000">${e(draft.body ?? '')}</textarea></label>
  ${refs.length ? `<label>${e(t.relatesTo)} <select name="ref">${refOptions}</select></label>` : ''}
  <button type="submit">${e(t.send)}</button>
</form>`;
}

const statusBadge = (t, s) => `<span class="bt-label bt-status-${e(s)}">${e(t.statuses[s] ?? s)}</span>`;

export function inboxListView({ t, items, csrf, refs, error = null, draft = {} }) {
  const list = items.length
    ? `<ul class="bt-list">${items
        .map((i) => `<li><a href="inbox-item?id=${i.id}">${e(i.title)}</a> <span class="bt-label">${e(t.kinds[i.kind] ?? i.kind)}</span> ${statusBadge(t, i.status)} <span class="bt-date">${when(i.updatedAt)}</span></li>`)
        .join('')}</ul>`
    : `<p class="bt-empty">${e(t.empty)}</p>`;
  return `<h1>${e(t.inbox)}</h1><p class="bt-desc">${e(t.inboxIntro)}</p>${errorBox(t, error)}
<details class="bt-new"${error ? ' open' : ''}><summary>${e(t.newItem)}</summary>${inboxForm(t, { csrf, refs, draft })}</details>${list}`;
}

export function inboxItemView({ t, item, csrf, refLabel = null, error = null }) {
  const thread = item.messages.length
    ? `<h2>${e(t.replies)}</h2><ul class="bt-thread">${item.messages
        .map((m) => `<li class="${m.author.startsWith('user:') ? 'bt-mine' : 'bt-team'}"><div class="bt-md">${md(m.body)}</div><span class="bt-date">${when(m.at)}</span></li>`)
        .join('')}</ul>`
    : '';
  const answer =
    item.status === 'question-back'
      ? `<form class="bt-form" action="inbox-reply" method="post">${csrfField(csrf)}<input type="hidden" name="id" value="${e(item.id)}"><label>${e(t.answer)} <textarea name="body" rows="6" required maxlength="20000"></textarea></label><button type="submit">${e(t.send)}</button></form>`
      : '';
  return `<p><a href="inbox">${e(t.inbox)}</a></p><h1>${e(item.title)}</h1>
<p><span class="bt-label">${e(t.kinds[item.kind] ?? item.kind)}</span> ${statusBadge(t, item.status)} <span class="bt-route">${e(t.routes[item.route] ?? item.route)}</span></p>
<p class="bt-date">${e(t.submitted)} ${when(item.createdAt)} · ${e(t.updated)} ${when(item.updatedAt)}</p>
${refLabel ? `<p>${e(t.relatesTo)}: ${refLabel}</p>` : ''}
${item.issueUrl ? `<p>${e(t.issue)}: <a href="${e(item.issueUrl)}" rel="noopener noreferrer">${e(item.issueUrl)}</a></p>` : ''}
<article class="bt-md">${md(item.body)}</article>${errorBox(t, error)}${thread}${answer}`;
}
