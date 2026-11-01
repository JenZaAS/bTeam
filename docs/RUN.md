# Running bTeam locally

bTeam is a read-only core (a git mirror of the source repository, the boxes, the read tools and a plain web UI) plus, since step 2, user accounts, a private Workshop per user and the Inbox. Every page needs a login.

## Requirements
- Node.js 22 or newer and `git` on the PATH. (`better-sqlite3` and `@node-rs/argon2` install prebuilt binaries for common platforms.)
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
node bin/bteam.js serve --config instance.yaml --data ./data --port 8080
```
Open http://127.0.0.1:8080/ and sign in. `serve` syncs at start and then refreshes the mirror and issues on the configured schedule (`source.refresh`, `issue_source.refresh`).

The data directory holds the mirror and the instance database (`<instance id>.sqlite`: users, sessions, Workshop, Inbox, audit log). Keep it out of git and back it up.

## Users
There is no self-signup. Create each person on the server; the password is typed at a hidden prompt (twice) and only an argon2id hash is stored:
```sh
node bin/bteam.js user add <id> --role <role> --config instance.yaml --data ./data
node bin/bteam.js user list  --config instance.yaml --data ./data
node bin/bteam.js user reset <id> ...            # new password; signs the user out everywhere
node bin/bteam.js user set-role <id> <role> ...  # signs the user out everywhere
node bin/bteam.js user disable <id> ... / user enable <id> ...
node bin/bteam.js user unlock <id> ...           # clear a lock after too many failed logins
```
For scripts, `--password-stdin` reads the password from the first line of stdin. Never put a password on the command line or in a file in the repository. Passwords must be at least `auth.min_password_length` (default 12) characters and must not contain the user id.

## Cookies, HTTPS and proxies
- By default session cookies are `Secure` (`__Host-` prefixed), so browsers only send them over HTTPS (browsers also accept them on `http://localhost`/`127.0.0.1`).
- For plain-http testing on another loopback setup you can set `web.secure_cookies: false`; `serve` refuses this on a non-loopback address.
- The bind address is `127.0.0.1` unless `--host` or the `BTEAM_HOST` env var says otherwise (`--host` wins). The container image sets `BTEAM_HOST=0.0.0.0`; see [DEPLOY.md](DEPLOY.md).
- `serve --host 0.0.0.0` is allowed now that there is a login, but only behind an HTTPS reverse proxy. Set `web.trust_proxy: true` only if that proxy sets `X-Forwarded-For` and `X-Forwarded-Host`; otherwise rate limiting would see the proxy's address for everyone.
- Session and lockout limits are under `auth:` (see `instance.example.yaml`).

## Backup
```sh
node bin/bteam.js backup --config instance.yaml --data ./data            # -> data/backups/<id>-<UTC time>.sqlite
node bin/bteam.js backup --out /safe/place/x.sqlite --config instance.yaml --data ./data
```
A consistent, integrity-checked copy (mode 600), safe while `serve` is running. It never overwrites an existing file.

## Development override
`serve --dev-user <id>` makes requests from the same machine act as an existing user without logging in, to speed up UI work. It is refused unless `--host` is a loopback address, it ignores non-loopback clients, and every page shows a warning banner. Do not use it on a server.

## Inbox processing (for the external agent)
```sh
node bin/bteam.js inbox list   --status new --json --config instance.yaml --data ./data
node bin/bteam.js inbox show 12 --config instance.yaml --data ./data
node bin/bteam.js inbox update 12 --status issue-created --issue-url https://forge.example/org/repo/issues/40 --note "adopted" ...
node bin/bteam.js inbox update 13 --status question-back --reply "Which screens do you mean?" ...
```
Statuses: `new`, `triaged`, `accepted`, `issue-created` (needs `--issue-url`), `digest`, `question-back` (needs `--reply`), `rejected`. Each item carries a `route` from the submitter's role policy (`auto-accept-eligible`, `owner-decision` with `routeLabel`, or `standard`). bTeam never contacts the forge: the agent creates issues itself and records the result here. `--reply` is shown to the user; `--note` is internal.

## Read tools from the command line
The same tools the UI uses, as JSON (useful for agents and, later, an MCP server):
```sh
node bin/bteam.js tool list_boxes   --config instance.yaml --data ./data --role owner   # --role is for the CLI only
node bin/bteam.js tool get_box id=decisions --config instance.yaml --data ./data
node bin/bteam.js tool get_document path=README.md --config instance.yaml --data ./data
node bin/bteam.js tool search q=mirror --config instance.yaml --data ./data
```
The web server exposes the same tools read-only under `api/<tool>?...` (`status`, `list_boxes`, `get_box`, `get_document`, `search`), for signed-in users with their role (401 otherwise).

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
The tests build throw-away git repositories and databases, and exercise the boxes, visibility rules, rendering safety, login, sessions, CSRF, rate limiting, Workshop isolation, the Inbox and the HTTP server. They need no network and use placeholder passwords only.

## Security notes
- Every route except `login`, `healthz` and the stylesheets needs a session; the role comes from the account.
- Only GET/HEAD and form POSTs (with a CSRF token and a same-origin check). Strict CSP (`default-src 'none'`, no scripts), `nosniff`, `no-referrer`, COOP `same-origin`.
- Raw HTML in Markdown (documents, Workshop notes, Inbox text) is shown as text; `javascript:`/`data:` links are dropped; only files inside a visible box can be opened.
- See `docs/ARCHITECTURE.md` (sections 4c and 11) for session, password and rate-limit details.
