# bTeam

bTeam is a small, self-hosted collaboration panel. It lets a few invited people follow a project and contribute to it without touching its repository.

- **Overview:** it shows a project's digest, decisions, open questions, issues, screenshots and documents. All of these are read **read-only** from a git mirror of the project's repository.
- **Workshop:** each user has their own editable space where they can sketch ideas, mockups and colour profiles, optionally together with a personal assistant.
- **Inbox:** users submit contributions. An external agent processes them into issues, digest items or follow-up questions, so users never write to the source repository.

bTeam is **content-neutral**. The code knows nothing about any specific project: everything project-specific lives in one instance configuration (`instance.yaml`). A new deployment is just a new config.

Status: step 2 (login, private Workshop notes and the Inbox) on top of the step 1 read-only core, plus a container image and deploy recipe (step 3). Run it locally with [docs/RUN.md](docs/RUN.md), or on a server with [docs/DEPLOY.md](docs/DEPLOY.md).

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)
- Example config: [instance.example.yaml](instance.example.yaml)
- Running locally: [docs/RUN.md](docs/RUN.md)
- Deploying (Docker, reverse proxy, backup, rollback): [docs/DEPLOY.md](docs/DEPLOY.md)

## Document audience

A Markdown document is listed and served only when its YAML front matter contains an `audience` value that the signed-in user's role allows. The instance config key `audiences` is that list. When the key is omitted, the list is `all`. A role may set its own `audiences` list, which replaces the instance list for users with that role. Values match exactly.

`/doc`, `/file`, `/raw` and `api/get_document` answer 404 when `audience` is missing, empty, or not in the list. Those documents are also left out of box listings and search. `get_document`, `get_box` and `search` use the same rules. Images and other non-Markdown files are unchanged.

## Static pages at /docs

Point `DOCS_DIR` at a built static HTML site (a directory of HTML, assets and `search/search_index.json`). You can instead set `docs.dir` in the instance config; when both are set, `DOCS_DIR` wins. The app then serves that folder at `/docs` for signed-in users. Paths ending in `/` serve `index.html` (no listings). Leave both unset, or point them at a folder that is not there, and `/docs` answers 404 while the app still starts. After a rebuild, replace the folder the app is reading. In a container, mount the folder read-only and set `DOCS_DIR` to the path inside the container. The reverse proxy only forwards `/docs` to the app.

`docs.hide_paths` is a list of path prefixes under `/docs`. A request for one of those prefixes, or for a path under it, answers 404. A path segment that starts with `.` (for example `.env`, `.git` or `.well-known`) is answered the same way as a `..` segment.

License: MIT, see [LICENSE](LICENSE).
