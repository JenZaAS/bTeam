#!/usr/bin/env node
// bTeam command line: check a config, sync the mirror, run a read tool, or serve the web UI.
import { parseArgs } from 'node:util';
import { openInstance } from '../src/instance.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { createViewer } from '../src/visibility.js';
import { createHandler, startServer, isLoopback } from '../src/server.js';
import { loadThemeCss } from '../src/theme.js';

const USAGE = `Usage: bteam <command> [options]

Commands:
  check                 validate the instance config and print a summary
  sync                  mirror the source repository and refresh issues once
  tool <name> [k=v...]  run a read tool (status, list_boxes, get_box, get_document, search) and print JSON
  serve                 sync, then serve the read-only web UI with scheduled refresh

Options:
  --config <file>   instance config (default: $BTEAM_CONFIG or ./instance.yaml)
  --data <dir>      data directory for the mirror (default: $BTEAM_DATA_DIR or ./data)
  --role <role>     view as this role (default: viewer.default_role)
  --host <host>     bind address (default: 127.0.0.1)
  --port <port>     port (default: $PORT or 8080)
  --insecure-public-bind  allow binding to a non-loopback address (step 1 has NO login)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      data: { type: 'string' },
      role: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'insecure-public-bind': { type: 'boolean' },
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
    if (c.issueSource) console.log(`issues: ${c.issueSource.type} ${c.issueSource.repo}${c.issueSource.tokenEnv ? ` (token from $${c.issueSource.tokenEnv})` : ''}`);
    return;
  }

  const inst = openInstance({ configPath, dataDir });
  const viewer = createViewer(inst.config, values.role ?? inst.config.defaultRole);

  if (cmd === 'sync') {
    const r = await inst.syncAll();
    console.log(JSON.stringify(r));
    if (!r.mirror) process.exitCode = 1;
    return;
  }

  if (cmd === 'tool') {
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
    const host = values.host ?? '127.0.0.1';
    const port = Number(values.port ?? process.env.PORT ?? 8080);
    if (!isLoopback(host) && !values['insecure-public-bind']) {
      throw new Error(`refusing to bind to ${host}: step 1 has no login. Use 127.0.0.1, or --insecure-public-bind behind an authenticating proxy.`);
    }
    await inst.mirror.open();
    const r = await inst.syncAll();
    console.log(`[bteam] source ${r.mirror ?? 'NOT synced'}${inst.issues ? `, issues ${r.issues ?? 'unavailable'}` : ''}`);
    inst.schedule();
    const handler = createHandler({ core: inst.core, viewer, themeCss: loadThemeCss(inst.config.instance.theme) });
    await startServer({ handler, host, port });
    console.log(`[bteam] serving "${inst.config.instance.title}" as role "${viewer.role}" on http://${host.includes(':') ? `[${host}]` : host}:${port}/`);
    return;
  }

  throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `bteam: ${err.message}`);
  process.exit(1);
});
