// Read-only git mirror of the source repository.
// The mirror is a bare repository fetched on a schedule; bTeam never pushes and never checks out files.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export class Mirror {
  /**
   * @param {object} opts
   * @param {string} opts.url       source repository URL (no credentials)
   * @param {string} opts.branch    branch to mirror
   * @param {string} opts.dir       directory for the bare mirror
   * @param {string|null} opts.tokenEnv  name of an env var holding a read-only token (https only)
   * @param {object} [opts.env]     environment to read the token from (defaults to process.env)
   */
  constructor({ url, branch, dir, tokenEnv = null, env = process.env }) {
    this.url = url;
    this.branch = branch;
    this.dir = dir;
    this.tokenEnv = tokenEnv;
    this.env = env;
    this.ref = `refs/heads/${branch}`;
    this.commit = null;
    this.commitInfo = null;
    this.lastSync = null;
    this.lastError = null;
    this._files = null;
    this._syncing = null;
  }

  _token() {
    return this.tokenEnv ? this.env[this.tokenEnv] || null : null;
  }

  _gitEnv() {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'https:ssh:file',
      LANG: 'C',
    };
    if (process.env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND;
    const token = this._token();
    if (token && this.url.startsWith('https://')) {
      // Passed as an env-scoped config value: never written to disk, never on the command line.
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return env;
  }

  _redact(msg) {
    let out = String(msg);
    const token = this._token();
    if (token) out = out.split(token).join('***');
    return out.replace(/Authorization: Basic \S+/g, 'Authorization: ***');
  }

  _git(args, { buffer = false, cwd } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd, env: this._gitEnv(), maxBuffer: MAX_FILE_BYTES * 2, encoding: buffer ? 'buffer' : 'utf8', timeout: 300_000 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr && stderr.toString()) || err.message;
            reject(new Error(this._redact(`git ${args[0] === '-C' ? args[2] : args[0]} failed: ${detail.trim()}`)));
          } else resolve(stdout);
        },
      );
    });
  }

  /** Create the bare mirror if needed and fetch the configured branch. Safe to call concurrently. */
  sync() {
    if (!this._syncing) {
      this._syncing = this._doSync().finally(() => {
        this._syncing = null;
      });
    }
    return this._syncing;
  }

  async _doSync() {
    try {
      if (!fs.existsSync(path.join(this.dir, 'HEAD'))) {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o750 });
        await this._git(['init', '--bare', '--quiet', this.dir]);
      }
      // Keep the stored remote URL equal to the config (it never contains credentials).
      await this._git(['-C', this.dir, 'config', 'remote.origin.url', this.url]);
      await this._git(['-C', this.dir, 'fetch', '--prune', '--quiet', '--no-tags', 'origin', `+${this.ref}:${this.ref}`]);
      const commit = (await this._git(['-C', this.dir, 'rev-parse', '--verify', `${this.ref}^{commit}`])).trim();
      if (commit !== this.commit) {
        const [hash, date, subject] = (await this._git(['-C', this.dir, 'log', '-1', '--format=%H%x00%cI%x00%s', commit])).trim().split('\0');
        this.commitInfo = { hash, short: hash.slice(0, 7), date, subject };
        this.commit = commit;
        this._files = null;
      }
      this.lastSync = new Date().toISOString();
      this.lastError = null;
      return { commit: this.commit, changed: true };
    } catch (err) {
      this.lastError = this._redact(err.message);
      throw new Error(this.lastError);
    }
  }

  /** Load the current commit of an existing mirror without fetching (e.g. at startup when offline). */
  async open() {
    if (!fs.existsSync(path.join(this.dir, 'HEAD'))) return false;
    try {
      const commit = (await this._git(['-C', this.dir, 'rev-parse', '--verify', `${this.ref}^{commit}`])).trim();
      const [hash, date, subject] = (await this._git(['-C', this.dir, 'log', '-1', '--format=%H%x00%cI%x00%s', commit])).trim().split('\0');
      this.commit = commit;
      this.commitInfo = { hash, short: hash.slice(0, 7), date, subject };
      this._files = null;
      return true;
    } catch {
      return false;
    }
  }

  get ready() {
    return Boolean(this.commit);
  }

  /** All file paths in the mirrored commit, with sizes. */
  async files() {
    if (!this.commit) return [];
    if (this._files && this._files.commit === this.commit) return this._files.list;
    const commit = this.commit;
    const out = await this._git(['-C', this.dir, 'ls-tree', '-r', '-z', '-l', '--full-tree', commit]);
    const list = [];
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).split(/\s+/);
      if (meta[1] !== 'blob') continue;
      list.push({ path: entry.slice(tab + 1), size: Number(meta[3]) || 0 });
    }
    list.sort((a, b) => a.path.localeCompare(b.path));
    this._files = { commit, list, set: new Map(list.map((f) => [f.path, f])) };
    return list;
  }

  async has(p) {
    await this.files();
    return Boolean(this._files?.set.get(p));
  }

  async stat(p) {
    await this.files();
    return this._files?.set.get(p) ?? null;
  }

  /** Read one file of the mirrored commit as a Buffer. */
  async read(p) {
    const info = await this.stat(p);
    if (!info) throw new Error('not found');
    if (info.size > MAX_FILE_BYTES) throw new Error('file too large');
    return this._git(['-C', this.dir, 'cat-file', 'blob', `${this.commit}:${p}`], { buffer: true });
  }

  async readText(p) {
    return (await this.read(p)).toString('utf8');
  }
}
