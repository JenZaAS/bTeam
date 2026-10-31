// Wires one instance together: config + mirror + issue source + core, with scheduled refresh.
import path from 'node:path';
import { loadConfig } from './config.js';
import { Mirror } from './mirror.js';
import { IssueSource } from './issues.js';
import { createCore } from './core.js';

export function openInstance({ configPath, dataDir, env = process.env, fetchImpl }) {
  const config = loadConfig(configPath);
  const mirror = new Mirror({
    url: config.source.url,
    branch: config.source.branch,
    dir: path.join(dataDir, 'mirror', `${config.instance.id}.git`),
    tokenEnv: config.source.tokenEnv,
    env,
  });
  const issues = config.issueSource
    ? new IssueSource({ repo: config.issueSource.repo, apiUrl: config.issueSource.apiUrl, tokenEnv: config.issueSource.tokenEnv, maxPages: config.issueSource.maxPages, env, fetchImpl })
    : null;
  const core = createCore({ config, mirror, issues });

  async function syncAll({ log = console } = {}) {
    const result = { mirror: null, issues: null };
    try {
      await mirror.sync();
      result.mirror = mirror.commitInfo?.short ?? null;
    } catch (err) {
      log.error(`[bteam] mirror sync failed: ${err.message}`);
    }
    if (issues) {
      try {
        await issues.refresh();
        result.issues = issues.issues.length;
      } catch (err) {
        log.error(`[bteam] issue refresh failed: ${err.message}`);
      }
    }
    return result;
  }

  function schedule({ log = console } = {}) {
    const timers = [
      setInterval(() => mirror.sync().catch((err) => log.error(`[bteam] mirror sync failed: ${err.message}`)), config.source.refreshMs),
    ];
    if (issues) timers.push(setInterval(() => issues.refresh().catch((err) => log.error(`[bteam] issue refresh failed: ${err.message}`)), config.issueSource.refreshMs));
    for (const t of timers) t.unref();
    return () => timers.forEach(clearInterval);
  }

  return { config, mirror, issues, core, syncAll, schedule };
}
