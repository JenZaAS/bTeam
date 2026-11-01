// Small HTTP helpers: cookies, form bodies, client address and safe redirect targets.
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge = null, secure = true, sameSite = 'Lax', httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

export class BodyError extends Error {}

/** Read an application/x-www-form-urlencoded body (size-limited). */
export function readForm(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      req.resume();
      return reject(new BodyError('unsupported content type'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new BodyError('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (xff) return xff.slice(0, 64);
  }
  return String(req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

export function isLoopbackAddress(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

/** Only allow relative in-app targets like "box?id=x" (no scheme, host or path traversal). */
export function safeNext(next) {
  const s = String(next ?? '');
  if (!s || s.length > 500) return './';
  if (!/^[a-z][a-z0-9-]*(\?[^\s\\]*)?$/i.test(s)) return './';
  return s;
}

/**
 * Same-origin check for POSTs.
 * A missing Origin is allowed (non-browser clients). The literal "null" is refused.
 * When publicOrigin is set, Origin must equal it (scheme, host and port).
 * Otherwise the Origin host must equal the Host header.
 * X-Forwarded-Host is never used: a client can set it to match a forged Origin.
 * web.trust_proxy does not apply here; it only selects the client address.
 */
export function sameOrigin(req, publicOrigin = null) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin !== 'null';
  try {
    const got = new URL(origin);
    if (publicOrigin) return got.origin === publicOrigin;
    return got.host === req.headers.host;
  } catch {
    return false;
  }
}
