# bTeam roadmap

Each step ends with tests, a security check of anything exposed, and an OK before the next step.

1. **Core, source browser and instance config**
   - read-only git mirror with scheduled refresh;
   - instance.yaml loader and validation;
   - box types: digest, decisions, gallery, documents, open questions, issues and source browser;
   - read tools (`list_boxes`, `get_box`, `get_document`, `search`);
   - a plain web UI that also works in a sandboxed iframe.
2. **Login and Inbox**
   - individual users with argon2id, secure cookies and login rate limiting;
   - users created from the CLI;
   - the Inbox in the instance SQLite (propose/apply tools), and an export or API for the external processing agent.
3. **Deploy on a subdomain**
   - docker compose, `.env` and `instance.yaml`;
   - DNS and reverse-proxy routing set up by the server administrators;
   - a security review before it goes live.
4. **Workshop and assistant per user**
   - per-user CRUD workspace (notes, mockups, colour profiles, sketches) with item history;
   - optional assistant: one container per user with the user's own login, reachable only on the internal network;
   - a "connect" flow and a "disconnect" action.
5. **Hardening and DigSys module**
   - backups, memory limits, re-login handling and audit log;
   - a `digsys.module.json` (working id `local.bteam`) once the DigSys module format is settled.
