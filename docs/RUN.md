# Running bTeam locally (step 1)

Step 1 is the read-only core: a git mirror of the source repository, the boxes, the read tools and a plain web UI. There is **no login yet** (step 2), so the server binds to `127.0.0.1` only.

## Requirements
- Node.js 20 or newer and `git` on the PATH.
- Access to the source repository: public, an ssh deploy key, or a **read-only** token in an env var.

## Setup
```sh
npm ci
cp instance.example.yaml instance.yaml   # or point --config at a config kept outside the repo
cp .env.example .env                     # only if you need tokens
```

Edit `instance.yaml` (see the comments in `instance.example.yaml`), then validate it:
```sh
node bin/bteam.js check --config instance.yaml
```

## Run
```sh
# Load tokens into the environment if needed (never pass them on the command line)
set -a; . ./.env; set +a

node bin/bteam.js sync  --config instance.yaml --data ./data   # mirror once
node bin/bteam.js serve --config instance.yaml --data ./data --port 8080 --role owner
```
Open http://127.0.0.1:8080/. `serve` syncs at start and then refreshes the mirror and issues on the configured schedule (`source.refresh`, `issue_source.refresh`).

To preview what another role sees, run a second server with `--role <role> --port 8081`.

## Read tools from the command line
The same tools the UI uses, as JSON (useful for agents and, later, an MCP server):
```sh
node bin/bteam.js tool list_boxes   --config instance.yaml --data ./data --role owner
node bin/bteam.js tool get_box id=decisions --config instance.yaml --data ./data
node bin/bteam.js tool get_document path=README.md --config instance.yaml --data ./data
node bin/bteam.js tool search q=mirror --config instance.yaml --data ./data
```
The web server exposes the same tools read-only under `api/<tool>?...` (`status`, `list_boxes`, `get_box`, `get_document`, `search`).

## Private repositories
- **https:** set `source.token_env` to the name of an env var that holds a read-only token (e.g. a fine-grained token with contents: read). The token is passed to git through an environment-scoped `http.extraHeader`; it is never written to the mirror's config, the command line or logs.
- **ssh:** use an `ssh://` or `git@host:` URL with a read-only deploy key. `GIT_SSH_COMMAND` is passed through if set.
- Issues: set `issue_source.token_env` to a read-only token with issues: read.

## Theme (optional)
`instance.theme` points to a JSON file of tokens, served as CSS custom properties:
```json
{ "tokens": { "bg": "#ffffff", "fg": "#1a1a1a", "accent": "#3355ff", "accent-fg": "#ffffff", "font-body": "system-ui, sans-serif", "radius": "8px" } }
```
Allowed tokens: `bg`, `fg`, `muted`, `surface`, `border`, `accent`, `accent-fg`, `link`, `warn`, `font-body`, `font-heading`, `font-mono`, `radius`, `max-width`. Unsafe values are dropped. Without a theme the UI uses the browser's system colours.

## Tests
```sh
npm test
```
The tests build throw-away git repositories, mirror them and exercise the boxes, visibility rules, rendering safety and the HTTP server. They need no network.

## Security notes for step 1
- No login: keep it on `127.0.0.1` (the server refuses other addresses unless `--insecure-public-bind` is given, which is only meant for use behind an authenticating proxy).
- Only GET/HEAD. Strict CSP (`default-src 'none'`, no scripts), `nosniff`, `no-referrer`.
- Raw HTML in Markdown is shown as text; `javascript:`/`data:` links are dropped; only files inside a visible box can be opened.
