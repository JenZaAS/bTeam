// HTTP server: login, the read-only views, the per-user Workshop and the Inbox.
// Every page except /login, /healthz and the two stylesheets needs a signed-in user.
// The role (and so the visibility rules) always comes from the signed-in user.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NotFound } from './core.js';
import { strings, pickLocale } from './i18n.js';
import { createViewer } from './visibility.js';
import { layout, homeView, advancedView, boxView, documentView, fileView, searchView, notFoundView, sortNavBoxes, splitNavBoxes } from './views.js';
import { loginView, workshopListView, workshopItemView, inboxListView, inboxItemView } from './views-app.js';
import { parseCookies, serializeCookie, readForm, BodyError, clientAddress, isLoopbackAddress, safeNext, sameOrigin } from './http.js';
import { randomToken, safeEqual } from './auth.js';
import { WorkshopError } from './workshop.js';
import { InboxError } from './inbox.js';
import { escapeHtml as e, safeRepoPath } from './util.js';
import { localized } from './config.js';
import { readDocsFile, cacheControlFor } from './docs-static.js';

const BASE_CSS = fs.readFileSync(fileURLToPath(new URL('./assets/base.css', import.meta.url)), 'utf8');
const PUBLIC_PATHS = new Set(['/login', '/healthz', '/assets/base.css', '/theme.css']);
const FLASH = { saved: 'saved', sent: 'sent', deleted: 'deleted' };
// randomToken(24) is 24 bytes of unpadded base64url, which is exactly 32 characters.
const PRE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * @param {object} o
 * @param {object} o.core            read tools
 * @param {object} o.auth            accounts and sessions (src/auth.js)
 * @param {object} [o.workshop]      per-user Workshop (src/workshop.js)
 * @param {object} [o.inbox]         Inbox (src/inbox.js)
 * @param {string} [o.themeCss]
 * @param {string|null} [o.devUser]  development only: act as this existing user for loopback clients, no login
 */
