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

## Static pages at /docs

Point `DOCS_DIR` at a folder produced by `mkdocs build` (a directory of HTML, assets and `search/search_index.json`). You can instead set `docs.dir` in the instance config; when both are set, `DOCS_DIR` wins. The app then serves that folder at `/docs` for signed-in users, including directory indexes. Leave both unset, or point them at a folder that is not there, and `/docs` answers 404 while the app still starts. After a rebuild, replace the folder the app is reading. In a container, mount the folder read-only and set `DOCS_DIR` to the path inside the container. The reverse proxy only forwards `/docs` to the app.

License: MIT, see [LICENSE](LICENSE).
