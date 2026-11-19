<h1 align="center">OpsBrain</h1>

<p align="center"><strong>The private system of record for a company run by people and AI agents.</strong><br>
One database, one MCP endpoint, every person and every agent, each with their own identity.</p>

<p align="center">
  <a href="docs/opsbrain/01-setup.md">Set up</a> ·
  <a href="docs/opsbrain/02-connect-clients.md">Connect clients</a> ·
  <a href="docs/opsbrain/03-data-model.md">Data model</a> ·
  <a href="docs/opsbrain/04-para-mirror.md">PARA mirror</a> ·
  <a href="docs/opsbrain/05-security-and-privacy.md">Security and privacy</a> ·
  <a href="docs/opsbrain/06-agent-conventions.md">Agent conventions</a> ·
  <a href="docs/opsbrain/07-crm.md">CRM</a>
</p>

OpsBrain is the memory and system of record for **Dautel Intelligent Operations**: task cards, QA records, decisions and approvals, process improvement, meetings, risks, incidents, a built-in **CRM** (companies, contacts, deal pipeline, activities), invoice and contract records, hiring, playbooks, SOPs and research. Everything about how the company runs, except client deliverables. Agents work through MCP; people use a private web UI for the CRM and the approval queue.

It is self-hosted and private. It runs on our own servers, clients never see it, and nothing in it is published.

