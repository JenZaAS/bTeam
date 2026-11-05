# Deploying bTeam

This is the generic recipe for running one bTeam instance on a server behind an HTTPS reverse proxy. It uses Docker and Traefik as the example (for instance the Traefik that a Dokploy host already runs), with placeholder names: `team.example.com`, the container `bteam-example`, and the proxy network `proxy-network-name`. Replace them with your own values in your deployment files, which belong outside this repository.

For running on a laptop without Docker, see [RUN.md](RUN.md).

## 1. What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Image | built from this repo's `Dockerfile` | Node 22, non-root user `bteam` (uid 10001), git, tini. It contains no instance data and no secrets. |
| Instance config | host file, mounted read-only at `/config/instance.yaml` | Project-specific; never commit it to this repo. |
| Tokens | host `.env` (mode 600), passed as environment variables | Only read-only tokens, see section 3. |
| Data | named volume at `/data` | `mirror/<id>.git` (bare mirror) and `<id>.sqlite` (users, sessions, Workshop, Inbox, audit log). Back it up. |
| HTTP | container port 8080 | Reached by the proxy over a shared Docker network. On the host, publish it on loopback only, or not at all. |

The container runs with a read-only root filesystem: everything it writes goes to `/data`, with a small tmpfs at `/tmp`.

## 2. Bind address

`bteam serve` binds to `127.0.0.1` unless told otherwise. The image sets `BTEAM_HOST=0.0.0.0` so the proxy can reach it inside the container network; `--host` overrides the env var. Outside a container, leave the default.

- Never publish the port on a public interface (`-p 8080:8080` publishes on all addresses). Use `127.0.0.1:<port>:8080` or no `ports:` at all.
- `--dev-user` is refused on a non-loopback bind, including one set by `BTEAM_HOST`.
- On a non-loopback bind, `web.secure_cookies` must stay `true`, which is the default. Cookies are then `Secure` and `__Host-` prefixed, so the site has to be served over HTTPS.

## 3. Configuration and secrets

1. Write the `instance.yaml` (start from [instance.example.yaml](../instance.example.yaml)) and run `bteam check` on it. For a deployment behind the proxy:
   ```yaml
   web:
     secure_cookies: true   # default
     trust_proxy: true      # only when the proxy replaces X-Forwarded-For (see 5.3)
     public_origin: https://app.example.test  # Origin must match this; see 5.3
   source:
     refresh: 1h
   issue_source:
     refresh: 1h
   ```
2. Create a `.env` next to it, owned by root with mode `600`:
   ```sh
   BTEAM_SOURCE_TOKEN=   # read-only: contents read (and metadata) on the source repository only
   BTEAM_ISSUES_TOKEN=   # read-only: issues read (and metadata) on the same repository only
   ```
   Use fine-grained tokens limited to the one repository, with an expiry date. bTeam never writes to the forge, so it never needs write scopes. Leave a token empty if the repository is public or you use an ssh deploy key (`GIT_SSH_COMMAND`). The token names are whatever `source.token_env` and `issue_source.token_env` say.
3. Environment variables the image understands:

| Variable | Default in image | Meaning |
| --- | --- | --- |
| `BTEAM_HOST` | `0.0.0.0` | Bind address (the code default is `127.0.0.1`). |
| `PORT` | `8080` | Listen port. |
| `BTEAM_CONFIG` | `/config/instance.yaml` | Instance config. |
| `BTEAM_DATA_DIR` | `/data` | Mirror and database. |
| `DOCS_DIR` | unset | Built static site served at `/docs`. Overrides `docs.dir`. |
| token env vars | unset | As named in the config; values only in `.env`. |
| `NODE_OPTIONS` | unset | Example: `--max-old-space-size=256`. |

## 4. Build and start

```sh
git clone <bTeam repository> bteam && cd bteam && git checkout <commit>   # git status must be clean
docker build -t bteam:<short sha> .
```
The build stage compiles `better-sqlite3` and therefore needs `python3`, `make` and `g++`. Those exist only in the build stage; the runtime image ships no npm, npx, corepack or yarn.

Then start the service with Compose, starting from [deploy/compose.example.yaml](../deploy/compose.example.yaml):

