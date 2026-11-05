#!/usr/bin/env node
// bTeam command line: check a config, sync the mirror, run a read tool, manage users,
// process the Inbox (for the nightly agent), or serve the web UI.
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { openInstance, openState } from '../src/instance.js';
import { INBOX_STATUSES } from '../src/inbox.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { createViewer } from '../src/visibility.js';
import { createHandler, startServer } from '../src/server.js';
import { resolveDocsDir } from '../src/docs-static.js';
import { loadThemeCss } from '../src/theme.js';
import { resolveServeOptions, ServeOptionsError } from '../src/serve-options.js';
import { backupDb, BackupError } from '../src/backup.js';

const USAGE = `Usage: bteam <command> [options]

Commands:
  check                 validate the instance config and print a summary
  sync                  mirror the source repository and refresh issues once
  tool <name> [k=v...]  run a read tool (status, list_boxes, get_box, get_document, search) and print JSON
  serve                 sync, then serve the web UI (login required) with scheduled refresh
  backup [--out FILE]   consistent copy of the instance database (default <data>/backups/), safe while serving

  user add <id> [--role R]      create a user; asks for the password (or --password-stdin)
  user reset <id>               set a new password; signs the user out everywhere
  user list                     list users (never prints hashes)
  user set-role <id> <role>     change a user's role; signs the user out everywhere
  user disable|enable <id>      block or unblock a user
  user unlock <id>              clear failed-login lockout

  inbox list [--status S] [--json]           list submissions (all users)
  inbox show <id>                            one submission with its conversation, as JSON
  inbox update <id> --status S [--reply T] [--issue-url URL] [--note T]
                                             record the agent's decision (never posts anywhere)

Options:
  --config <file>   instance config (default: $BTEAM_CONFIG or ./instance.yaml)
  --data <dir>      data directory for the mirror and database (default: $BTEAM_DATA_DIR or ./data)
  --role <role>     tool: view as this role (default: viewer.default_role)
  --host <host>     serve: bind address (default: $BTEAM_HOST or 127.0.0.1)
  --port <port>     serve: port (default: $PORT or 8080)
  --dev-user <id>   serve, development only: requests from this machine act as this existing
                    user without logging in. Only allowed when bound to a loopback address.
  --password-stdin  user add/reset: read the password from the first line of stdin
`;

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('no terminal for a password prompt; use --password-stdin'));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword(values) {
  if (values['password-stdin']) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  const a = await promptHidden('New password: ');
  const b = await promptHidden('Repeat password: ');
  if (a !== b) throw new Error('passwords do not match');
  return a;
}

async function userCommand(config, state, values, [sub, id, arg]) {
  const { auth } = state;
  const need = () => {
    if (!id) throw new Error(`usage: bteam user ${sub} <id>`);
  };
  switch (sub) {
    case 'add': {
      need();
      const role = values.role ?? config.users.find((u) => u.id === id)?.role ?? config.defaultRole;
      await auth.addUser(id, role, await readPassword(values));
      console.log(`created user "${id}" with role "${role}"`);
      return;
    }
    case 'reset':
      need();
      await auth.resetPassword(id, await readPassword(values));
      console.log(`password for "${id}" changed; existing sessions ended`);
      return;
    case 'list':
      for (const u of auth.listUsers()) console.log(`${u.id}\t${u.role}${u.disabled ? '\tDISABLED' : ''}\tcreated ${u.createdAt}\tpassword changed ${u.passwordChangedAt}`);
      return;
    case 'set-role':
      need();
      if (!arg) throw new Error('usage: bteam user set-role <id> <role>');
      auth.setRole(id, arg);
      console.log(`"${id}" now has role "${arg}"`);
      return;
    case 'disable':
    case 'enable':
      need();
      auth.setDisabled(id, sub === 'disable');
      console.log(`"${id}" ${sub}d`);
      return;
    case 'unlock':
      need();
      auth.unlock(id);
      console.log(`"${id}" unlocked`);
      return;
    default:
      throw new Error('usage: bteam user add|reset|list|set-role|disable|enable|unlock');
  }
}

