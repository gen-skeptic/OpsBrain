# OpsBrain: instructions for AI coding agents

This file is for AI coding tools (Claude Code, Codex, Cursor, OpenClaw, Hermes) working **on this repository**. For how agents should *use* a running OpsBrain, see `docs/opsbrain/06-agent-conventions.md`.

## What this repo is

OpsBrain is a private, self-hosted system of record for companies run by people and AI agents: a multi-user, multi-agent company database with an MCP server and a web UI, forked from Open Brain (OB1) by Nate B. Jones. License: FSL-1.1-MIT (internal use and professional services allowed; no competing commercial product or service). Keep the license and notices intact.

```text
server/          Deno MCP server (Hono + MCP SDK, Streamable HTTP, stateless): config, db, auth, records, crm, tools, app
server/ui/       web UI for people (escaping html templates, sessions, pages, routes, design system assets)
db/migrations/   SQL migrations, applied once each by db/migrate.ts ({{EMBEDDING_DIM}} is substituted)
admin/           opsbrain-admin CLI (principals, keys, delegations, areas, projects, seed, reembed)
para/            PARA markdown exporter (para.ts and crm.ts pure logic, export.ts I/O) and scheduler
deploy/          Dockerfile, docker-compose.yml, .env.example, seed.example.json, k8s/
tests/           unit tests, plus end-to-end tests (integration, crm, ui) that need OPSBRAIN_TEST_ADMIN_URL
docs/opsbrain/   OpsBrain documentation (keep it in step with the code)
```

Everything else (`extensions/`, `recipes/`, `schemas/`, `dashboards/`, `integrations/`, `skills/`, `primitives/`, `resources/`, older `docs/`) is the upstream Open Brain community library, kept for reference. Do not change it as part of OpsBrain work.

## Commands

```bash
deno task check
```

```bash
OPSBRAIN_TEST_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres deno task test
```

Run both before every commit that touches `server/`, `db/`, `admin/`, `para/` or `tests/`. Add or update tests with every behavior change.

## Guard rails

- **Privacy first.** OpsBrain runs only on servers we control. Never add code that sends records to a third-party service by default (hosted embeddings, analytics, telemetry, error trackers). Local embeddings are the default.
- **Clients never see OpsBrain.** No client-facing endpoints, exports or logins.
- **No client deliverables or client confidential data** in OpsBrain, in seed data, examples or tests.
- **Never alter or drop Open Brain's original `thoughts` columns.** Add columns and tables in a new numbered migration (`db/migrations/00N_name.sql`). Never edit a migration that has shipped.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.
- **Permissions live in the database where possible.** Visibility goes through `ops_can_read`; approval rules through the `ops_enforce_approval` trigger. Do not weaken either; extend tests when you touch them.
- **Every write is attributed.** New write paths must set `created_by` / `updated_by`, `authenticated_as`, `on_behalf_of`, and log an event in `ops_record_events` (records) or `crm_events` (CRM).
- **No credentials, API keys or secrets in any file.** Use environment variables. `deploy/.env` and PARA output folders are gitignored.
- **MCP is remote HTTP only.** No stdio servers, no `claude_desktop_config.json`. OpsBrain is reached over Streamable HTTP at `/mcp`.
- **Web UI safety.** Build HTML only with the escaping `html` template in `server/ui/html.ts`; no inline scripts or styles (the CSP forbids them); every POST route goes through the session + CSRF + same-origin wrapper in `server/ui/routes.ts`. The UI follows the Dautel Design System (`server/ui/assets/dautel.css` is a copy; change the design system upstream first).
- **Pin dependencies.** Exact versions in `deno.json`; commit `deno.lock`.
- **No binary blobs** over 1 MB. **Avoid profanity** in all content.

## Commits

- Small, focused commits with a clear message (`server: ...`, `para: ...`, `db: ...`, `deploy: ...`, `docs: ...`).
- Run `git status --short` before staging and stage only files that belong to the task.
- Never commit `.env` files, keys, database dumps or PARA output.

## Parallel agent worktrees

When several agents work on this repo at once, give each its own Git worktree and branch. The assigned worktree path is the boundary: do not edit sibling worktrees, and do not switch branches in the main checkout while another agent may be working. Remove a worktree with `git worktree remove <path>` once its branch is merged and it is clean.
