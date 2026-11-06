// Loads and validates one instance configuration (instance.yaml).
// The core knows only generic concepts; everything project-specific comes from this file.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parseDuration, hasRelativeHop } from './util.js';

export const BOX_TYPES = {
  digest: ['path', 'pattern', 'latest'],
  decisions: ['paths', 'front_matter', 'fallback'],
  gallery: ['root', 'extra_roots', 'group_by_folder', 'filename_pattern', 'notes_file'],
  documents: ['paths', 'sections', 'features'],
  'open-questions': ['issues', 'paths'],
  issues: ['issues'],
  'source-browser': ['include', 'exclude'],
};
const COMMON_BOX_KEYS = ['id', 'type', 'title', 'description', 'visible_to', 'nav', 'order'];
const TOP_LEVEL_KEYS = [
  'instance', 'source', 'boxes', 'issue_source', 'links', 'roles', 'users', 'viewer', 'web',
  'auth', 'workshop', 'inbox', 'assistant', 'docs', 'audiences', 'home',
];
const HOME_TEASERS = {
  questions: { type: 'open-questions', max: 3 },
  decisions: { type: 'decisions', max: 3 },
  digest: { type: 'digest', max: 1 },
};
const HIDE_KEYS = ['boxes', 'paths', 'issue_labels', 'issue_title_patterns'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
export const DEFAULT_PUBLIC_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export class ConfigError extends Error {
  constructor(errors) {
    super(`invalid instance config:\n  - ${errors.join('\n  - ')}`);
    this.errors = errors;
  }
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError([`cannot read ${abs}: ${err.message}`]);
  }
  return validateConfig(raw, { baseDir: path.dirname(abs) });
}

