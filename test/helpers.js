import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { Mirror } from '../src/mirror.js';
import { IssueSource } from '../src/issues.js';
import { createCore } from '../src/core.js';
import { createViewer } from '../src/visibility.js';

// 1x1 PNG
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

export const FILES = {
  'README.md': '# Sample project\n\nSee [guide](docs/guide.md) and [missing](docs/nope.md).\n',
  'docs/guide.md': '# Guide\n\n## Install\n\nRun it.\n\n## Usage\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [ext](https://example.com) [adr](../decisions/0001-first.md#why)\n\n![shot](../shots/2026-01-02/home-390.png)\n',
  'docs/secret-ops.md': '# Ops runbook\n\nInternal only.\n',
  'decisions/0001-first.md': '---\ntitle: Use a mirror\ndate: 2026-01-01\nstatus: accepted\n---\n# Use a mirror\n\n## Why\n\nBecause.\n',
  'decisions/0002-second.md': '# Second decision\n\n- Date: 2026-01-05\n- Status: proposed\n',
  'decisions/README.md': '# Decisions\n',
  'digest/README.md': '# About the digest\n',
  'digest/2026-01-01.md': '# Digest 1 Jan\n\nOld news.\n',
  'digest/2026-01-02.md': '# Digest 2 Jan\n\nFresh news about the mirror.\n',
  'PLAN.md': '# Plan\n\n## Stack\n\nx\n\n## Status 2026-01-01\n\none\n\n## Status 2026-01-02\n\ntwo\n\n## Status 2026-01-03\n\nthree\n\n## Later\n\n- a pending choice\n',
  'shots/2026-01-01/home-390.png': PNG,
  'shots/2026-01-02/home-390.png': PNG,
  'shots/2026-01-02/home-1440.png': PNG,
  'shots/2026-01-02/dark-home-390.png': PNG,
  'shots/2026-01-02/settings-390.png': PNG,
  'shots/2026-01-02/NOTES.md': '# Notes\n\n## Top fixes\n\n1. Contrast\n',
  'src/app.js': 'console.log("hi");\n',
  'src/bin.dat': Buffer.from([0, 1, 2, 3]),
  'secret/.env': 'NOT_A_REAL_VALUE=1\n',
};

export function makeSourceRepo(files = FILES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-src-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return {
    dir,
    url: `file://${dir}`,
    commit(p, content, msg = 'update') {
      fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), content);
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
    },
  };
}

export function sampleRawConfig(url) {
  return {
    instance: { id: 'sample', title: 'Sample', locale: ['en', 'nb'] },
    source: { type: 'git-mirror', url, branch: 'main', refresh: '10m' },
    boxes: [
      { id: 'digest', type: 'digest', pattern: 'digest/*.md', latest: 1 },
      { id: 'decisions', type: 'decisions', paths: ['decisions/*.md'], fallback: { file: 'PLAN.md', heading: '^Later' } },
      { id: 'now', type: 'documents', paths: ['PLAN.md'], sections: { heading: '^Status ', latest: 2 } },
      { id: 'design', type: 'gallery', root: 'shots/', group_by_folder: 'date', filename_pattern: '^(?:(?<variant>dark)-)?(?<page>[a-z0-9-]+)-(?<width>\\d+)\\.png$', notes_file: 'NOTES.md' },
      { id: 'docs', type: 'documents', paths: ['docs/*.md', 'README.md'] },
      { id: 'questions', type: 'open-questions', issues: { labels: ['needs-owner-decision'] } },
      { id: 'issues', type: 'issues', issues: { labels: [], state: 'open' } },
      { id: 'source', type: 'source-browser', include: ['**/*'], exclude: ['secret/**'] },
    ],
    issue_source: { type: 'github', repo: 'example-org/example-project', token_env: 'TEST_ISSUES_TOKEN' },
    roles: {
      owner: {},
      designer: {
        hide: { issue_labels: ['security', 'sev:*'], issue_title_patterns: ['^security\\b'], paths: ['docs/secret-*.md'] },
        policy: { auto_accept_eligible: ['ui'], route_other_to: 'owner' },
      },
    },
    viewer: { default_role: 'owner' },
  };
}

export const ISSUES = [
  { number: 1, title: 'Button too small', state: 'open', labels: [{ name: 'design' }], html_url: 'https://example.com/i/1', body: 'Make it **bigger** <img src=x onerror=alert(1)>' },
  { number: 2, title: 'Security: header missing', state: 'open', labels: [{ name: 'security' }, { name: 'sev:high' }], html_url: 'https://example.com/i/2', body: '' },
  { number: 3, title: 'Which colour for the header?', state: 'open', labels: [{ name: 'needs-owner-decision' }], html_url: 'https://example.com/i/3', body: '' },
  { number: 4, title: 'Kernel advisory', state: 'open', labels: [{ name: 'sev:medium' }], html_url: 'https://example.com/i/4', body: '' },
  { number: 5, title: 'Security review of uploads', state: 'open', labels: [], html_url: 'https://example.com/i/5', body: '' },
  { number: 6, title: 'Old bug', state: 'closed', labels: [], html_url: 'https://example.com/i/6', body: '' },
  { number: 7, title: 'A pull request', state: 'open', labels: [], pull_request: {}, html_url: 'https://example.com/p/7' },
];

export function fakeFetch(items = ISSUES, calls = []) {
  return async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return { ok: true, status: 200, json: async () => items };
  };
}

export async function makeInstance({ raw, files } = {}) {
  const src = makeSourceRepo(files);
  const config = validateConfig(raw ?? sampleRawConfig(src.url));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-data-'));
  const mirror = new Mirror({ url: config.source.url, branch: config.source.branch, dir: path.join(data, 'mirror.git'), tokenEnv: null });
  await mirror.sync();
  const issues = new IssueSource({ repo: config.issueSource.repo, tokenEnv: 'TEST_ISSUES_TOKEN', env: {}, fetchImpl: fakeFetch() });
  await issues.refresh();
  const core = createCore({ config, mirror, issues });
  return { src, config, mirror, issues, core, owner: createViewer(config, 'owner'), designer: createViewer(config, 'designer') };
}