```sh
mkdir -p /srv/bteam/example && cd /srv/bteam/example
cp <repo>/deploy/compose.example.yaml compose.yaml    # edit: names, image tag, port, network
cp /path/to/instance.yaml instance.yaml              # chmod 644
install -m 600 /dev/null .env                         # then fill in the tokens with an editor
docker compose up -d
docker compose logs -f bteam                          # expect: "source <sha>, issues <n>" and "serving ..."
```

The example service is hardened: `read_only`, `cap_drop: ALL`, `no-new-privileges`, a pids limit, and CPU and memory limits. The first clone of a large repository can take a few minutes. The health check (`/healthz`, see section 7) has a 3-minute start period.

**Dokploy hosts.** Dokploy runs Traefik on its own `dokploy-network`, with the `web`/`websecure` entry points and the `letsencrypt` resolver. You can run the service as a plain Compose project outside Dokploy, attached to that network (shown here), or as a Dokploy "Docker Compose" or "Application" project with the same settings. Either way, keep the read-only, cap-drop and loopback-only rules.

## 5. Reverse proxy (Traefik)

### 5.1 Route
- **File provider** (recommended when the proxy is managed by hand): copy [deploy/traefik-dynamic.example.yaml](../deploy/traefik-dynamic.example.yaml) into Traefik's dynamic configuration directory and replace the host and container names. Traefik reloads it without a restart.
- **Docker labels**: see the commented `labels:` block in the Compose example. Traefik must watch Docker, and `traefik.docker.network` must name the shared network.

### 5.2 Headers
bTeam sets its own CSP (`default-src 'none'`, no scripts, `frame-ancestors` from the config), `X-Content-Type-Options`, `Referrer-Policy: same-origin`, COOP/CORP and `Cache-Control: no-store`. At the proxy, add HSTS and `X-Robots-Tag: noindex, nofollow`, and redirect HTTP to HTTPS. Do not add a second CSP at the proxy, because it would combine with bTeam's. A basic-auth layer is optional; bTeam has its own login on every page except `/login`, `/healthz` and the two stylesheets.

### 5.3 Client addresses (`web.trust_proxy`)
With `trust_proxy: true`, bTeam takes the client address for login rate limits from the **first** `X-Forwarded-For` entry. That is only correct if the proxy discards client-sent `X-Forwarded-*` headers. Traefik does this by default for entry points with no `forwardedHeaders.trustedIPs` or `forwardedHeaders.insecure`. Check the entry point, and test it as in section 9. The container must only be reachable through the proxy; other containers on the same network could otherwise send their own header.

The same-origin check on form POSTs does not use `trust_proxy` or `X-Forwarded-Host`. A client can send both `X-Forwarded-Host` and a matching `Origin`. When `web.public_origin` is set, `Origin` must equal that origin (scheme, host and port). When it is unset, the `Origin` host must equal the `Host` header. Set `public_origin` if the proxy leaves `Host` as an internal name; otherwise a browser's `Origin` will not match and login is refused.

## 6. First-run users

There is no sign-up page. Create the accounts inside the running container. The CLI uses the same database, and that's safe while the server is running:

```sh
docker exec -it bteam-example bteam user add <id> --role <role>      # asks for the password twice
docker exec bteam-example bteam user list
```

To use a generated password without showing it on screen or in shell history:

```sh
umask 077
openssl rand -base64 24 > /root/bteam-<id>.pw                        # root-only file on the host
docker exec -i bteam-example bteam user add <id> --role <role> --password-stdin < /root/bteam-<id>.pw
```

Passwords need at least `auth.min_password_length` characters (12 by default) and must not contain the user id. Hand them over out of band, ask the users to change them later with `user reset`, and delete the file once they're delivered. `user reset`, `user unlock`, `user disable` and `inbox list|show|update` work the same way through `docker exec`.

## 7. Refresh and health