function inboxCommand(state, values, [sub, id]) {
  const { inbox } = state;
  switch (sub) {
    case 'list': {
      const items = inbox.list({ status: values.status ?? null });
      if (values.json) return console.log(JSON.stringify(items, null, 2));
      for (const i of items) console.log(`${i.id}\t${i.status}\t${i.kind}\t${i.route}${i.routeLabel ? `(${i.routeLabel})` : ''}\t${i.userId}\t${i.title}`);
      return;
    }
    case 'show':
      if (!id) throw new Error('usage: bteam inbox show <id>');
      return console.log(JSON.stringify(inbox.show(id), null, 2));
    case 'update': {
      if (!id) throw new Error('usage: bteam inbox update <id> --status S [--reply T] [--issue-url URL] [--note T]');
      if (!values.status && values.reply === undefined && values['issue-url'] === undefined && values.note === undefined) throw new Error('nothing to update');
      const r = inbox.update(id, { status: values.status, reply: values.reply, issueUrl: values['issue-url'], note: values.note, actor: 'agent' });
      return console.log(JSON.stringify({ id: r.id, status: r.status, issueUrl: r.issueUrl }));
    }
    default:
      throw new Error(`usage: bteam inbox list|show|update (statuses: ${INBOX_STATUSES.join(', ')})`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      data: { type: 'string' },
      role: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'dev-user': { type: 'string' },
      'password-stdin': { type: 'boolean' },
      out: { type: 'string' },
      status: { type: 'string' },
      reply: { type: 'string' },
      'issue-url': { type: 'string' },
      note: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const configPath = values.config ?? process.env.BTEAM_CONFIG ?? 'instance.yaml';
  const dataDir = values.data ?? process.env.BTEAM_DATA_DIR ?? 'data';

  if (cmd === 'check') {
    const c = loadConfig(configPath);
    console.log(`ok: instance "${c.instance.id}" (${c.instance.title})`);
    console.log(`source: ${c.source.url.replace(/\/\/[^/]*@/, '//')} @ ${c.source.branch}, refresh ${c.source.refreshMs / 1000}s${c.source.tokenEnv ? `, token from $${c.source.tokenEnv}` : ''}`);
    console.log(`boxes: ${c.boxes.map((b) => `${b.id}(${b.type})`).join(', ')}`);
    for (const r of Object.values(c.roles)) {
      const h = r.hide;
      console.log(`role ${r.name}: hides boxes [${h.boxes}], paths [${h.paths}], issue labels [${h.issueLabels}], ${h.issueTitlePatterns.length} title pattern(s)${Object.keys(r.policy).length ? `; policy ${JSON.stringify(r.policy)}` : ''}`);
    }
    const a = c.auth;
    console.log(`auth: session idle ${a.sessionIdleMs / 60000}m, max ${a.sessionMaxMs / 3600000}h, lock after ${a.maxFailures} failures for ${a.lockoutMs / 60000}m; cookies ${c.web.secureCookies ? 'Secure' : 'NOT Secure (loopback only)'}, SameSite=${c.web.sameSite}`);
    console.log(`workshop: ${c.workshop.enabled ? 'on' : 'off'}; inbox: ${c.inbox.enabled ? 'on' : 'off'}${c.inbox.ownerQuestionLabel ? ` (owner label "${c.inbox.ownerQuestionLabel}")` : ''}`);
    if (c.issueSource) console.log(`issues: ${c.issueSource.type} ${c.issueSource.repo}${c.issueSource.tokenEnv ? ` (token from $${c.issueSource.tokenEnv})` : ''}`);
    return;
  }

  if (cmd === 'backup') {
    const config = loadConfig(configPath);
    const state = openState(config, dataDir);
    try {
      const r = await backupDb(state.db, { dataDir, instanceId: config.instance.id, out: values.out ?? null });
      console.log(`backup written: ${r.file} (integrity ok, ${r.users} user(s))`);
    } finally {
      state.db.close();
    }
    return;
  }

  if (cmd === 'user' || cmd === 'inbox') {
    const config = loadConfig(configPath);
    const state = openState(config, dataDir);
    try {
      if (cmd === 'user') await userCommand(config, state, values, rest);
      else inboxCommand(state, values, rest);
    } finally {
      state.db.close();
    }
    return;
  }

  // Check the serve options before touching the config, data or network.
  const serveOpts = cmd === 'serve' ? resolveServeOptions(values, process.env) : null;
  const inst = openInstance({ configPath, dataDir });

  if (cmd === 'sync') {
    const r = await inst.syncAll();
    console.log(JSON.stringify(r));
    if (!r.mirror) process.exitCode = 1;
    return;
  }

  if (cmd === 'tool') {
    const viewer = createViewer(inst.config, values.role ?? inst.config.defaultRole);
    const [name, ...kv] = rest;
    const args = Object.fromEntries(kv.map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
    await inst.mirror.open();
    if (inst.issues && ['get_box', 'search'].includes(name)) await inst.issues.refresh().catch(() => {});
    const tools = {
      status: () => inst.core.status(viewer),
      list_boxes: () => inst.core.list_boxes(viewer),
      get_box: () => inst.core.get_box(viewer, args.id, args),
      get_document: () => inst.core.get_document(viewer, args.path),
      search: () => inst.core.search(viewer, args.q),
    };
    if (!tools[name]) throw new Error(`unknown tool "${name}"`);
    console.log(JSON.stringify(await tools[name](), null, 2));
    return;
  }

  if (cmd === 'serve') {
    const { host, port, devUser, public: isPublic } = serveOpts;
    if (isPublic && !inst.config.web.secureCookies) throw new Error(`refusing to bind to ${host} with web.secure_cookies: false; this is only allowed on a loopback address`);
    if (values.role) console.warn('[bteam] --role is ignored by serve: the role comes from the signed-in user');
    const state = openState(inst.config, dataDir);
    if (devUser && !state.auth.getUser(devUser)) throw new Error(`--dev-user "${devUser}" does not exist; create it with "bteam user add"`);
    if (!state.auth.listUsers().length) console.warn('[bteam] no users yet: create one with "bteam user add <id> --role <role>"');
    state.auth.prune();
    setInterval(() => state.auth.prune(), 3600_000).unref();
    await inst.mirror.open();
    const r = await inst.syncAll();
    console.log(`[bteam] source ${r.mirror ?? 'NOT synced'}${inst.issues ? `, issues ${r.issues ?? 'unavailable'}` : ''}`);
    inst.schedule();
    const handler = createHandler({ core: inst.core, auth: state.auth, workshop: state.workshop, inbox: state.inbox, themeCss: loadThemeCss(inst.config.instance.theme), devUser, docsDir: resolveDocsDir(inst.config, process.env) });
    await startServer({ handler, host, port });
    if (isPublic) console.warn(`[bteam] bound to ${host}: serve only behind an HTTPS reverse proxy${inst.config.web.trustProxy ? '' : ' (web.trust_proxy is false: rate limits will see the proxy address)'}`);
    if (devUser) console.warn(`[bteam] DEVELOPMENT: requests from this machine act as "${devUser}" without login`);
    console.log(`[bteam] serving "${inst.config.instance.title}" on http://${host.includes(':') ? `[${host}]` : host}:${port}/ (login required)`);
    return;
  }

  throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
}

main().catch((err) => {
  console.error(err instanceof ConfigError || err instanceof ServeOptionsError || err instanceof BackupError ? err.message : `bteam: ${err.message}`);
  process.exit(1);
});
