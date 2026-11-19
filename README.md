<div align="center">

<img src="docs/assets/opsbrain/banner.png" alt="OpsBrain by Dautel Intelligent Operations: one system of record for people and agents" width="100%">

<br>

[![Private and self-hosted](https://img.shields.io/badge/%3E__-private_and_self--hosted-8ee5bd?style=flat-square&labelColor=070b11)](#_-security-and-privacy)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-8bc4ff?style=flat-square&labelColor=070b11)](docs/opsbrain/02-connect-clients.md)
[![Postgres](https://img.shields.io/badge/Postgres-16_%2B_pgvector-8bc4ff?style=flat-square&labelColor=070b11)](docs/opsbrain/03-data-model.md)
[![Deno](https://img.shields.io/badge/runtime-Deno_2.5-8bc4ff?style=flat-square&labelColor=070b11)](deno.json)
[![Design system](https://img.shields.io/badge/web_UI-Dautel_Design_System-c7a4ff?style=flat-square&labelColor=070b11)](#_-the-web-ui)
[![License](https://img.shields.io/badge/license-FSL--1.1--MIT-c7a4ff?style=flat-square&labelColor=070b11)](LICENSE.md)
[![CI](https://img.shields.io/github/actions/workflow/status/gen-skeptic/OpsBrain/opsbrain-ci.yml?branch=main&style=flat-square&labelColor=070b11&label=CI)](.github/workflows/opsbrain-ci.yml)

**[Quick start](#_-quick-start)** · **[Install](#_-install-on-your-server)** · **[Set up](#_-set-up-your-company)** · **[Connect](#_-connect-your-ai-tools)** · **[Daily use](#_-use-it-every-day)** · **[Web UI](#_-the-web-ui)** · **[PARA](#_-the-para-method)** · **[Extensions and recipes](#_-extensions-recipes-and-skills)** · **[Docs](#_-documentation)**

</div>

---

## >_ What OpsBrain is

**OpsBrain is the private system of record for a company run by people and AI agents.** Every person, agent and integration has its own identity and key. Everything they record, from task cards, QA results and decisions to meetings, risks, the sales pipeline and playbooks, lands in one Postgres database on your own server, with who did it, on whose behalf, and every change since.

Agents reach it through MCP. People use a private web UI for the CRM and the approval queue. Four times a day, a copy is written to plain markdown folders organized with the PARA method, so anyone can read it without an AI tool.

It is the memory and system of record for **Dautel Intelligent Operations**. It holds everything about how the company runs except client deliverables, and clients never see it.

<table>
<tr>
<td width="25%" align="center"><b>1</b><br>database for people and agents</td>
<td width="25%" align="center"><b>27</b><br>record types, plus a CRM</td>
<td width="25%" align="center"><b>4</b><br>PARA exports a day</td>
<td width="25%" align="center"><b>0</b><br>records sent off your servers by default</td>
</tr>
</table>

| You get | What it does |
| --- | --- |
| **Identities for everyone** | People, AI agents and services are principals with roles and their own revocable keys. One session key can act as many agents, and each record shows both the agent and the key. |
| **Records with attribution** | Task cards, QA records, decisions, kaizen cards, meeting notes, risks, incidents, proposals, invoices, contracts, playbooks, SOPs and more, each with owner, assignee, creator, status, project, area, process step and full history. |
| **Approvals the database enforces** | Anything financial or ethical, and final deployments to customers, waits as `pending` until a person with approval rights decides. Agents can't approve, even with direct database access. |
| **A built-in CRM** | Companies, contacts, a deal pipeline with a weighted forecast, and every sales conversation, linked to proposals, contracts, invoices and engagements. |
| **A web UI for people** | Pipeline board, companies, contacts, deals, an approval queue and a record view, in the Dautel Design System. Sign in with your key or through SSO. |
| **A readable copy** | Markdown folders organized with PARA (Projects, Areas, Resources, Archive), rebuilt at 00:00, 06:00, 12:00 and 18:00. |
| **Privacy by default** | Self-hosted, local embeddings, restricted records for HR and legal, and no client data or deliverables. |

> OpsBrain is a fork of [Open Brain](https://github.com/NateBJones-Projects/OB1) by [Nate B. Jones](https://natesnewsletter.substack.com/), a single-user AI memory on Postgres, pgvector and MCP. It keeps Open Brain's `thoughts` table and tools, and turns them into a multi-user, multi-agent company database. Licensed under [FSL-1.1-MIT](LICENSE.md).

---

## >_ How it works

<img src="docs/assets/opsbrain/architecture.png" alt="Diagram: people, AI agents and services connect to the OpsBrain server (MCP for agents, web UI for people), which stores everything in Postgres with pgvector and uses a local embedding model; the PARA exporter reads the database four times a day and writes the markdown mirror." width="100%">

1. **Every call carries a key.** OpsBrain finds whose key it is, checks whether it may act as the agent named in `acting_as`, and checks the role and the record's visibility.
2. **Every write is attributed.** The record stores who created it, which key was used, and the person accountable, and each change adds an event to its history.
3. **The rules live in the database.** Visibility, approvals, company screens and won deals are enforced by Postgres functions and triggers, whatever client is writing.
4. **Search runs locally.** A local Ollama model embeds records for semantic search. Keyword search is the fallback.
5. **The mirror runs on a schedule.** The PARA exporter reads the database and writes markdown, keeping restricted records in a separate, owner-only folder.

---

## >_ Quick start

Try OpsBrain on your own computer in about ten minutes. You need [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

**1. Get the code and a settings file.**

```bash
git clone https://github.com/gen-skeptic/OpsBrain.git opsbrain && cd opsbrain
```

```bash
cp deploy/.env.example deploy/.env
```

**2. Edit `deploy/.env` for a local trial.** Set a database password, use a local address, and turn off embeddings for now (keyword search still works):

```text
POSTGRES_PASSWORD=any-long-random-value
OPSBRAIN_PUBLIC_URL=http://localhost:8787
EMBEDDING_PROVIDER=none
```

**3. Create the mirror folders and start.** The exporter runs as user 1993 in its container.

```bash
mkdir -p para-output para-restricted && sudo chown 1993:1993 para-output para-restricted
```

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

**4. Add yourself and get a key.** This alias saves typing for every admin command:

```bash
alias ob='docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec opsbrain deno task admin'
```

```bash
ob principal add you --name "Your Name" --kind human --role owner --can-approve
```

```bash
ob key issue you --label "first key"
```

Copy the `obk_...` key it prints. It is shown once.

**5. Open the web UI** at [http://localhost:8787/crm](http://localhost:8787/crm) and sign in with the key. Add a company, a contact and a deal.

**6. Connect Claude Code** and ask it to call `whoami`:

```bash
claude mcp add --transport http opsbrain http://localhost:8787/mcp --header "x-opsbrain-key: obk_your_key"
```

That's a working OpsBrain. For a real installation with local embeddings, TLS and backups, continue below.

---

## >_ Install on your server

**You need**

| | Minimum |
| --- | --- |
| Server | Linux VM or home-lab node you control: 4 GB RAM, or 8 GB with local embeddings |
| Software | Docker with the Compose plugin, or a Kubernetes cluster |
| Network | A VPN (WireGuard, Tailscale) or a reverse proxy or tunnel with TLS. Never publish port 8787 directly |
| Secrets | A password manager or secret store for the keys you issue |

**1. Configure.** Copy `deploy/.env.example` to `deploy/.env` and set at least:

| Setting | What to put |
| --- | --- |
| `POSTGRES_PASSWORD` | A long random value (`openssl rand -base64 32`) |
| `OPSBRAIN_PUBLIC_URL` | The address people and agents will use, for example `https://opsbrain.yourdomain.internal` |
| `TZ` | Your time zone; the four daily exports run at local time |
| `EMBEDDING_*` | Keep the defaults to use local Ollama with `nomic-embed-text` (dimension 768) |
| `PARA_RESTRICTED_DIR` | `/data/para-restricted` to export restricted records to their own owner-only folder, or empty to keep them out of the mirror |
| `OPSBRAIN_UI_AUTH` | `key` (sign in with your key) or `both` to add SSO; see [CRM: Sign in](docs/opsbrain/07-crm.md#sign-in) |

**2. Prepare the mirror folders.** Keep the restricted one owner-only:

```bash
mkdir -p para-output para-restricted && sudo chown 1993:1993 para-output para-restricted && sudo chmod 700 para-restricted
```

**3. Start with local embeddings.** The `local-ai` profile adds Ollama and downloads the model once:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile local-ai up -d --build
```

```bash
curl -s http://127.0.0.1:8787/healthz
```

You should see `{"ok":true}`.

**4. Publish it privately.** Put a reverse proxy with TLS in front of `127.0.0.1:8787`, reachable over your VPN. Claude Desktop and claude.ai connectors connect from Anthropic's cloud, so they need a public HTTPS tunnel and a dedicated key; Claude Code and Codex can stay on the VPN.

**5. Back up nightly** to encrypted storage you control, and test a restore every quarter:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db pg_dump -U opsbrain -Fc opsbrain > "opsbrain-$(date +%F).dump"
```

**Kubernetes:** `deploy/k8s/` has a Kustomize base (server with a migration init container, the PARA CronJob `0 0,6,12,18 * * *`, a PVC, and an optional CloudNativePG cluster with pgvector). See [Setup: Kubernetes](docs/opsbrain/01-setup.md#kubernetes).

**Upgrades:** take a backup, then `git pull` and run the same `docker compose ... up -d --build`. Migrations apply once each, on start.

---

## >_ Set up your company

**1. Add the owner.** `--can-approve` gives the right to approve financial and ethical decisions. Only people can hold it.

```bash
ob principal add erich --name "Erich Dautel" --kind human --role owner --can-approve --title "Owner"
```

| Role | Can |
| --- | --- |
| `owner`, `admin` | Everything, including restricted records and acting as any agent |
| `member`, `agent` | Read company records, create records, change records they own, are assigned or created |
| `auditor` | Read only |

**2. Load your structure from a seed file.** One idempotent file creates areas, processes, people, agents, delegations, projects and pipeline stages. Start from [`deploy/seed.example.json`](deploy/seed.example.json):

<details>
<summary><b>What a seed file looks like</b></summary>

```json
{
  "areas": [{ "slug": "service-delivery", "name": "Service delivery", "owner": "erich" }],
  "principals": [
    { "handle": "dio-quality-reviewer", "display_name": "Quality Reviewer", "kind": "agent", "role": "agent", "responsible": "erich" },
    { "handle": "dio-main-session", "display_name": "Main session", "kind": "service", "role": "agent", "responsible": "erich" }
  ],
  "processes": [{ "id": "P09", "name": "Custom software", "area": "service-delivery", "owner": "dio-quality-reviewer" }],
  "delegations": [{ "principal": "dio-main-session", "may_act_as": "all-agents" }],
  "pipeline_stages": [
    { "slug": "lead", "name": "Lead", "probability": 10 },
    { "slug": "proposal", "name": "Proposal", "probability": 60, "gate_screen": true },
    { "slug": "won", "name": "Won", "probability": 100, "is_won": true },
    { "slug": "lost", "name": "Lost", "is_lost": true }
  ]
}
```

</details>

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp ./seed.json opsbrain:/tmp/seed.json
```

```bash
ob seed /tmp/seed.json
```

Run it again whenever agents or processes change. DIO's own seed (7 areas, 45 processes, 48 agents, its sales stages) is generated by its private operating manual.

**3. Issue keys.** Choose per runtime:

| Model | When | How |
| --- | --- | --- |
| **One key per agent** | Agents run on their own (OpenClaw, Hermes on a server) | `ob key issue dio-quality-reviewer --label host-1` |
| **A delegated session key** | One AI session plays many roles (Claude Code orchestrating a team) | Create a service principal, `ob delegate dio-main-session --all-agents`, issue it a key; each call names the agent with `acting_as` |

Give session and connector keys an expiry (`--expires-days 180`), and revoke a lost one immediately with `ob key revoke <hash-prefix>`.

**4. Optional:** turn on single sign-on for the web UI and set your own pipeline stages; see the [CRM guide](docs/opsbrain/07-crm.md).

---

## >_ Connect your AI tools

OpsBrain speaks MCP over Streamable HTTP at `<OPSBRAIN_PUBLIC_URL>/mcp`. Send the key in the `x-opsbrain-key` header (or `Authorization: Bearer`). Keep keys in environment variables, never in committed files.

<details>
<summary><b>Claude Code</b></summary>

For every project:

```bash
claude mcp add --transport http --scope user opsbrain https://opsbrain.example.internal/mcp --header "x-opsbrain-key: $OPSBRAIN_KEY"
```

Or commit a `.mcp.json` that reads the key from your environment:

```json
{ "mcpServers": { "opsbrain": { "type": "http", "url": "${OPSBRAIN_URL}/mcp", "headers": { "x-opsbrain-key": "${OPSBRAIN_KEY}" } } } }
```

</details>

<details>
<summary><b>Codex</b></summary>

In `~/.codex/config.toml`, then export `OPSBRAIN_KEY` before starting Codex:

```toml
[mcp_servers.opsbrain]
url = "https://opsbrain.example.internal/mcp"
bearer_token_env_var = "OPSBRAIN_KEY"
```

</details>

<details>
<summary><b>OpenClaw, Hermes and other agent runtimes</b></summary>

Add a remote (Streamable HTTP) MCP server named `opsbrain` with the URL above and the header `x-opsbrain-key: <the agent's key>`.

</details>

<details>
<summary><b>Claude Desktop and claude.ai</b></summary>

Settings, Connectors, Add custom connector, with the URL `https://opsbrain.example.com/mcp?key=obk_...`. These connect from Anthropic's cloud, so OpsBrain must be reachable over public HTTPS. Use a dedicated key you can revoke on its own.

</details>

Check the connection by asking: **"Call whoami on OpsBrain."** With a delegated key, try **"Call whoami acting as dio-quality-reviewer."**

---

## >_ Use it every day

Most of the time you just ask your agent. These are the moves that matter:

| I want to | Ask your agent, or do this | Under the hood |
| --- | --- | --- |
| Hand work to someone | "Create a task card for the QA review of sprint 3 and assign it to dio-quality-reviewer." | `create_record` (task card), `update_record` to hand off |
| Record a decision | "Record the decision to use Postgres for the portal, with the options we considered." | `create_record` (decision) |
| Get something approved | "Record the discount as a decision that needs my approval." Then approve it on the web UI's **Approvals** page. | `financial_or_ethical: true` holds it as `pending` |
| Find what we decided | "Search OpsBrain for what we decided about client portals." | `search_records` (semantic, keyword fallback) |
| Log a sales call | "Log a call with Dana at Acme: she wants intake live before March." Or **Log activity** on the deal page. | `crm_log_activity` |
| See the pipeline | Open `/crm`, or ask "What deals are stale?" | `crm_pipeline` |
| Close a deal | Mark it **Won** on the deal page (approvers only), then **Create engagement project**. | `crm_upsert_deal`, `crm_start_engagement` |
| Suggest an improvement | "File a kaizen card: invoices wait two days for a second review." | `create_record` (kaizen card) |
| Read without AI | Open the `para-output` folder in any editor or Obsidian. | The PARA mirror |
| See who changed what | Every record and CRM entry has a history (in the UI, or "show the history of ...") | `record_history`, `crm_get` |

<details>
<summary><b>Admin cheat sheet</b> (run on the server, with the <code>ob</code> alias from the quick start)</summary>

| Command | Does |
| --- | --- |
| `ob principal add <handle> --name "..." --kind human\|agent\|service --role ...` | Add a person, agent or service (`--can-approve` for approvers, `--responsible <person>` for agents) |
| `ob principal list` · `disable <handle>` · `enable <handle>` | See and switch principals off or on (records stay) |
| `ob key issue <handle> [--label x] [--expires-days N]` | Issue a key, shown once |
| `ob key list <handle>` · `ob key revoke <hash-prefix>` | See and revoke keys |
| `ob delegate <handle> <agent>... \| --all-agents` · `ob undelegate <handle> <agent>` | Let a key act as agents |
| `ob area add <slug> --name "..."` · `ob project add <id> --name "..."` | Add an area or a project |
| `ob seed <file.json>` | Load or refresh a seed file |
| `ob reembed` | Fill in embeddings saved while the model was down |
| `docker compose ... exec para-export deno task para:export` | Export the PARA mirror now |

</details>

---

## >_ The web UI

People sign in at `<OPSBRAIN_PUBLIC_URL>/crm` with their own key or through single sign-on (Authentik, oauth2-proxy). Agents can't sign in. The UI follows the [Dautel Design System](server/ui/assets/DESIGN-SYSTEM.md) (Dautel theme by default, Catppuccin themes with `OPSBRAIN_UI_THEME`), works without JavaScript and on a phone. The screenshots below use made-up demo data.

<img src="docs/assets/opsbrain/ui-pipeline.png" alt="Pipeline board with open deals by stage, totals, weighted forecast and monthly recurring value" width="100%">

<table>
<tr>
<td width="50%"><img src="docs/assets/opsbrain/ui-company.png" alt="Company page with details, deals, contacts and the activity log form"></td>
<td width="50%"><img src="docs/assets/opsbrain/ui-deal.png" alt="Deal page with values, next step, stage controls and activity logging"></td>
</tr>
<tr>
<td align="center"><b>Company</b>: details, deals, contacts, activity and history</td>
<td align="center"><b>Deal</b>: stage, values, next step; Won is approver-only</td>
</tr>
</table>

<img src="docs/assets/opsbrain/ui-approvals.png" alt="Approval queue with a deployment, a discount decision and a proposal waiting, each with approve, request changes and reject" width="100%">

| Page | What you do there |
| --- | --- |
| **Pipeline** `/crm` | Deals by stage, open value, weighted forecast and monthly recurring in play; stale deals, overdue next steps and companies waiting for a screen |
| **Companies** and **Contacts** | Search, edit, see every deal, contact, activity and record linked to them, log calls and meetings |
| **Deals** | Move stages, set next steps, close as won or lost, start the engagement project |
| **Approvals** | Everything waiting for a decision; approvers approve, request changes or reject |
| **Records** | Read any record you are allowed to see, with links and history |

**The CRM's rules:** anyone can flag a company for a conflict-of-interest screen, and its deals then can't reach the screened stages until a person with approval rights clears it. Only a person with approval rights can mark a deal won, and a lost deal needs a reason. Contacts are business contacts only, with marketing consent recorded. More in the [CRM guide](docs/opsbrain/07-crm.md).

---

## >_ The PARA method

[PARA](https://fortelabs.com/blog/para/), from Tiago Forte, organizes information by **how actionable it is**, not by topic. Everything belongs to one of four places, and things move between them as their status changes:

<img src="docs/assets/opsbrain/para.png" alt="The four PARA folders: 1 Projects for short efforts with a goal and an end, 2 Areas for ongoing responsibilities, 3 Resources for reference you reuse, 4 Archive for inactive items, with done work moving to the archive" width="100%">

| | Holds | In OpsBrain |
| --- | --- | --- |
| **1 Projects** | Short efforts with a goal and an end | Each client engagement or internal project gets a folder, with its task cards, QA records, decisions, changes and incidents |
| **2 Areas** | Ongoing responsibilities with a standard to keep | One folder per area of the business (sales, delivery, finance...) plus `CRM/` with the pipeline, company and deal pages |
| **3 Resources** | Reference material you reuse | Playbooks, SOPs, templates, research and policies, grouped by topic |
| **4 Archive** | Anything inactive | Completed and cancelled projects, archived records, finished area work after 30 days, long-closed deals |

You never file anything by hand. Each record lands in the right place from its type, project, area and status, and when a project completes, the next export moves its whole folder to `4-Archive`:

```text
para-output/
├── README.md                              active projects, approvals waiting, recent changes
├── 1-Projects/ACME-01 - Patient intake/
│   ├── _index.md                          open items and every record
│   ├── Task cards/  QA records/  Decisions/
├── 2-Areas/
│   ├── Sales and clients/Decisions/
│   └── CRM/Pipeline.md  Companies/  Deals/  Activities/
├── 3-Resources/Onboarding/
└── 4-Archive/Projects/  Areas/  Resources/  CRM/
```

Each file has YAML front matter (type, status, owner, assignee, created by, on behalf of, approval, dates) that Obsidian and other tools can query, the body, structured fields, links and the last 15 history events. The exporter only rewrites files whose content changed, deletes only files it generated, and can commit each export to a private git repository. Restricted records go only to the owner-only folder, and contact emails and phone numbers stay out of the files. Details: [PARA mirror](docs/opsbrain/04-para-mirror.md).

---

## >_ Extensions, recipes and skills

OpsBrain ships with the **Open Brain community library**, unchanged: [6 extensions](extensions/), [51 recipes](recipes/), [19 skill packs](skills/), [17 integrations](integrations/), [16 schemas](schemas/), [4 dashboards](dashboards/) and [5 primitives](primitives/). They were written for a **single-user Open Brain on Supabase**, so check how each one connects before you use it with a company OpsBrain:

| If the item... | With OpsBrain |
| --- | --- |
| Is a prompt-only skill pack | **Works as is** in Claude Code, Codex or any client |
| Uses Open Brain's MCP tools (`capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`) | **Works**: point it at your OpsBrain `/mcp` with a key; captures become attributed `note` records |
| Writes straight to Supabase (REST, supabase-js, Edge Functions), as about 35 of the 51 recipes do | **Port it first**: replace the Supabase calls with OpsBrain MCP calls, so every write is attributed and checked |
| Calls hosted model APIs (OpenRouter, OpenAI), as about 35 recipes do | **Review it first**: prefer a local model, and never send client data or restricted records out |
| Imports personal data (ChatGPT, Gmail, Google, Instagram, X, Grok, Perplexity exports) | **Keep it out**: personal history belongs in a personal Open Brain, not the company's system of record |

### Extensions: the learning path

Open Brain's six extensions teach how to add a table and its tools, one build at a time. Most are personal-life tools; the patterns carry over.

| # | Extension | What you build | For a company OpsBrain |
| :-: | --- | --- | --- |
| 1 | [Household Knowledge Base](extensions/household-knowledge/) | Home facts your agent can recall | Personal; a good first example of a table plus MCP tools |
| 2 | [Home Maintenance Tracker](extensions/home-maintenance/) | Scheduling and history for upkeep | Personal; the pattern fits recurring operations checklists |
| 3 | [Family Calendar](extensions/family-calendar/) | Multi-person schedules | Personal |
| 4 | [Meal Planning](extensions/meal-planning/) | Recipes, plans, shared lists | Personal; shows row-level security for shared data |
| 5 | [Professional CRM](extensions/professional-crm/) | Contacts wired into your thoughts | **Replaced** by OpsBrain's built-in CRM |
| 6 | [Job Hunt Pipeline](extensions/job-hunt/) | Applications and interviews | Personal; for hiring, use restricted `hiring` records |

To bring an extension's idea into OpsBrain, turn its SQL into a numbered migration in `db/migrations/` and its tools into server tools, following [AGENTS.md](AGENTS.md). The [primitives](primitives/) (Edge Function deployment, remote MCP, row-level security) describe Supabase mechanics that OpsBrain replaces with its own server and roles.

### Recipes and skills worth a look

| Item | What it does | With OpsBrain |
| --- | --- | --- |
| [Meeting Synthesis](skills/meeting-synthesis/) | Turns meeting notes into decisions, actions, risks and follow-ups | Works; save the results as `meeting_note` and `decision` records |
| [Research Synthesis](skills/research-synthesis/), [Competitive Analysis](skills/competitive-analysis/) | Decision-grade briefs, competitor and pricing maps | Works; save as `research` records |
| [Deal Memo Drafting](skills/deal-memo-drafting/), [Financial Model Review](skills/financial-model-review/) | Structured memos and model reviews | Works; anything with money goes through approval |
| [Panning for Gold](recipes/panning-for-gold/) | Turns brain dumps and transcripts into evaluated ideas | Works through MCP; good ideas become kaizen cards |
| [Auto-Capture](recipes/auto-capture/) | Captures action items and a session summary when a session ends | Works through MCP |
| [Research-to-Decision Workflow](recipes/research-to-decision-workflow/) | Chains skills from research to a decision memo | Works; prompt composition |
| [Work Operating Model Activation](recipes/work-operating-model-activation/) | Interviews you about how work really runs and stores it | Partly MCP; port the Supabase parts |
| [Daily Digest](recipes/daily-digest/), [Weekly Digest](recipes/weekly-digest/) | Scheduled summaries of recent records | Port to read OpsBrain; use a local model |
| [Wiki Compiler](recipes/wiki-compiler/) | Compiled topic pages from records | Uses MCP; review its model calls |
| [Obsidian Vault Import](recipes/obsidian-vault-import/) | Imports an existing notes vault | Port; review notes for personal or client data first |
| [Local Ollama Embeddings](recipes/local-ollama-embeddings/), [Brain Backup](recipes/brain-backup/) | Local embeddings; table export | **Built in**: local embeddings are the default, and backups use `pg_dump` |
| [Kubernetes Deployment](integrations/kubernetes-deployment/), [Slack](integrations/slack-capture/) and [Telegram](integrations/telegram-capture/) capture | Self-hosting and quick-capture channels | OpsBrain has its own Kubernetes base; capture bots need porting to OpsBrain MCP |

Contribution rules for the library are in [CONTRIBUTING.md](CONTRIBUTING.md). OpsBrain's own code follows [AGENTS.md](AGENTS.md).

---

## >_ Security and privacy

| Rule | How OpsBrain keeps it |
| --- | --- |
| **Private servers only** | Self-hosted Postgres, server and embedding model; the database port is never published, and the server binds to localhost behind your TLS proxy |
| **Clients never see it** | No client logins or exports; status updates to clients are written from records and sent through normal channels |
| **No client deliverables or confidential data** | Records describe the work and point to where deliverables live |
| **Least privilege** | One key per person, agent or session; hashed, expiring, revocable; auditors are read-only |
| **Sensitive topics stay restricted** | `visibility: restricted` for HR, pay and legal, enforced on every read and kept out of the main mirror |
| **Decisions stay with people** | Approvals, screens and won deals are enforced by database triggers |
| **A safe web UI** | People only; hashed sessions in HttpOnly SameSite=Strict cookies, CSRF tokens, same-origin checks, a no-script CSP, escaped templates |
| **Everything is audited** | Every change records the actor, the key and the fields changed |

Read the full [security and privacy guide](docs/opsbrain/05-security-and-privacy.md), including backups, retention and the license.

---

## >_ Documentation

| Guide | Covers |
| --- | --- |
| [1. Setup](docs/opsbrain/01-setup.md) | Install, first owner, seed file, keys, publishing privately, web UI, backups, upgrades, Kubernetes, troubleshooting |
| [2. Connect clients](docs/opsbrain/02-connect-clients.md) | Claude Code, Codex, OpenClaw, Hermes, Claude Desktop, and every tool |
| [3. Data model](docs/opsbrain/03-data-model.md) | Principals, attribution, records and types, decision rights, the CRM tables |
| [4. PARA mirror](docs/opsbrain/04-para-mirror.md) | Schedule, folders, placement rules, file format, restricted records, git, Obsidian |
| [5. Security and privacy](docs/opsbrain/05-security-and-privacy.md) | Privacy rules, access control, network, keys, data protection, license |
| [6. Agent conventions](docs/opsbrain/06-agent-conventions.md) | How agents record task cards, QA, decisions, approvals and CRM work |
| [7. CRM](docs/opsbrain/07-crm.md) | Companies, contacts, deals, activities, pipeline stages, the web UI, single sign-on |

---

## >_ Development

Requires [Deno](https://deno.com) 2.5 or later. For the end-to-end tests, a Postgres server with pgvector where the tests may create and drop a scratch database.

```bash
deno task check
```

```bash
OPSBRAIN_TEST_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres deno task test
```

```text
server/            MCP server: auth, permissions, records, CRM, tools, HTTP app
server/ui/         web UI for people: sessions, pages, Dautel Design System assets
db/migrations/     SQL migrations, applied once each on start
admin/             the admin CLI (principals, keys, delegations, areas, projects, seed, reembed)
para/              PARA exporter (records and CRM pages) and its scheduler
deploy/            Dockerfile, docker-compose.yml, .env.example, seed.example.json, k8s/
tests/             unit tests and end-to-end tests against Postgres
tools/readme/      renders this README's images from the design system and demo data
docs/opsbrain/     the guides above
```

CI runs the type check, all tests against Postgres with pgvector, and a Compose file check on every push and pull request. Rules for changing the code, for people and AI agents alike, are in [AGENTS.md](AGENTS.md).

To refresh the README images, run `node tools/readme/render.js` for the banner and diagrams. The screenshots come from a scratch database filled by `tools/readme/demo-data.ts` and `tools/readme/screenshots.js`.

---

## >_ License and credits

OpsBrain is derived from [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), copyright 2026 Nate B. Jones, and is distributed under the same [Functional Source License 1.1, MIT Future License](LICENSE.md). Internal use and use while providing professional services are permitted. Offering OpsBrain, or something substantially similar, to others as a commercial product or service is not, until each version converts to MIT two years after its release. The community library keeps its contributors' credits in each folder.

<div align="center">

<br>

<img src="server/ui/assets/dautel-intelligent-operations-mark.svg" alt="Dautel Intelligent Operations" width="48">

**OpsBrain** · built by Dautel Intelligent Operations · [dautel.io](https://dautel.io)

</div>