export function validateConfig(raw, { baseDir = process.cwd() } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const strList = (v, where) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      err(`${where} must be a list of strings`);
      return [];
    }
    return v;
  };
  const regex = (v, where) => {
    try {
      return new RegExp(v, 'u');
    } catch (e) {
      err(`${where} is not a valid regular expression: ${e.message}`);
      return null;
    }
  };
  const unknownKeys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${where}: unknown key "${k}"`);
  };
  const audienceList = (v, where) => {
    const list = strList(v, where);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const s = item.trim();
      if (!/^[\w.-]{1,64}$/.test(s)) err(`${where} entries must be short words`);
      else if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  };
  const pathPrefixes = (v, where) => {
    const list = strList(v, where);
    const out = [];
    for (const item of list) {
      const s = item.trim().replace(/^\/+/, '').replace(/\/+$/, '');
      const parts = s.split('/');
      if (!s || item.includes('\\') || item.includes('\0') || parts.some((p) => p === '' || p === '.' || p === '..')) {
        err(`${where} entries must be path prefixes under /docs`);
        continue;
      }
      out.push(parts.join('/'));
    }
    return out;
  };
  // App paths stay relative so the UI still works behind a path prefix. A leading slash is removed.
  const APP_HREF_CTRL = /[\x00-\x1f\x7f]/;
  const appHref = (v, where) => {
    if (typeof v !== 'string') {
      err(`${where} must be a relative app path`);
      return '';
    }
    if (APP_HREF_CTRL.test(v) || v.includes('\u200b') || v.includes('\ufeff')) {
      err(`${where} must be a relative app path`);
      return '';
    }
    const s = v.trim();
    const pathOnly = s.split(/[?#]/, 1)[0];
    if (!s) {
      err(`${where} must be a relative app path`);
      return '';
    }
    if (hasRelativeHop(pathOnly) || /%2f|%5c/i.test(pathOnly)) {
      err(`${where} must be a relative app path`);
      return '';
    }
    if (
      s.length > 300 ||
      /^[a-z][a-z0-9+.-]*:/i.test(s) ||
      s.startsWith('//') ||
      /[\\\s]/.test(s) ||
      /(^|\/)\.\.(\/|$)/.test(pathOnly)
    ) {
      err(`${where} must be a relative app path`);
      return '';
    }
    const stripped = s.replace(/^\/+/, '');
    if (!stripped || /^[?#]/.test(stripped)) {
      err(`${where} must be a relative app path`);
      return '';
    }
    return stripped;
  };
  const localText = (v, where, { required = false, max = 400, oneSentence = false } = {}) => {
    if (v === undefined || v === null || v === '') {
      if (required) err(`${where} is required`);
      return '';
    }
    const check = (text, at) => {
      if (typeof text !== 'string' || !text.trim()) {
        err(`${at} must be text`);
        return;
      }
      if (text.length > max || /[\r\n]/.test(text)) err(`${at} must be a single line up to ${max} characters`);
      else if (oneSentence && text.trim().split(/[.!?]+/u).map((p) => p.trim()).filter(Boolean).length > 1) err(`${at} must be one sentence`);
    };
    if (typeof v === 'string') {
      check(v, where);
      return v;
    }
    if (isObj(v) && Object.keys(v).length && Object.values(v).every((t) => typeof t === 'string')) {
      for (const [loc, text] of Object.entries(v)) {
        if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(loc)) err(`${where}: bad locale "${loc}"`);
        check(text, `${where}.${loc}`);
      }
      return v;
    }
    err(`${where} must be a string or a {locale: text} mapping`);
    return '';
  };

  const extensionList = (v, where) => {
    if (v === undefined) return [...DEFAULT_PUBLIC_EXTENSIONS];
    const list = strList(v, where);
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const s = item.trim().toLowerCase().replace(/^\./, '');
      if (!/^[a-z0-9]{1,16}$/.test(s)) err(`${where} entries must be file extensions`);
      else if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  };

  if (!isObj(raw)) throw new ConfigError(['config must be a YAML mapping']);
  unknownKeys(raw, TOP_LEVEL_KEYS, 'top level');

  // instance
  const inst = raw.instance;
  const instance = { id: 'instance', title: 'bTeam', locale: ['en'], theme: null };
  if (!isObj(inst)) err('instance: required mapping');
  else {
    unknownKeys(inst, ['id', 'title', 'locale', 'theme'], 'instance');
    if (!ID_RE.test(String(inst.id ?? ''))) err('instance.id must be a lowercase slug');
    else instance.id = inst.id;
    if (typeof inst.title !== 'string' || !inst.title.trim()) err('instance.title is required');
    else instance.title = inst.title;
    if (inst.locale !== undefined) {
      const loc = Array.isArray(inst.locale) ? inst.locale : [inst.locale];
      if (!loc.length || loc.some((l) => !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(l)))) err('instance.locale must be language codes');
      else instance.locale = loc;
    }
    if (inst.theme !== undefined) {
      if (typeof inst.theme !== 'string') err('instance.theme must be a file path');
      else instance.theme = path.resolve(baseDir, inst.theme);
    }
  }

  // source
  const src = raw.source;
  const source = { type: 'git-mirror', url: '', branch: 'main', refreshMs: 600_000, tokenEnv: null };
  if (!isObj(src)) err('source: required mapping');
  else {
    unknownKeys(src, ['type', 'url', 'branch', 'refresh', 'token_env'], 'source');
    if (src.type !== 'git-mirror') err('source.type must be "git-mirror"');
    const url = String(src.url ?? '');
    if (!url) err('source.url is required');
    else if (/^https?:\/\/[^/]*@/i.test(url)) err('source.url must not contain credentials; use source.token_env');
    else if (!/^(https:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/.test(url)) err('source.url must be https://, ssh://, git@host: or file://');
    source.url = url;
    if (src.branch !== undefined) {
      if (!/^[\w./-]{1,200}$/.test(String(src.branch)) || String(src.branch).includes('..')) err('source.branch is not a valid branch name');
      else source.branch = String(src.branch);
    }
    if (src.refresh !== undefined) {
      try {
        source.refreshMs = parseDuration(src.refresh);
        if (source.refreshMs < 60_000) err('source.refresh must be at least 1m');
      } catch (e) {
        err(`source.refresh: ${e.message}`);
      }
    }
    if (src.token_env !== undefined) {
      if (!ENV_RE.test(String(src.token_env))) err('source.token_env must be an environment variable NAME');
      else source.tokenEnv = src.token_env;
    }
  }

  // issue source
  let issueSource = null;
  if (raw.issue_source !== undefined) {
    const is = raw.issue_source;
    if (!isObj(is)) err('issue_source must be a mapping');
    else {
      unknownKeys(is, ['type', 'repo', 'token_env', 'api_url', 'refresh', 'max_pages'], 'issue_source');
      if (is.type !== 'github') err('issue_source.type must be "github"');
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(is.repo ?? ''))) err('issue_source.repo must be "owner/name"');
      if (is.token_env !== undefined && !ENV_RE.test(String(is.token_env))) err('issue_source.token_env must be an environment variable NAME');
      if (is.api_url !== undefined && !/^https:\/\//.test(String(is.api_url))) err('issue_source.api_url must be https://');
      let refreshMs = source.refreshMs;
      if (is.refresh !== undefined) {
        try {
          refreshMs = parseDuration(is.refresh);
        } catch (e) {
          err(`issue_source.refresh: ${e.message}`);
        }
      }
      issueSource = {
        type: 'github',
        repo: is.repo,
        tokenEnv: is.token_env ?? null,
        apiUrl: is.api_url ?? 'https://api.github.com',
        refreshMs,
        maxPages: Number.isInteger(is.max_pages) ? is.max_pages : 5,
      };
    }
  }

  // Audience values a signed-in user may see. Omitted means ["all"].
  // A role's own list, when set, replaces this one for that role.
  let instanceAudiences = ['all'];
  if (raw.audiences !== undefined) instanceAudiences = audienceList(raw.audiences, 'audiences');

  // roles and users (visibility)
  const roles = {};
  if (raw.roles !== undefined) {
    if (!isObj(raw.roles)) err('roles must be a mapping of role name -> rules');
    else {
      for (const [name, r] of Object.entries(raw.roles)) {
        if (!ID_RE.test(name)) err(`roles: "${name}" is not a valid role name`);
        const rr = r ?? {};
        if (!isObj(rr)) {
          err(`roles.${name} must be a mapping`);
          continue;
        }
        unknownKeys(rr, ['description', 'hide', 'policy', 'audiences'], `roles.${name}`);
        const hide = rr.hide ?? {};
        if (!isObj(hide)) err(`roles.${name}.hide must be a mapping`);
        else unknownKeys(hide, HIDE_KEYS, `roles.${name}.hide`);
        const titleRes = strList(hide.issue_title_patterns, `roles.${name}.hide.issue_title_patterns`).map((p) => {
          try {
            return new RegExp(p, 'iu');
          } catch (e) {
            err(`roles.${name}.hide.issue_title_patterns: ${e.message}`);
            return null;
          }
        });
        if (rr.policy !== undefined && !isObj(rr.policy)) err(`roles.${name}.policy must be a mapping`);
        roles[name] = {
          name,
          description: typeof rr.description === 'string' ? rr.description : '',
          hide: {
            boxes: strList(hide.boxes, `roles.${name}.hide.boxes`),
            paths: strList(hide.paths, `roles.${name}.hide.paths`),
            issueLabels: strList(hide.issue_labels, `roles.${name}.hide.issue_labels`),
            issueTitlePatterns: titleRes.filter(Boolean),
          },
          policy: isObj(rr.policy) ? rr.policy : {},
          audiences: rr.audiences === undefined ? [...instanceAudiences] : audienceList(rr.audiences, `roles.${name}.audiences`),
        };
      }
      for (const r of Object.values(roles)) {
        const target = r.policy.route_other_to;
        if (target !== undefined && !roles[target]) err(`roles.${r.name}.policy.route_other_to: unknown role "${target}"`);
        const ae = r.policy.auto_accept_eligible;
        if (ae !== undefined && (!Array.isArray(ae) || ae.some((s) => typeof s !== 'string'))) err(`roles.${r.name}.policy.auto_accept_eligible must be a list of strings`);
      }
    }
  }
  if (!Object.keys(roles).length) {
    roles.default = {
      name: 'default',
      description: '',
      hide: { boxes: [], paths: [], issueLabels: [], issueTitlePatterns: [] },
      policy: {},
      audiences: [...instanceAudiences],
    };
  }

  const users = [];
  if (raw.users !== undefined) {
    if (!Array.isArray(raw.users)) err('users must be a list of {id, role}');
    else
      for (const [i, u] of raw.users.entries()) {
        if (!isObj(u)) {
          err(`users[${i}] must be a mapping`);
          continue;
        }
        unknownKeys(u, ['id', 'role'], `users[${i}]`);
        if (!ID_RE.test(String(u.id ?? ''))) err(`users[${i}].id must be a lowercase slug`);
        if (!roles[u.role]) err(`users[${i}].role: unknown role "${u.role}"`);
        if (/password|secret|token/i.test(JSON.stringify(u))) err(`users[${i}]: credentials never belong in the config`);
        users.push({ id: u.id, role: u.role });
      }
  }

  let defaultRole = Object.keys(roles)[0];
  if (raw.viewer !== undefined) {
    if (!isObj(raw.viewer)) err('viewer must be a mapping');
    else {
      unknownKeys(raw.viewer, ['default_role'], 'viewer');
      if (raw.viewer.default_role !== undefined) {
        if (!roles[raw.viewer.default_role]) err(`viewer.default_role: unknown role "${raw.viewer.default_role}"`);
        else defaultRole = raw.viewer.default_role;
      }
    }
  }

  // boxes
  const boxes = [];
  const ids = new Set();
  if (!Array.isArray(raw.boxes) || !raw.boxes.length) err('boxes: at least one box is required');
  else
    for (const [i, b] of raw.boxes.entries()) {
      const where = `boxes[${i}]`;
      if (!isObj(b)) {
        err(`${where} must be a mapping`);
        continue;
      }
      if (!ID_RE.test(String(b.id ?? ''))) err(`${where}.id must be a lowercase slug`);
      else if (ids.has(b.id)) err(`${where}.id "${b.id}" is duplicated`);
      ids.add(b.id);
      const allowed = BOX_TYPES[b.type];
      if (!allowed) {
        err(`${where}.type "${b.type}" is unknown (use one of: ${Object.keys(BOX_TYPES).join(', ')})`);
        continue;
      }
      unknownKeys(b, [...COMMON_BOX_KEYS, ...allowed], `${where} (${b.type})`);
      const title = b.title ?? b.id;
      if (!(typeof title === 'string' || (isObj(title) && Object.values(title).every((t) => typeof t === 'string')))) err(`${where}.title must be a string or a {locale: text} mapping`);
      const box = { id: b.id, type: b.type, title, description: b.description ?? '', visibleTo: strList(b.visible_to, `${where}.visible_to`) };
      for (const r of box.visibleTo) if (!roles[r]) err(`${where}.visible_to: unknown role "${r}"`);

      // Missing nav is primary. A bad value is an error and is not stored.
      if (b.nav === undefined) box.nav = 'primary';
      else if (b.nav === 'primary' || b.nav === 'advanced') box.nav = b.nav;
      else err(`${where}.nav must be "primary" or "advanced"`);
      // Missing order sorts last. Only a safe integer is stored; nothing is coerced.
      if (b.order === undefined) box.order = null;
      else if (Number.isSafeInteger(b.order)) box.order = b.order;
      else err(`${where}.order must be an integer`);

      switch (b.type) {
        case 'digest':
          box.pattern = b.pattern ?? (b.path ? `${String(b.path).replace(/\/?$/, '/')}*.md` : null);
          if (!box.pattern) err(`${where}: digest needs "pattern" or "path"`);
          box.latest = Number.isInteger(b.latest) && b.latest > 0 ? b.latest : 1;
          break;
        case 'decisions':
          box.paths = strList(b.paths, `${where}.paths`);
          if (!box.paths.length && !b.fallback) err(`${where}: decisions needs "paths" or "fallback"`);
          box.frontMatter = isObj(b.front_matter) ? b.front_matter : null;
          if (b.fallback !== undefined) {
            if (!isObj(b.fallback) || typeof b.fallback.file !== 'string') err(`${where}.fallback needs "file"`);
            else box.fallback = { file: b.fallback.file, heading: b.fallback.heading ? regex(b.fallback.heading, `${where}.fallback.heading`) : null };
          }
          break;
        case 'gallery': {
          if (typeof b.root !== 'string' || !b.root) err(`${where}.root is required`);
          const norm = (r) => String(r).replace(/^\.?\/*/, '').replace(/\/?$/, '/').replace(/^\/$/, '');
          box.roots = [b.root, ...strList(b.extra_roots, `${where}.extra_roots`)].filter(Boolean).map(norm);
          if (b.group_by_folder !== undefined && !['date', 'folder', 'none'].includes(b.group_by_folder)) err(`${where}.group_by_folder must be date, folder or none`);
          box.groupBy = b.group_by_folder ?? 'folder';
          box.filenamePattern = b.filename_pattern ? regex(b.filename_pattern, `${where}.filename_pattern`) : null;
          box.notesFile = typeof b.notes_file === 'string' ? b.notes_file : null;
          break;
        }
        case 'documents':
          box.paths = strList(b.paths, `${where}.paths`);
          if (!box.paths.length) err(`${where}.paths is required`);
          box.features = strList(b.features, `${where}.features`);
          if (b.sections !== undefined) {
            if (!isObj(b.sections) || typeof b.sections.heading !== 'string') err(`${where}.sections needs "heading" (a regex)`);
            else
              box.sections = {
                heading: regex(b.sections.heading, `${where}.sections.heading`),
                latest: Number.isInteger(b.sections.latest) && b.sections.latest > 0 ? b.sections.latest : null,
                level: Number.isInteger(b.sections.level) ? b.sections.level : 2,
              };
          }
          break;
        case 'open-questions':
        case 'issues': {
          const iss = b.issues;
          if (iss !== undefined || b.type === 'issues') {
            if (!isObj(iss ?? {})) err(`${where}.issues must be a mapping`);
            box.issues = {
              labels: strList(iss?.labels, `${where}.issues.labels`),
              state: iss?.state ?? 'open',
            };
            if (!['open', 'closed', 'all'].includes(box.issues.state)) err(`${where}.issues.state must be open, closed or all`);
            if (!issueSource) err(`${where}: needs a top-level issue_source`);
          }
          box.paths = strList(b.paths, `${where}.paths`);
          if (b.type === 'open-questions' && !box.issues && !box.paths.length) err(`${where}: open-questions needs "issues" or "paths"`);
          break;
        }
        case 'source-browser':
          box.include = strList(b.include ?? ['**/*'], `${where}.include`);
          box.exclude = strList(b.exclude, `${where}.exclude`);
          break;
      }
      boxes.push(box);
    }
  for (const r of Object.values(roles)) for (const id of r.hide.boxes) if (!ids.has(id)) err(`roles.${r.name}.hide.boxes: unknown box "${id}"`);

  // links
  const links = [];
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links)) err('links must be a list');
    else
      for (const [i, l] of raw.links.entries()) {
        if (!isObj(l) || typeof l.label !== 'string' || !/^https?:\/\//.test(String(l.url ?? ''))) err(`links[${i}] needs a label and an http(s) url`);
        else links.push({ label: l.label, url: l.url });
      }
  }

  // optional built static site served at /docs (DOCS_DIR overrides docs.dir at startup)
  const docs = { dir: null, hidePaths: [], publicExtensions: [...DEFAULT_PUBLIC_EXTENSIONS] };
  if (raw.docs !== undefined) {
    if (!isObj(raw.docs)) err('docs must be a mapping');
    else {
      unknownKeys(raw.docs, ['dir', 'hide_paths', 'public_extensions'], 'docs');
      if (raw.docs.dir !== undefined) {
        if (typeof raw.docs.dir !== 'string' || !raw.docs.dir.trim() || raw.docs.dir.includes('\0')) err('docs.dir must be a directory path');
        else docs.dir = path.resolve(baseDir, raw.docs.dir);
      }
      if (raw.docs.hide_paths !== undefined) docs.hidePaths = pathPrefixes(raw.docs.hide_paths, 'docs.hide_paths');
      docs.publicExtensions = extensionList(raw.docs.public_extensions, 'docs.public_extensions');
    }
  }

  // web
  const web = { frameAncestors: ["'self'"], secureCookies: true, sameSite: 'Lax', trustProxy: false, publicOrigin: null };
  if (raw.web !== undefined) {
    if (!isObj(raw.web)) err('web must be a mapping');
    else {
      unknownKeys(raw.web, ['frame_ancestors', 'secure_cookies', 'same_site', 'trust_proxy', 'public_origin'], 'web');
      if (raw.web.frame_ancestors !== undefined) {
        const fa = strList(raw.web.frame_ancestors, 'web.frame_ancestors');
        if (fa.some((s) => !/^('self'|'none'|https:\/\/[\w.*:-]+)$/.test(s))) err("web.frame_ancestors entries must be 'self', 'none' or https:// origins");
        else web.frameAncestors = fa;
      }
      if (raw.web.secure_cookies !== undefined) {
        if (typeof raw.web.secure_cookies !== 'boolean') err('web.secure_cookies must be true or false');
        else web.secureCookies = raw.web.secure_cookies;
      }
      if (raw.web.same_site !== undefined) {
        const v = String(raw.web.same_site).toLowerCase();
        if (!['lax', 'strict'].includes(v)) err('web.same_site must be lax or strict');
        else web.sameSite = v === 'lax' ? 'Lax' : 'Strict';
      }
      if (raw.web.trust_proxy !== undefined) {
        if (typeof raw.web.trust_proxy !== 'boolean') err('web.trust_proxy must be true or false');
        else web.trustProxy = raw.web.trust_proxy;
      }
      if (raw.web.public_origin != null) {
        const s = raw.web.public_origin;
        let parsed = null;
        if (typeof s === 'string') {
          try {
            parsed = new URL(s);
          } catch {
            parsed = null;
          }
        }
        const schemeOk = parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
        if (!schemeOk || parsed.origin !== s) err('web.public_origin must be an absolute http(s) origin with no path, query, credentials or default port');
        else web.publicOrigin = parsed.origin;
      }
    }
  }

  // auth (login, sessions, rate limiting)
  const auth = { sessionIdleMs: 12 * 3600_000, sessionMaxMs: 7 * 86_400_000, maxFailures: 5, lockoutMs: 15 * 60_000, maxAttemptsPerClient: 20, minPasswordLength: 12 };
  if (raw.auth !== undefined) {
    if (!isObj(raw.auth)) err('auth must be a mapping');
    else {
      const keys = { session_idle: 'sessionIdleMs', session_max: 'sessionMaxMs', lockout: 'lockoutMs' };
      const ints = { max_failures: ['maxFailures', 1, 100], max_attempts_per_client: ['maxAttemptsPerClient', 1, 1000], min_password_length: ['minPasswordLength', 10, 128] };
      unknownKeys(raw.auth, [...Object.keys(keys), ...Object.keys(ints)], 'auth');
      for (const [k, prop] of Object.entries(keys)) {
        if (raw.auth[k] === undefined) continue;
        try {
          auth[prop] = parseDuration(raw.auth[k]);
        } catch (e) {
          err(`auth.${k}: ${e.message}`);
        }
      }
      for (const [k, [prop, min, max]] of Object.entries(ints)) {
        if (raw.auth[k] === undefined) continue;
        if (!Number.isInteger(raw.auth[k]) || raw.auth[k] < min || raw.auth[k] > max) err(`auth.${k} must be an integer from ${min} to ${max}`);
        else auth[prop] = raw.auth[k];
      }
      if (auth.sessionIdleMs > auth.sessionMaxMs) err('auth.session_idle must not exceed auth.session_max');
    }
  }

  // workshop and inbox
  const workshop = { enabled: true, maxItemsPerUser: 200 };
  if (raw.workshop !== undefined) {
    if (!isObj(raw.workshop)) err('workshop must be a mapping');
    else {
      unknownKeys(raw.workshop, ['enabled', 'max_items_per_user'], 'workshop');
      if (raw.workshop.enabled !== undefined) workshop.enabled = raw.workshop.enabled === true;
      if (raw.workshop.max_items_per_user !== undefined) {
        if (!Number.isInteger(raw.workshop.max_items_per_user) || raw.workshop.max_items_per_user < 1) err('workshop.max_items_per_user must be a positive integer');
        else workshop.maxItemsPerUser = raw.workshop.max_items_per_user;
      }
    }
  }
  const inbox = { enabled: true, ownerQuestionLabel: null };
  if (raw.inbox !== undefined) {
    if (!isObj(raw.inbox)) err('inbox must be a mapping');
    else {
      unknownKeys(raw.inbox, ['enabled', 'owner_question_label'], 'inbox');
      if (raw.inbox.enabled !== undefined) inbox.enabled = raw.inbox.enabled === true;
      if (raw.inbox.owner_question_label !== undefined) {
        if (!/^[\w:. -]{1,50}$/.test(String(raw.inbox.owner_question_label))) err('inbox.owner_question_label must be a short label name');
        else inbox.ownerQuestionLabel = String(raw.inbox.owner_question_label);
      }
    }
  }

  // Optional Overview entrance. Omitted means a generic welcome, not a grid of boxes.
  let home = null;
  if (raw.home !== undefined && raw.home !== null) {
    const h = raw.home;
    if (!isObj(h)) err('home must be a mapping');
    else {
      unknownKeys(h, ['hero', 'doors', 'links', 'teasers'], 'home');
      const hero = localText(h.hero, 'home.hero', { required: true, max: 280, oneSentence: true });
      const doors = [];
      const doorIds = new Set();
      if (!Array.isArray(h.doors) || !h.doors.length) err('home.doors must list at least one door');
      else if (h.doors.length > 4) err('home.doors can list at most 4 doors');
      else {
        for (const [i, d] of h.doors.entries()) {
          const where = `home.doors[${i}]`;
          if (!isObj(d)) {
            err(`${where} must be a mapping`);
            continue;
          }
          unknownKeys(d, ['id', 'label', 'href', 'blurb', 'tag'], where);
          if (!ID_RE.test(String(d.id ?? ''))) err(`${where}.id must be a lowercase slug`);
          else if (doorIds.has(d.id)) err(`${where}.id "${d.id}" is duplicated`);
          else doorIds.add(d.id);
          doors.push({
            id: d.id,
            label: localText(d.label, `${where}.label`, { required: true, max: 80 }),
            href: appHref(d.href, `${where}.href`),
            blurb: d.blurb === undefined ? '' : localText(d.blurb, `${where}.blurb`, { max: 240 }),
            tag: d.tag === undefined ? '' : localText(d.tag, `${where}.tag`, { max: 24 }),
          });
        }
      }
      const homeLinks = [];
      if (h.links !== undefined) {
        if (!Array.isArray(h.links)) err('home.links must be a list');
        else if (h.links.length > 4) err('home.links can list at most 4 links');
        else {
          for (const [i, l] of h.links.entries()) {
            const where = `home.links[${i}]`;
            if (!isObj(l)) {
              err(`${where} must be a mapping`);
              continue;
            }
            unknownKeys(l, ['label', 'href'], where);
            homeLinks.push({
              label: localText(l.label, `${where}.label`, { required: true, max: 80 }),
              href: appHref(l.href, `${where}.href`),
            });
          }
        }
      }
      const teasers = { questions: null, decisions: null, digest: null };
      if (h.teasers !== undefined) {
        if (!isObj(h.teasers)) err('home.teasers must be a mapping');
        else {
          unknownKeys(h.teasers, Object.keys(HOME_TEASERS), 'home.teasers');
          for (const [key, meta] of Object.entries(HOME_TEASERS)) {
            if (h.teasers[key] === undefined) continue;
            const spec = h.teasers[key];
            const where = `home.teasers.${key}`;
            if (!isObj(spec)) {
              err(`${where} must be a mapping`);
              continue;
            }
            unknownKeys(spec, ['enabled', 'max', 'box', 'title'], where);
            let enabled = true;
            if (spec.enabled !== undefined) {
              if (typeof spec.enabled !== 'boolean') err(`${where}.enabled must be true or false`);
              else enabled = spec.enabled;
            }
            let max = meta.max;
            if (spec.max !== undefined) {
              if (!Number.isInteger(spec.max) || spec.max < 1 || spec.max > 10) err(`${where}.max must be an integer from 1 to 10`);
              else max = spec.max;
            }
            let box = null;
            if (spec.box !== undefined) {
              const found = boxes.find((b) => b.id === spec.box);
              if (typeof spec.box !== 'string' || !found) err(`${where}.box: unknown box "${spec.box}"`);
              else if (found.type !== meta.type) err(`${where}.box must be a ${meta.type} box`);
              else box = spec.box;
            }
            teasers[key] = {
              enabled,
              max,
              box,
              title: spec.title === undefined ? '' : localText(spec.title, `${where}.title`, { max: 80 }),
            };
          }
        }
      }
      home = { hero, doors, links: homeLinks, teasers };
    }
  }

  if (errors.length) throw new ConfigError(errors);
  return {
    instance,
    source,
    issueSource,
    boxes,
    roles,
    users,
    defaultRole,
    links,
    home,
    web,
    docs,
    audiences: instanceAudiences,
    auth,
    workshop,
    inbox,
    // Later step; kept as-is so one file serves the whole instance.
    assistant: raw.assistant ?? null,
  };
}

/** Localised text from a string or a {locale: text} mapping. */
export function localized(value, locale) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value[locale] ?? Object.values(value)[0] ?? '';
  return '';
}
