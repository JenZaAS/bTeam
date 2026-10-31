# bTeam

bTeam is a small, self-hosted collaboration panel. It lets a few invited people follow a project and contribute to it without touching its repository.

- **Overview:** it shows a project's digest, decisions, open questions, issues, screenshots and documents. All of these are read **read-only** from a git mirror of the project's repository.
- **Workshop:** each user has their own editable space where they can sketch ideas, mockups and colour profiles, optionally together with a personal assistant.
- **Inbox:** users submit contributions. An external agent processes them into issues, digest items or follow-up questions, so users never write to the source repository.

bTeam is **content-neutral**. The code knows nothing about any specific project: everything project-specific lives in one instance configuration (`instance.yaml`). A new deployment is just a new config.

Status: step 2 (login, private Workshop notes and the Inbox) on top of the step 1 read-only core. Not deployed yet; run it locally, see [docs/RUN.md](docs/RUN.md).

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)
- Example config: [instance.example.yaml](instance.example.yaml)
- Running locally: [docs/RUN.md](docs/RUN.md)

License: MIT, see [LICENSE](LICENSE).
