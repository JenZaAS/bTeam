# bTeam architecture

Status: approved design direction; step 1 (sections 3, 4, 4a and the read tools of 10) is implemented. Items marked **OPEN** are not decided yet.

## 1. Principles
- **Content-neutral core:**
  - the code contains no project names, texts, colours, paths or domains;
  - everything project-specific lives in one instance configuration (`instance.yaml`) plus `.env` for secrets;
  - a new instance is a new config, not a code change.
- **The source stays the single source of truth:** bTeam reads the project repository read-only. Users' own contributions live in bTeam, never in the source repository.
- **Small and boring:** one web app and one SQLite file per instance, plus optional assistant containers.

## 2. Components
```
            +-------------------- bTeam instance --------------------+
 source     |  mirror (read-only)  ->  boxes (overview)              |
 repo  ---> |  git fetch on a        digest / decisions / gallery /  |
            |  schedule              documents / questions / issues / |
            |                        source browser                   |
            |                                                         |
 users ---> |  web UI (plain page, iframe-safe)                       |
            |    login (argon2id) -> Workshop (per-user CRUD)         |
            |                     -> Inbox (submissions)              |
            |  SQLite: users, sessions, workshop, inbox               |
            +-----------------|--------------------|-----------------+
                              | internal network   | export/API
                  assistant-<user> containers   external agent
                  (optional, one per user)      (processes Inbox, writes digest)
```

## 3. Sources (read-only)
- A **git mirror** of the source repository (`git clone --mirror`/`fetch`), refreshed on a schedule (e.g. every 10 minutes) or by a webhook.
- It is **never a mounted network share**: mirrors are deterministic, fast and show only what is in the configured branch.
- The mirror uses a read-only credential if the repository is private.
- Issue lists for the issues and open-questions boxes come from the forge API with a **read-only** token.

## 4. Boxes (generic types)
Boxes are filled by **rules in the instance config**: path globs, filename patterns (named groups), issue labels and front-matter tags. All boxes are read-only.

| Type | Content |
|---|---|
| `digest` | The latest digest files (see section 5), with links down to the sources they summarise. |
| `decisions` | Decision records (ADR-style Markdown), listed by date and status, from globs and front-matter filters. |
| `gallery` | Images grouped by folder (e.g. date) and by named groups from the filename pattern (page, variant, width), plus optional notes files. |
| `documents` | ADRs and docs rendered with sections, a table of contents, full-text search and cross-links between documents. |
| `open-questions` | Questions from issues with a label and/or a questions file. |
| `issues` | Open issues filtered by label and state. |
| `source-browser` | A file tree and file viewer over the mirror, with include/exclude globs. |

## 4a. Roles and visibility
- The instance config defines **roles**. Users get a role when they are created (step 2); `users:` in the config may map user ids to roles, never credentials.
- A role can only **hide** content, never add it: box ids, path globs, issue label globs and issue title patterns.
- Hiding applies everywhere: box lists, documents, raw files and images, links (they become dead links) and search.
- A file is reachable only if it is inside at least one box the role can see and not hidden for that role (deny by default).
- A role may carry a **policy** for the Inbox agent, e.g. which kinds of contribution may be adopted directly (`auto_accept_eligible`) and where everything else goes (`route_other_to`). The core only exposes it; the agent applies it.

## 4b. Implementation (step 1)
- Node.js (20+), plain `node:http`, server-rendered HTML with no client scripts. Dependencies: `yaml` (ISC), `marked` (MIT), `picomatch` (MIT).
- The mirror is a bare repository (`git init --bare` + `fetch` of the configured branch); files are read with `git ls-tree`/`git cat-file`, never checked out.
- Read tools: `status`, `list_boxes`, `get_box`, `get_document`, `search` (CLI `bteam tool …` and `api/<tool>`).

## 5. Digest
- An **external agent** writes the digest on a schedule into a `digest/` folder **in the source repository**, via that repository's normal review flow.
- bTeam only **reads and displays** it, with links down to the referenced sources (files, decisions, issues, images).
- bTeam never generates or edits the digest itself.

## 6. Workshop
- Each user has their own editable space with create, read, update and delete.
- Item types: notes, mockups (images/HTML snippets), colour profiles and sketches. Items are versioned so users can iterate.
- An optional assistant (section 9) can create and revise items during a conversation.
- Workshop data is private to its user unless the user sends an item to the Inbox.

## 7. Inbox
- Users **submit contributions** (text plus optional Workshop items).
- An **external agent** processes the Inbox into issues, digest items or follow-up questions back to the user.
- **Users never post to the source repository or the forge directly**, and bTeam holds no write credentials to them.
- Each submission has a status (`new`, `in-review`, `turned-into-issue`, `answered`, `declined`) and a reply field, so users can see what happened.

## 8. Storage
- One **SQLite** database per instance: users, sessions, Workshop items (with versions), Inbox submissions and an audit log.
- The mirror and SQLite live on named volumes. Neither is committed to git.

## 9. Assistant (optional, separate)
- It is turned off by default (`assistant.enabled`).
- When enabled, there is **one container per user**, each with its own data volume and the user's **own** model login. For example a Hermes agent with the user's own ChatGPT device-code login. No user ever runs on another user's account.
- The containers are reachable **only on an internal network** from the bTeam backend. They have no public route.
- The assistant uses bTeam's read and propose tools (section 10) and a minimal toolset (no shell, no file system writes).
- **OPEN:** how the "connect" (device-code) flow is triggered from the web UI; the exact assistant tool restrictions.

## 10. Tools: read / propose / apply
All core logic is exposed as tools, so the same core can serve the web UI, an assistant and (later) DigSys:
- **read:** list boxes, get a box, get a document or section, search, list Workshop items, list my Inbox submissions.
- **propose:** draft a Workshop item change or an Inbox submission. Proposals never change stored data.
- **apply:** store a Workshop change or submit to the Inbox. Apply is triggered only from the UI by the user, with a short-lived one-shot token.

## 11. Authentication
- Individual user accounts only, with no shared passwords.
- Passwords are hashed with **argon2id**. Sessions use secure, httpOnly, SameSite cookies with server-side hashed session tokens.
- **Login rate limiting** per account and per client.
- Users are **created from the CLI** on the server (`bteam user add <name>`), with the password entered locally. There is no self-signup.
- Deny by default: every route, including images and files, requires a session.

## 12. DigSys module (later)
- Target: the core can run as a DigSys module, with a `digsys.module.json` (working id `local.bteam`), an MCP server exposing the read/propose/apply tools, and the UI as a viewer.
- The UI is a **plain web page that works in a sandboxed iframe** (no assumptions about top-level navigation or third-party cookies, state pulled through tools).
- The web login and the assistant stay outside the module.
- **OPEN (needs input from the DigSys maintainers):** the manifest schema and `requires.kit` version, the final publisher id, the transport (stdio vs HTTP), the apply-token flow outside the DigSys client, and the design tokens.

## 13. Deployment
- `docker-compose.yml` + `.env` + `instance.yaml`, with a `bteam` service and optional `assistant-<user>` services on an internal network.
- A reverse proxy handles HTTPS. The host name comes from `.env`.
- A new instance means a new directory with its own `instance.yaml`, `.env` and volumes.
- Secrets (forge read token, assistant API keys) live only in `.env`.