- **Refresh runs in-process.** `serve` mirrors the source once at start, then fetches it again every `source.refresh`, and refreshes issues every `issue_source.refresh` (for example `1h`). No cron job is needed. A failed refresh is logged (`mirror sync failed` / `issue refresh failed`, with tokens redacted), and the last good commit keeps being served.
- **`/healthz`** returns 200 `ok` once the source has been mirrored at least once, and 503 `not synced` before that. It shows no user data. The image's `HEALTHCHECK` runs `bin/healthcheck.js`, which calls it on loopback. A container that never manages its first sync (for example because of a wrong token) turns unhealthy. Restarts reuse the mirror already on the volume.
- A manual refresh is a container restart (`docker compose restart bteam`).

## 8. Backup, upgrade and rollback

**Backup.** Make a consistent online copy of the database, safe while serving:
```sh
docker exec bteam-example bteam backup                    # writes /data/backups/<id>-<UTC time>.sqlite (mode 600), verified
docker cp bteam-example:/data/backups/. /srv/bteam/example/backups/   # keep a copy off the volume
```
The mirror doesn't need a backup, because it is re-cloned from the source.

**Upgrade.**
1. Run `bteam backup` and note the current image ID (`docker inspect -f '{{.Image}}' bteam-example`).
2. Build the new commit as `bteam:<new short sha>`, set the new tag in `compose.yaml`, and run `docker compose up -d`.
3. Run the checks in section 9. Database migrations run automatically at start, are forward-only, and are listed in the release notes when there are any.

After an upgrade, any Markdown file without an `audience` value in the allowed lists stops appearing in listings and search, and returns 404. To keep it visible, add `audience: all` to its front matter, sync, then reload. `audiences: []` hides all Markdown. A non-Markdown file is owner-only unless its extension is in `docs.public_extensions` (png, jpg, jpeg, gif, svg and webp when the key is omitted). It drops out of listings and search and returns 404 for a role whose audiences do not include `owner`. Set `roles.owner.audiences` to every audience value in use, for example `[all, owner]`, then reload. The static `/docs` site is not filtered by audience, so only publish a site built from pages meant for everyone, including its search index, and use `docs.hide_paths` for anything to hide.

**Rollback.** Put the previous image tag or ID back in `compose.yaml` and run `docker compose up -d`. If the new version migrated the database, also stop the container, restore the backup into the volume, and start it again:
```sh
docker compose stop bteam
docker run --rm -v bteam-example_bteam-data:/data -v /srv/bteam/example/backups:/b:ro --user 10001:10001 \
  --entrypoint sh bteam:<old sha> -c 'cp /b/<backup file> /data/<id>.sqlite && rm -f /data/<id>.sqlite-wal /data/<id>.sqlite-shm'
docker compose up -d
```
To remove the instance completely, delete the proxy route first, then the container, then (after a final backup) the volume.

## 9. Verification checklist

- `docker compose ps` shows the container as healthy, and `curl -s http://127.0.0.1:<port>/healthz` prints `ok`.
- `docker exec bteam-example sh -c 'id -u; command -v npm npx corepack yarn'` prints `10001` and nothing else.
- `docker inspect` shows `ReadonlyRootfs: true`, `CapDrop: [ALL]`, and port bindings on `127.0.0.1` only.
- `https://team.example.com/` without a cookie gives a 303 to `login`. `https://team.example.com/login` gives 200 with `content-security-policy`, `x-content-type-options`, `referrer-policy`, HSTS and `x-robots-tag`. `http://` redirects to `https://`.
- The session cookie is `__Host-bteam_session` with `HttpOnly`, `Secure` and the configured `SameSite`.
- Each role sees only what it should. Sign in as each user and check that the hidden paths, labels and boxes from `roles:` don't show up in boxes, search, `doc?path=`, `raw?path=` or `api/search`.
- `X-Forwarded-For` forgery fails: send a few failed logins for a made-up user id from outside with forged `X-Forwarded-For` values, then run
  `docker exec bteam-example node -e "const D=require('/app/node_modules/better-sqlite3');const d=new D('/data/<id>.sqlite',{readonly:true});console.log(d.prepare(\"SELECT DISTINCT key FROM rate_events WHERE key LIKE 'ip:%'\").all())"`
  It should list only real client addresses, never the forged values.
- A port scan from outside the host shows nothing new.
- The logs show no token and no `mirror sync failed` after start.
