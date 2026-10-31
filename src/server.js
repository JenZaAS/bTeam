// HTTP server for the read-only web UI and JSON read tools.
// Step 1 has no login, so the server only binds to loopback unless explicitly overridden.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NotFound } from './core.js';
import { strings, pickLocale } from './i18n.js';
import { layout, homeView, boxView, documentView, fileView, searchView, notFoundView } from './views.js';

const BASE_CSS = fs.readFileSync(fileURLToPath(new URL('./assets/base.css', import.meta.url)), 'utf8');

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function createHandler({ core, viewer, themeCss = '' }) {
  const config = core.config;
  const csp = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${config.web.frameAncestors.join(' ')}`,
  ].join('; ');

  function send(res, status, type, body, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(body);
  }

  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { Allow: 'GET, HEAD' });
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
    const status = core.status(viewer);
    const boxes = core.list_boxes(viewer);
    const page = (title, body, { httpStatus = 200, ...extra } = {}) =>
      send(res, httpStatus, 'text/html; charset=utf-8', layout({ ...extra, t, locale, status, boxes, title, body }));

    try {
      switch (url.pathname) {
        case '/':
          return page('', homeView({ t, locale, boxes, status }), { currentBox: '' });
        case '/box': {
          const data = await core.get_box(viewer, params.id ?? '', params);
          const v = boxView({ t, locale, data, params });
          return page(v.title, v.html, { currentBox: data.box.id });
        }
        case '/doc': {
          const doc = await core.get_document(viewer, params.path ?? '');
          return page(doc.title, documentView({ t, doc }), { currentBox: doc.boxes[0] ?? null });
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
        case '/assets/base.css':
          return send(res, 200, 'text/css; charset=utf-8', BASE_CSS, { 'Cache-Control': 'private, max-age=3600' });
        case '/theme.css':
          return send(res, 200, 'text/css; charset=utf-8', themeCss, { 'Cache-Control': 'private, max-age=300' });
        case '/healthz':
          return send(res, core.status(viewer).source.commit ? 200 : 503, 'text/plain; charset=utf-8', core.status(viewer).source.commit ? 'ok' : 'not synced');
        default:
          if (url.pathname.startsWith('/api/')) return api(url.pathname.slice(5), params, res);
          return page('', notFoundView({ t }), { httpStatus: 404 });
      }
    } catch (err) {
      if (err instanceof NotFound) return page('', notFoundView({ t }), { httpStatus: 404 });
      console.error('[bteam] request failed:', err.message);
      return send(res, 500, 'text/plain; charset=utf-8', 'internal error');
    }
  };

  async function api(tool, params, res) {
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