export function createHandler({ core, auth, workshop = null, inbox = null, themeCss = '', devUser = null, docsDir = null }) {
  const config = core.config;
  const web = config.web;
  const secure = web.secureCookies;
  const sessionCookie = secure ? '__Host-bteam_session' : 'bteam_session';
  const preCookie = secure ? '__Host-bteam_pre' : 'bteam_pre';
  const cookieOpts = { secure, sameSite: web.sameSite };
  const devCsrf = randomToken(24);
  const viewers = new Map();
  const viewerFor = (role) => {
    if (!viewers.has(role)) viewers.set(role, createViewer(config, role));
    return viewers.get(role);
  };
  const workshopOn = Boolean(workshop && config.workshop.enabled);
  const inboxOn = Boolean(inbox && config.inbox.enabled);

  const csp = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${web.frameAncestors.join(' ')}`,
  ].join('; ');

  function send(res, status, type, body, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(body);
  }
  const redirect = (res, location, cookies = [], extra = {}) => send(res, 303, 'text/plain; charset=utf-8', 'see other', { Location: location, ...extra, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });

  /** Resolve who is asking: a real session, the loopback-only dev user, or nobody. */
  function identify(req, cookies) {
    if (devUser && isLoopbackAddress(req.socket.remoteAddress)) {
      const u = auth.getUser(devUser);
      if (u && !u.disabled && config.roles[u.role]) return { userId: u.id, role: u.role, csrf: devCsrf, dev: true };
    }
    const s = auth.getSession(cookies[sessionCookie]);
    return s ? { ...s, dev: false, token: cookies[sessionCookie] } : null;
  }

  return async function handler(req, res) {
    const isPost = req.method === 'POST';
    const rawPath = String(req.url ?? '').split('?')[0];
    const docsRequest = rawPath === '/docs' || rawPath.startsWith('/docs/') || rawPath.startsWith('/docs%');
    if (!isPost && req.method !== 'GET' && req.method !== 'HEAD') {
      const extra = { Allow: 'GET, HEAD, POST' };
      if (docsRequest) {
        extra['X-Robots-Tag'] = 'noindex';
        extra['Cache-Control'] = 'private, no-store';
      }
      return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', extra);
    }
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
    }
    const params = Object.fromEntries(url.searchParams);
    const locales = config.instance.locale;
    const locale = locales.includes(params.lang) ? params.lang : pickLocale(req.headers['accept-language'], locales);
    const t = strings(locale);
    const cookies = parseCookies(req.headers.cookie);
    const path = url.pathname;

    // Static and health endpoints: no session needed, no user data.
    if (!isPost) {
      if (path === '/assets/base.css') return send(res, 200, 'text/css; charset=utf-8', BASE_CSS, { 'Cache-Control': 'private, max-age=3600' });
      if (path === '/theme.css') return send(res, 200, 'text/css; charset=utf-8', themeCss, { 'Cache-Control': 'private, max-age=300' });
      if (path === '/healthz') {
        const ok = core.healthy();
        return send(res, ok ? 200 : 503, 'text/plain; charset=utf-8', ok ? 'ok' : 'not synced');
      }
    }

    const who = identify(req, cookies);
    const publicStatus = { instance: { title: config.instance.title }, source: {} };

    // ---- login / logout ----
    if (path === '/login') {
      if (who && !isPost) return redirect(res, safeNext(params.next));
      if (!isPost) {
        const prior = cookies[preCookie];
        const pre = PRE_TOKEN_RE.test(prior ?? '') ? prior : randomToken(24);
        return send(
          res,
          200,
          'text/html; charset=utf-8',
          layout({ t, locale, status: publicStatus, primaryBoxes: [], title: t.login, body: loginView({ t, next: safeNext(params.next), pre, error: params.expired ? t.sessionExpired : false }) }),
          { 'Set-Cookie': serializeCookie(preCookie, pre, { ...cookieOpts, maxAge: 3600 }) },
        );
      }
      return handleLogin(req, res, t, locale, cookies, publicStatus);
    }
    if (!who) {
      const docsHeaders = docsRequest ? { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'private, no-store' } : {};
      if (path.startsWith('/api/')) return send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'login required' }), docsHeaders);
      if (isPost) return redirect(res, 'login?expired=1', [], docsHeaders);
      const next = path === '/' ? '' : `${path.slice(1)}${url.search}`;
      return redirect(res, next ? `login?next=${encodeURIComponent(safeNext(next))}` : 'login', [], docsHeaders);
    }

    // Use the raw path so ".." and encoded dots are still visible after URL parsing.
    if (docsRequest) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { Allow: 'GET, HEAD', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'private, no-store' });
      }
      return serveDocs(req, res, path, rawPath);
    }

    const viewer = viewerFor(who.role);
    const user = { id: who.userId, role: who.role, csrf: who.csrf, dev: who.dev, workshop: workshopOn, inbox: inboxOn };
    const status = core.status(viewer);
    const boxes = core.list_boxes(viewer);
    const { primary, advanced } = splitNavBoxes(sortNavBoxes(boxes));
    const page = (title, body, { httpStatus = 200, ...extra } = {}) =>
      send(res, httpStatus, 'text/html; charset=utf-8', layout({ ...extra, t, locale, status, title, body, user, flash: t[FLASH[params.ok]] ?? null, primaryBoxes: primary }));
    const notFound = () => page('', notFoundView({ t }), { httpStatus: 404 });
    // ids are config-order matches on this visible list, never raw config.
    // More is current only when every match is advanced. Otherwise the first primary match is current.
    const docNav = (ids) => {
      const matched = boxes.filter((b) => ids.includes(b.id));
      const primaryMatch = matched.find((b) => b.nav !== 'advanced');
      const advancedOnly = matched.length > 0 && matched.every((b) => b.nav === 'advanced');
      return { currentBox: primaryMatch ? primaryMatch.id : (ids[0] ?? null), ...(advancedOnly ? { section: 'advanced' } : {}) };
    };

    try {
      if (isPost) {
        if (!sameOrigin(req, web.publicOrigin)) return send(res, 403, 'text/plain; charset=utf-8', 'cross-origin request refused');
        let form;
        try {
          form = await readForm(req);
        } catch (err) {
          if (err instanceof BodyError) return send(res, 400, 'text/plain; charset=utf-8', err.message);
          throw err;
        }
        if (!safeEqual(form.csrf, who.csrf)) return send(res, 403, 'text/plain; charset=utf-8', 'invalid or missing form token; reload the page and try again');
        return await handlePost(path, form, { res, t, locale, who, viewer, page, notFound });
      }

      switch (path) {
        case '/':
          return page('', homeView({ t, locale, primaryBoxes: primary, status }), { currentBox: '' });
        case '/advanced':
          return page(t.advanced, advancedView({ t, locale, advancedBoxes: advanced, status }), { section: 'advanced' });
        case '/box': {
          const data = await core.get_box(viewer, params.id ?? '', params);
          const v = boxView({ t, locale, data, params });
          return page(v.title, v.html, { currentBox: data.box.id, ...(data.box.nav === 'advanced' ? { section: 'advanced' } : {}) });
        }
        case '/doc': {
          const doc = await core.get_document(viewer, params.path ?? '');
          const suggest = inboxOn ? `<p class="bt-suggest"><a href="inbox?ref=${encodeURIComponent(`doc:${doc.path}`)}">${e(t.sendToInbox)}</a></p>` : '';
          return page(doc.title, documentView({ t, doc }) + suggest, docNav(doc.boxes));
        }
        case '/file': {
          const file = await core.get_file(viewer, params.path ?? '');
          return page(file.path, fileView({ t, file }));
        }
        case '/raw': {
          const raw = await core.read_raw(viewer, params.path ?? '');
          return send(res, 200, raw.contentType, raw.body, { 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
        }
        case '/search': {
          const result = await core.search(viewer, params.q ?? '');
          return page(result.query, searchView({ t, result }), { query: result.query });
        }
        case '/workshop':
          if (!workshopOn) return notFound();
          return page(t.workshop, workshopListView({ t, items: workshop.list(who.userId), csrf: who.csrf }), { section: 'workshop' });
        case '/workshop-item': {
          if (!workshopOn) return notFound();
          let item;
          try {
            item = workshop.get(who.userId, params.id);
          } catch (err) {
            if (err instanceof WorkshopError) return notFound();
            throw err;
          }
          return page(item.title, workshopItemView({ t, item, history: workshop.history(who.userId, item.id), csrf: who.csrf, editing: params.edit === '1' }), { section: 'workshop' });
        }
        case '/inbox': {
          if (!inboxOn) return notFound();
          const refs = refOptions(viewer, locale);
          const draft = {};
          if (params.ref && (await validRef(viewer, params.ref))) {
            draft.ref = params.ref;
            if (!refs.some((r) => r.value === params.ref)) refs.unshift({ value: params.ref, label: params.ref.slice(4) });
          }
          return page(t.inbox, inboxListView({ t, items: inbox.mine(who.userId), csrf: who.csrf, refs, draft }), { section: 'inbox' });
        }
        case '/inbox-item': {
          if (!inboxOn) return notFound();
          const item = inbox.mineOne(who.userId, params.id);
          if (!item) return notFound();
          return page(item.title, inboxItemView({ t, item, csrf: who.csrf, refLabel: await refLink(viewer, item.ref, locale) }), { section: 'inbox' });
        }
        default:
          if (path.startsWith('/api/')) return api(path.slice(5), params, res, viewer);
          return notFound();
      }
    } catch (err) {
      if (err instanceof NotFound) return notFound();
      console.error('[bteam] request failed:', err.message);
      return send(res, 500, 'text/plain; charset=utf-8', 'internal error');
    }
  };

  function serveDocs(req, res, path, rawPath) {
    const file = readDocsFile(docsDir, path, rawPath, { hidePaths: config.docs?.hidePaths ?? [] });
    const robots = { 'X-Robots-Tag': 'noindex' };
    if (file.error === 'bad') return send(res, 400, 'text/plain; charset=utf-8', 'bad request', { ...robots, 'Cache-Control': 'private, no-store' });
    if (file.error) return send(res, 404, 'text/plain; charset=utf-8', 'not found', { ...robots, 'Cache-Control': 'private, no-store' });
    const body = req.method === 'HEAD' ? '' : file.body;
    return send(res, 200, file.type, body, { ...robots, 'Cache-Control': cacheControlFor(file.rel) });
  }

  async function handleLogin(req, res, t, locale, cookies, publicStatus) {
    const fail = (status, error) => {
      const pre = randomToken(24);
      return send(res, status, 'text/html; charset=utf-8', layout({ t, locale, status: publicStatus, primaryBoxes: [], title: t.login, body: loginView({ t, error, pre, next: './' }) }), {
        'Set-Cookie': serializeCookie(preCookie, pre, { ...cookieOpts, maxAge: 3600 }),
      });
    };
    if (!sameOrigin(req, web.publicOrigin)) return send(res, 403, 'text/plain; charset=utf-8', 'cross-origin request refused');
    let form;
    try {
      form = await readForm(req, 8 * 1024);
    } catch (err) {
      if (err instanceof BodyError) return send(res, 400, 'text/plain; charset=utf-8', err.message);
      throw err;
    }
    // Login CSRF: the form must echo the pre-session cookie value.
    if (!cookies[preCookie] || !safeEqual(form.pre, cookies[preCookie])) return fail(403, t.sessionExpired);
    const result = await auth.login(form.user, form.password, clientAddress(req, web.trustProxy));
    if (!result.ok) return fail(401, true);
    const token = auth.createSession(result.user.id, cookies[sessionCookie] ?? null);
    return redirect(res, safeNext(form.next), [
      serializeCookie(sessionCookie, token, { ...cookieOpts, maxAge: Math.floor(config.auth.sessionMaxMs / 1000) }),
      serializeCookie(preCookie, '', { ...cookieOpts, maxAge: 0 }),
    ]);
  }

  async function handlePost(path, form, { res, t, locale, who, viewer, page, notFound }) {
    switch (path) {
      case '/logout':
        if (!who.dev) auth.destroySession(who.token);
        return redirect(res, 'login', [serializeCookie(sessionCookie, '', { ...cookieOpts, maxAge: 0 })]);
      case '/workshop-save': {
        if (!workshopOn) return notFound();
        try {
          if (form.id) {
            workshop.update(who.userId, form.id, form);
            return redirect(res, `workshop-item?id=${Number(form.id)}&ok=saved`);
          }
          const id = workshop.create(who.userId, form);
          return redirect(res, `workshop-item?id=${id}&ok=saved`);
        } catch (err) {
          if (!(err instanceof WorkshopError)) throw err;
          if (err.message === 'not found') return notFound();
          if (form.id) {
            const item = { ...workshop.get(who.userId, form.id), title: form.title, body: form.body, kind: form.kind };
            return page(t.workshop, workshopItemView({ t, item, history: workshop.history(who.userId, item.id), csrf: who.csrf, editing: true, error: err.message }), { httpStatus: 400, section: 'workshop' });
          }
          return page(t.workshop, workshopListView({ t, items: workshop.list(who.userId), csrf: who.csrf, error: err.message, draft: form }), { httpStatus: 400, section: 'workshop' });
        }
      }
      case '/workshop-delete': {
        if (!workshopOn) return notFound();
        try {
          workshop.remove(who.userId, form.id);
        } catch (err) {
          if (err instanceof WorkshopError) return notFound();
          throw err;
        }
        return redirect(res, 'workshop?ok=deleted');
      }
      case '/inbox-submit': {
        if (!inboxOn) return notFound();
        const ref = form.ref ? String(form.ref) : '';
        try {
          if (ref && !(await validRef(viewer, ref))) throw new InboxError('unknown reference');
          const id = inbox.submit({ id: who.userId, policy: viewer.policy }, { kind: form.kind, title: form.title, body: form.body, ref: ref || null, workshopItemId: form.workshop_item_id || null });
          return redirect(res, `inbox-item?id=${id}&ok=sent`);
        } catch (err) {
          if (!(err instanceof InboxError)) throw err;
          return page(t.inbox, inboxListView({ t, items: inbox.mine(who.userId), csrf: who.csrf, refs: refOptions(viewer, locale), error: err.message, draft: { ...form, workshopItemId: form.workshop_item_id } }), { httpStatus: 400, section: 'inbox' });
        }
      }
      case '/inbox-reply': {
        if (!inboxOn) return notFound();
        try {
          inbox.userReply(who.userId, form.id, form.body);
        } catch (err) {
          if (!(err instanceof InboxError)) throw err;
          const item = inbox.mineOne(who.userId, form.id);
          if (!item) return notFound();
          return page(item.title, inboxItemView({ t, item, csrf: who.csrf, error: err.message }), { httpStatus: 400, section: 'inbox' });
        }
        return redirect(res, `inbox-item?id=${Number(form.id)}&ok=sent`);
      }
      default:
        return notFound();
    }
  }

  function refOptions(viewer, locale) {
    return core.list_boxes(viewer).map((b) => ({ value: `box:${b.id}`, label: localized(b.title, locale) }));
  }

  /** A reference is valid only if the user can see it right now. */
  async function validRef(viewer, ref) {
    if (typeof ref !== 'string' || ref.length > 600) return false;
    if (ref.startsWith('box:')) return core.list_boxes(viewer).some((b) => b.id === ref.slice(4));
    if (ref.startsWith('doc:')) {
      const p = safeRepoPath(ref.slice(4));
      if (!p) return false;
      try {
        await core.get_document(viewer, p);
        return true;
      } catch (err) {
        if (err instanceof NotFound) return false;
        throw err;
      }
    }
    return false;
  }

  async function refLink(viewer, ref, locale) {
    if (!ref || !(await validRef(viewer, ref))) return ref ? e(ref.slice(4)) : null;
    if (ref.startsWith('box:')) {
      const b = core.list_boxes(viewer).find((x) => x.id === ref.slice(4));
      return `<a href="box?id=${encodeURIComponent(b.id)}">${e(localized(b.title, locale))}</a>`;
    }
    return `<a href="doc?path=${encodeURIComponent(ref.slice(4))}">${e(ref.slice(4))}</a>`;
  }

  async function api(tool, params, res, viewer) {
    const json = (status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
    try {
      switch (tool) {
        case 'status':
          return json(200, core.status(viewer));
        case 'list_boxes':
          return json(200, core.list_boxes(viewer));
        case 'get_box':
          return json(200, await core.get_box(viewer, params.id ?? '', params));
        case 'get_document':
          return json(200, await core.get_document(viewer, params.path ?? ''));
        case 'search':
          return json(200, await core.search(viewer, params.q ?? ''));
        default:
          return json(404, { error: 'unknown tool' });
      }
    } catch (err) {
      if (err instanceof NotFound) return json(404, { error: 'not found' });
      console.error('[bteam] api failed:', err.message);
      return json(500, { error: 'internal error' });
    }
  }
}

export function startServer({ handler, host = '127.0.0.1', port = 8080 }) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error('[bteam] unhandled request error:', err.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('internal error');
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
