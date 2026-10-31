# bTeam roadmap

Each step ends with tests, a security check of anything exposed, and an OK before the next step.

1. **Core, source browser and instance config** (done)
   - read-only git mirror with scheduled refresh;
   - instance.yaml loader and validation;
   - box types: digest, decisions, gallery, documents, open questions, issues and source browser;
   - read tools (`list_boxes`, `get_box`, `get_document`, `search`);
   - roles with visibility rules (hide boxes, paths and issues per role) and an optional role policy for the Inbox agent;
   - a plain web UI that also works in a sandboxed iframe.
2. **Login, Workshop notes and Inbox** (built on a feature branch; awaiting review)
   - individual users with argon2id, secure cookies, CSRF protection, session expiry, login rate limiting and lockout;
   - users created and reset from the CLI only; the role comes from the signed-in user;
   - Workshop: private notes and ideas per user with history (attachment table reserved for mockups and colour profiles);
   - the Inbox in the instance SQLite with statuses and role-based routing, and `bteam inbox list|show|update` for the external processing agent (it never posts anywhere itself).
   - Later: an HTTP API for the agent, and the propose/apply tools (with the assistant in step 4).
3. **Deploy on a subdomain**
   - docker compose, `.env` and `instance.yaml`;
   - DNS and reverse-proxy routing set up by the server administrators;
   - a security review before it goes live.
4. **Workshop media and assistant per user**
   - mockups, colour profiles and sketches in the Workshop (on top of the step 2 notes);
   - optional assistant: one container per user with the user's own login, reachable only on the internal network;
   - a "connect" flow and a "disconnect" action.
5. **Hardening and DigSys module**
   - backups, memory limits, re-login handling and audit log;
   - a `digsys.module.json` (working id `local.bteam`) once the DigSys module format is settled.
