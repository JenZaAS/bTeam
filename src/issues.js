// Read-only issue listing from a forge API (GitHub-compatible) using an optional read-only token.
export class IssueSource {
  constructor({ repo, apiUrl = 'https://api.github.com', tokenEnv = null, maxPages = 5, env = process.env, fetchImpl = globalThis.fetch }) {
    this.repo = repo;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.tokenEnv = tokenEnv;
    this.maxPages = maxPages;
    this.env = env;
    this.fetch = fetchImpl;
    this.issues = [];
    this.lastSync = null;
    this.lastError = null;
  }

  async refresh() {
    const token = this.tokenEnv ? this.env[this.tokenEnv] : null;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bteam',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const all = [];
    try {
      for (let page = 1; page <= this.maxPages; page++) {
        const url = `${this.apiUrl}/repos/${this.repo}/issues?state=all&per_page=100&page=${page}&sort=updated&direction=desc`;
        const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`issue API answered ${res.status}${res.status === 404 && !token ? ' (private repository? set a read-only token)' : ''}`);
        const items = await res.json();
        if (!Array.isArray(items)) throw new Error('unexpected issue API response');
        for (const i of items) {
          if (i.pull_request) continue;
          all.push({
            number: i.number,
            title: String(i.title ?? ''),
            state: i.state === 'closed' ? 'closed' : 'open',
            labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
            url: typeof i.html_url === 'string' && /^https:\/\//.test(i.html_url) ? i.html_url : null,
            body: typeof i.body === 'string' ? i.body.slice(0, 20_000) : '',
            createdAt: i.created_at ?? null,
            updatedAt: i.updated_at ?? null,
          });
        }
        if (items.length < 100) break;
      }
      this.issues = all;
      this.lastSync = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.lastError = token ? String(err.message).split(token).join('***') : err.message;
      throw new Error(this.lastError);
    }
  }

  /** Issues matching any of `labels` (empty = all) and the given state. */
  query({ labels = [], state = 'open' } = {}) {
    const want = labels.map((l) => l.toLowerCase());
    return this.issues.filter(
      (i) => (state === 'all' || i.state === state) && (!want.length || i.labels.some((l) => want.includes(l.toLowerCase()))),
    );
  }
}