> OpsBrain is a fork of [Open Brain](https://github.com/NateBJones-Projects/OB1) by [Nate B. Jones](https://natesnewsletter.substack.com/), a single-user AI memory built on Postgres, pgvector and MCP. OpsBrain keeps Open Brain's `thoughts` table and tools, and turns it into a multi-user, multi-agent company database. Licensed under [FSL-1.1-MIT](LICENSE.md).

## What OpsBrain adds to Open Brain

| | Open Brain | OpsBrain |
| --- | --- | --- |
| Users | One person, one shared access key | People, AI agents and services, each a **principal** with a role and their own hashed, revocable keys |
| Attribution | None | Every record carries `created_by`, `updated_by`, `owner`, `assignee`, `authenticated_as` and `on_behalf_of`, plus a full event history |
| Agents | Clients share one identity | Agents have their own identity; one session key can **act as** delegated agents, and both are recorded |
| Records | Free-form thoughts | Typed company records (26 types) with title, status, project, area, process step, due date, tags and structured fields |
| Privacy | All or nothing | `company` or `restricted` visibility, enforced in the database on every read |
| Decisions | n/a | Financial and ethical decisions require approval by a person with approval rights, **enforced by a database trigger** |
| Organization | Tags | PARA: projects (client engagements and internal), areas of responsibility, resources, archive |
| CRM | n/a | Companies, contacts, a deal pipeline with weighted forecast, and activities, linked to proposals, contracts, invoices and engagements. Employer-boundary screens and won deals are approver-only, **enforced by the database** |
| Interface for people | n/a | A private **web UI** (pipeline board, companies, contacts, deals, approval queue, record view) in the Dautel Design System. Sign in with your key or through SSO |
| Human-readable copy | n/a | A markdown mirror organized with PARA, regenerated **four times a day** (including CRM pages) |
| Hosting | Supabase (cloud) | Self-hosted: Docker Compose or Kubernetes, Postgres + pgvector, local embeddings with Ollama |
| Compatibility | | Open Brain tools (`capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`) still work |

## How it fits together

```text
 People                     AI agents                       Services
 (owner, staff)             (48 role agents in experts)     (Claude Code session, integrations)
     │ own key                  │ own key, or acting_as        │ delegated key
     └──────────────────────────┼──────────────────────────────┘
                                ▼
                 OpsBrain server (Deno)
                 POST /mcp: authenticate key → resolve acting_as → check permissions
                 /crm, /approvals: web UI for people (session, CSRF, SSO optional)
                                │
                                ▼
       Postgres + pgvector (private)         ──►  PARA exporter (00:00, 06:00, 12:00, 18:00)
       principals, keys, delegations               para-output/
       records (thoughts + company columns)          1-Projects/  2-Areas/ (incl. CRM/)  3-Resources/  4-Archive/
       CRM: companies, contacts, deals, stages
       events, links, projects, areas, processes   para-restricted/  (restricted records only, optional)
       approval trigger, visibility function
                                ▲
       Embeddings: local Ollama (nomic-embed-text) or any OpenAI-compatible endpoint you run
```

## Quick start

Full instructions, including Kubernetes, backups and troubleshooting, are in **[Set up OpsBrain](docs/opsbrain/01-setup.md)**. In short:

```bash
git clone https://github.com/gen-skeptic/OpsBrain.git opsbrain && cd opsbrain
```

```bash
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` (database password, public URL, time zone), then create the mirror folders and start everything with local embeddings:

```bash
mkdir -p para-output para-restricted && sudo chown 1993:1993 para-output para-restricted && sudo chmod 700 para-restricted
```

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile local-ai up -d --build
```

Add yourself as the owner, load the company structure (`seed.json` generated by the experts repo, or start from [`deploy/seed.example.json`](deploy/seed.example.json)), and issue a key:

```bash
alias ob='docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec opsbrain deno task admin'
```

```bash
ob principal add erich --name "Erich Dautel" --kind human --role owner --can-approve
```

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp ./seed.json opsbrain:/tmp/seed.json && ob seed /tmp/seed.json
```

```bash
ob key issue erich --label laptop
```

Put OpsBrain behind TLS on a VPN or tunnel, then [connect your AI clients](docs/opsbrain/02-connect-clients.md). For Claude Code:

```bash
claude mcp add --transport http --scope user opsbrain https://opsbrain.example.internal/mcp --header "x-opsbrain-key: $OPSBRAIN_KEY"
```

Ask: "Call whoami on OpsBrain."

Open the web UI at `https://opsbrain.example.internal/crm` and sign in with your key (people only). See [CRM](docs/opsbrain/07-crm.md) for single sign-on and your own pipeline stages.

## Using OpsBrain with the experts repo

The [experts](https://github.com/gen-skeptic/experts) repo (the Dautel company handbook and its 48 harness-neutral agents) uses OpsBrain as its memory and system of record:

- `opsbrain/seed.json` in experts defines the areas, the 45 work processes, all 48 agents and the session service principal. Load it with `ob seed`.
- Agents write task cards, QA records, decisions, kaizen cards and hand-offs through the OpsBrain tools, following [Agent conventions](docs/opsbrain/06-agent-conventions.md).
- Decisions with financial or ethical considerations, final deployments to customers and financial transactions wait in OpsBrain for the owner's approval (in the web UI's approval queue).
- Sales runs in the CRM: the seed sets DIO's pipeline stages (P02 lead to proposal), prospects that need the employer-boundary screen are flagged, and a won deal becomes the engagement project.

## Repository layout

```text
server/            MCP server: auth, permissions, records, CRM, tools, HTTP app
server/ui/         web UI for people: sessions, pages, Dautel Design System assets
db/migrations/     SQL migrations (applied once each by db/migrate.ts)
admin/             opsbrain-admin CLI: principals, keys, delegations, areas, projects, seed, reembed
para/              PARA markdown exporter (records and CRM pages) and its four-times-a-day scheduler
deploy/            Dockerfile, docker-compose.yml, .env.example, seed.example.json, k8s/
tests/             unit tests and end-to-end tests against a real Postgres
docs/opsbrain/     OpsBrain documentation
```

The remaining folders (`extensions/`, `recipes/`, `schemas/`, `dashboards/`, `integrations/`, `skills/`, `primitives/`, `resources/`, and `docs/01-*` to `docs/05-*`) are the upstream Open Brain community library, kept for reference. They target the original single-user Supabase setup and are not part of OpsBrain. Some recipes work against OpsBrain's `thoughts` table, but review each one against the [privacy rules](docs/opsbrain/05-security-and-privacy.md) before using it, and do not deploy anything that sends company records to a third-party service.

## Development

Requires [Deno](https://deno.com) 2.5 or later.

```bash
deno task check
```

Unit tests only:

```bash
deno task test
```

Unit tests plus end-to-end tests (the test creates and drops a scratch database on a Postgres server with pgvector):

```bash
OPSBRAIN_TEST_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres deno task test
```

| Task | What it does |
| --- | --- |
| `deno task start` | Apply migrations, then serve |
| `deno task serve` | Serve only |
| `deno task migrate` | Apply migrations |
| `deno task admin <command>` | Administration CLI (run without a command for help) |
| `deno task para:export` | One PARA export now |
| `deno task para:schedule` | Export on the PARA schedule (default 00:00, 06:00, 12:00, 18:00) |

CI (`.github/workflows/opsbrain-ci.yml`) runs the type check, the unit tests and the end-to-end tests against Postgres with pgvector on every push and pull request.

## Ground rules

- **Private servers only.** No third-party databases or hosted memory services. Embeddings run locally by default.
- **Clients never see OpsBrain.** No client access, no client-facing exports.
- **No client deliverables or client confidential data.** Record *about* client work; keep the work itself in the client's systems and our delivery repositories.
- **No secrets in this repo.** Configuration comes from environment variables; `deploy/.env` and the PARA output folders are gitignored.
- **Additive schema changes only.** Never alter or drop Open Brain's original `thoughts` columns. Add columns and tables in new migrations.

## License and credits

OpsBrain is derived from [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), copyright 2026 Nate B. Jones, and is distributed under the same [Functional Source License 1.1, MIT Future License](LICENSE.md). Internal use and use while providing professional services are permitted. Offering OpsBrain, or something substantially similar, to others as a commercial product or service is not permitted until each version converts to MIT two years after its release. See [Security and privacy: License](docs/opsbrain/05-security-and-privacy.md#license).
