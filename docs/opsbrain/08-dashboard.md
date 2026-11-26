# 8. Dashboard

OpsBrain includes the Open Brain dashboard, the web app OB1 built for its thoughts (by [Alan Shurafa](https://github.com/alanshurafa), from OB1's `dashboards/open-brain-dashboard-next`). It is the same app, restyled in the Dautel Design System and connected to OpsBrain, in [`dashboard/`](../../dashboard/). People use it to see and work with what the company remembers: every note, task card, decision and record they are allowed to read.

The CRM and the approval queue stay in OpsBrain's own web UI at `/crm` and `/approvals` (see [CRM](07-crm.md)). The dashboard is for the memory itself.

## What it does

| Page | What you do there |
| --- | --- |
| **Dashboard** | Totals by type, top topics, the workflow summary, **Add to Brain** and the latest records |
| **Thoughts** | Browse every record you can read, filter by type, source and importance, sort and page |
| **Workflow** | A board of tasks and ideas: New, Planning, Active, Review, Done. Drag a card to move it |
| **Search** | Search by meaning (semantic) or by words (full text) |
| **Audit** | Low-quality records (very short, untitled, not searchable by meaning) to fix or remove |
| **Duplicates** | Near-identical records side by side; keep one, archive the other, or keep both |
| **Add** | Paste a thought, notes or a transcript; longer text is split into several thoughts, with a preview first |
| **Thought** | One record: edit, delete, related records (connections) and reflections |
| **Agent Memory** | OB1's Agent Memory review pages. OpsBrain does not run the Agent Memory API, so these pages say so; agents' work is in records and approvals |

## How it connects

The dashboard is a Next.js server. Its server (never the browser) calls OpsBrain's **Open Brain REST API** at `<OPSBRAIN_PUBLIC_URL>/open-brain-rest`, which speaks the same contract as OB1's `integrations/open-brain-rest`. The API is a view of OpsBrain's records, not a second store ([`server/rest.ts`](../../server/rest.ts)):

- **People sign in with their own OpsBrain key** (`obk_...`). The dashboard keeps it in an encrypted, HTTP-only session cookie and sends it to OpsBrain on each request. Agent and service keys are refused; agents use MCP.
- **The same permissions as everywhere else.** Every read goes through `ops_can_read`, so restricted records stay private to the people who may read them, and auditors can read but not change anything.
- **Every change is attributed and logged.** Captures, edits, moves on the board and reflections go through the same code as the MCP tools: they record who made the change and with which key, bump the version and add an entry to the record's history.
- **Nothing is deleted.** Delete and "keep one" on the Duplicates page archive the record; its history stays, and it can be restored (move it back on the board with **Show archived**, or with `update_record`).
- **Embeddings stay local.** Captures are embedded by OpsBrain's own embedding service, exactly like records created through MCP.

### How Open Brain fields map onto OpsBrain records

| Open Brain | OpsBrain |
| --- | --- |
| Thought | Any record you can read. A capture from the dashboard is a `note` |
| `type` | A note keeps its type in `fields.thought_type` (set on capture: given, or guessed from words like "TODO" and "decided"). Other records map by record type: task card → `task`, kaizen card → `idea`, meeting note → `meeting`, retrospective → `lesson`, decision → `decision`, research, reference, playbook, SOP, template and policy → `reference`; anything else shows its own record type |
| `status` on the board | Notes keep the board's statuses. Task cards keep OpsBrain's statuses underneath: New = `ready`, Planning = `planning` or `blocked`, Active = `in_progress` or `changes_requested`, Review = `ready_for_qa`, Done = `done`. Archived (and `cancelled`) shows as Archived |
| `importance` (0-100) | `fields.importance`, and the record's priority: 60 and up is high, 30 to 59 normal, under 30 low |
| `quality_score` | `fields.quality_score` when set; otherwise a score from the text's length, title, tags and whether it has an embedding |
| `sensitivity_tier: restricted` | `visibility: restricted` (only the owner, the assignee, the creator, named people and admins can read it) |
| `source_type` | Where it came from: `dashboard`, `dashboard_ingest`, `opsbrain` (a person through MCP or the UI), `agent`, or `open_brain` (imported thoughts) |
| Topics, people, action items | Tags and the metadata OpsBrain extracts when `METADATA_EXTRACTION` is on |
| Reflections | `ops_reflections`, linked to the record, with a comment in its history |
| Ingestion jobs | `ops_ingest_jobs`, private to the person who ran them; each saved thought is a normal attributed note |

## Set it up

1. Make sure OpsBrain's REST API is on (it is by default; `OPSBRAIN_REST_ENABLED=true`).
2. Set the dashboard's session secret in `deploy/.env`:

   ```bash
   openssl rand -hex 32
   ```

   Put the result in `DASHBOARD_SESSION_SECRET`.
3. Start it with the `dashboard` profile:

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile dashboard up -d --build
   ```

4. Publish `http://127.0.0.1:3000` (or the `dashboard` container on port 3000) through your reverse proxy with TLS, as its own hostname, for example `brain.example.com`. Keep `DASHBOARD_COOKIE_SECURE=true` behind HTTPS.
5. Sign in with your own OpsBrain key. Each person uses their own key, so their changes carry their name.

Optional settings:

| Setting | What it does |
| --- | --- |
| `DASHBOARD_PORT` | Host port on 127.0.0.1 (default 3000) |
| `DASHBOARD_RESTRICTED_PASSPHRASE_HASH` | SHA-256 of a passphrase that shows restricted records you can already read (they are hidden by default) |
| `OPSBRAIN_UI_THEME` | The Dautel theme: `dautel` (default), `mocha`, `macchiato`, `frappe` or `latte`. Fixed when the image is built |

The dashboard collects no telemetry (`NEXT_TELEMETRY_DISABLED=1`) and loads no fonts or scripts from other sites.

## Design

The pages, components and behavior are OB1's. What changed is the look: the dashboard's color names map to Dautel role tokens ([`dashboard/app/globals.css`](../../dashboard/app/globals.css), with the tokens copied from the design system in `dashboard/app/dautel-tokens.css`), the fonts are Manrope and JetBrains Mono served locally, corners are small and square, the page ground is ink with the 80px topology grid, and the logo is the Dautel mark. Change the design system upstream first, then copy the tokens.

## The REST API

All routes take the caller's key in `x-brain-key` and return JSON.

| Route | What it does |
| --- | --- |
| `GET /open-brain-rest/health` | Checks the key |
| `GET /open-brain-rest/stats?days=` | Totals, counts by type, top topics |
| `GET /open-brain-rest/thoughts` | Browse: `page`, `per_page`, `type`, `source_type`, `status` (comma-separated), `importance_min`, `quality_score_max`, `sort`, `order`, `exclude_restricted` |
| `GET /open-brain-rest/thought/:id` | One record |
| `PUT /open-brain-rest/thought/:id` | Edit `content`, `type` (notes only), `importance`, `quality_score`, `status`, `sensitivity_tier` |
| `DELETE /open-brain-rest/thought/:id` | Archive |
| `POST /open-brain-rest/capture` | Save a note: `content`, optional `type`, `importance`, `status`, `sensitivity_tier`, `source_type` |
| `POST /open-brain-rest/search` | `query`, `mode` (`semantic` or `text`), `limit`, `page`, `threshold`; a semantic search that finds nothing falls back to words |
| `GET /open-brain-rest/duplicates?threshold=` | Near-identical pairs among the latest records |
| `GET /open-brain-rest/thought/:id/connections` | Related records by meaning, with shared topics and people |
| `GET`, `POST /open-brain-rest/thought/:id/reflection` | Reflections on a record |
| `POST /open-brain-rest/ingest` | Split text into thoughts; `dry_run: true` previews without saving |
| `GET /open-brain-rest/ingestion-jobs`, `/ingestion-jobs/:id`, `POST /ingestion-jobs/:id/execute` | Your ingest jobs, a job's items, and saving a previewed job |
