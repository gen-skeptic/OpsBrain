# 7. CRM

OpsBrain includes a CRM: companies, contacts, a deal pipeline and an activity log. It lives in the same database as every other company record, so a proposal, contract or invoice record, a task card or a meeting note can point at the company and deal it is about, and the same rules apply: every change is attributed, nothing is deleted, and decisions that need a person with approval rights are enforced by the database.

People use it in the browser at `<OPSBRAIN_PUBLIC_URL>/crm`. Agents use the `crm_*` MCP tools. Both see the same data.

## What it holds

| Entity | What it is | Matched by |
| --- | --- | --- |
| **Company** | An organization: prospect, lead, opportunity, client, former client, partner, vendor, or disqualified (its lifecycle) | ID, then web domain, then exact name |
| **Contact** | A business contact at a company: name, title, work email and phone, marketing consent, do-not-contact | ID, then email |
| **Deal** | An opportunity moving through the pipeline: stage, one-time value, monthly recurring value, probability, expected close, next step | ID, or exact name |
| **Activity** | A call, email, meeting, message or note, as a summary. Stored as an OpsBrain record of type `activity`, linked to the company, contact and deal | Record ID |

Matching means a repeated "create" updates the existing entry instead of making a duplicate (for example, two agents both adding `acme.com`).

Any record can link to the CRM with `company`, `contact` and `deal` on `create_record` and `update_record`. Proposal, contract and invoice records linked to a deal appear on the deal's page. A deal or contact implies its company.

## Rules OpsBrain enforces

| Rule | Enforced by |
| --- | --- |
| **Screens.** Anyone can flag a company for a screen (for DIO: the employer-boundary screen for field-services, tree-care or utility-adjacent prospects). While a screen is pending or declined, its deals cannot move into stages marked `gate_screen` (by default Meeting and later). Only an active person with approval rights can clear or decline a screen; declining also marks the company disqualified. | Database trigger |
| **Won deals.** Marking a deal won is a financial decision: only an active person with approval rights can do it, with their own key (never acting as an agent). Agents prepare the proposal and contract records for approval instead. | Database trigger, and the server |
| **Lost deals** need a lost reason, which feeds the win/loss review. | Server |
| **Lifecycle** follows the deals: a company with an open deal becomes an opportunity, and a won deal makes it a client. | Server |
| **Ownership.** Anyone except auditors can add and update CRM entries. Only the current owner, an admin or the owner role can reassign ownership. | Server |
| **History.** Every change, stage move and screen decision is kept in `crm_events` with who made it and with which key. | Server |
| **Concurrent edits.** Forms and tools send the version they read; a stale save fails with a version conflict instead of overwriting. | Server |

## The pipeline

Default stages: Lead (10%), Qualified (25%), Meeting (40%), Proposal (60%), Negotiation (75%), Won, Lost. The weighted forecast multiplies each open deal's value by its probability (the stage's, unless the deal overrides it).

Replace the stages with your own sales process in the seed file. Stages are listed in order; exactly one must be `is_won` and one `is_lost`. Stages you leave out are retired, not deleted: deals already in them stay visible until they move.

```json
{
  "pipeline_stages": [
    { "slug": "prospect", "name": "Prospect", "probability": 5 },
    { "slug": "fit_call", "name": "Fit call", "probability": 15 },
    { "slug": "qualified", "name": "Qualified", "probability": 30 },
    { "slug": "scoping", "name": "Scoping and estimate", "probability": 45, "gate_screen": true },
    { "slug": "proposal", "name": "Proposal sent", "probability": 60, "gate_screen": true },
    { "slug": "won", "name": "Won", "probability": 100, "is_won": true, "gate_screen": true },
    { "slug": "lost", "name": "Lost", "is_lost": true }
  ]
}
```

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec opsbrain deno task admin seed /tmp/seed.json
```

"Needs attention" on the pipeline shows open deals with no activity for 14 days, overdue next steps, and companies waiting for a screen.

## The web UI

| Page | What you can do |
| --- | --- |
| **Pipeline** (`/crm`) | Board of open deals by stage with value, weighted forecast and monthly recurring in play; stale deals, overdue next steps and pending screens; deals closed in the last 30 days. Filter by owner or service line. |
| **Companies** | Search and filter by lifecycle; company pages with details, deals, contacts, engagements, the activity timeline, history, and forms to edit, flag for a screen, or (approvers) clear or decline a screen. |
| **Contacts** | Search; contact pages with consent and do-not-contact, deals, activity and history. |
| **Deals** | Move stages, edit details, log activities with a next step, start the engagement project once won. Approvers see the Won stage; others see it disabled. |
| **Approvals** | Every record waiting for approval that you can read, with Approve, Request changes and Reject for people with approval rights. |
| **Records** | Read any record you can see (from a timeline or the approval queue). |

The UI uses the Dautel Design System (Dautel theme by default; `OPSBRAIN_UI_THEME` can choose `mocha`, `macchiato`, `frappe` or `latte`). It works without JavaScript and on a phone.

### Sign in

Only people can sign in; agents and services cannot. Two ways, set with `OPSBRAIN_UI_AUTH`:

- **`key`** (default): paste your own OpsBrain key once. OpsBrain checks it, then gives the browser a session cookie (HttpOnly, SameSite=Strict, Secure on HTTPS, `OPSBRAIN_UI_SESSION_HOURS`, default 12). The key itself is never stored in the browser.
- **`header`** or **`both`**: single sign-on through a reverse proxy you control (Authentik proxy outpost, oauth2-proxy, Traefik or Caddy forward auth). The proxy signs the person in and forwards their OpsBrain handle or email in `OPSBRAIN_UI_USER_HEADER` (default `X-authentik-username`). It must also send `X-OpsBrain-Proxy-Secret` with the value of `OPSBRAIN_UI_PROXY_SECRET` (at least 16 characters), so a request that bypasses the proxy can't claim to be someone. Without the secret, header sign-in stays off.

Example for Caddy in front of OpsBrain behind Authentik forward auth (adapt names to your setup):

```text
opsbrain.example.internal {
  forward_auth authentik-server:9000 {
    uri /outpost.goauthentik.io/auth/caddy
    copy_headers X-Authentik-Username
  }
  reverse_proxy 127.0.0.1:8787 {
    header_up X-OpsBrain-Proxy-Secret {env.OPSBRAIN_UI_PROXY_SECRET}
  }
}
```

Make sure the proxy removes any `X-authentik-username` (or whichever header you use) that the browser itself sends, and keep `/mcp` reachable for agents with their keys: if your proxy applies SSO to every path, exempt `/mcp` and `/healthz`.

## In the PARA mirror

The four-times-a-day export writes the CRM to `2-Areas/CRM/` (rename with `PARA_CRM_FOLDER`):

```text
2-Areas/CRM/
├── Pipeline.md                 open deals by stage, totals, recently closed
├── Contacts.md                 everyone, with company, title and consent
├── Companies/Acme Dental (1efc5f9e).md
├── Deals/Acme intake automation (306a83dc).md
├── Activities/...              activity records not tied to a project
└── Proposals/...               other CRM-linked records not tied to a project
4-Archive/CRM/
├── Companies/                  disqualified and archived companies
└── Deals/                      deals closed more than PARA_ARCHIVE_AFTER_DAYS ago, and archived deals
```

Contact emails and phone numbers are left out of the mirror ("email on file") unless `PARA_CRM_CONTACT_DETAILS=true`: the files are easier to copy around than the database.

## Tools for agents

| Tool | What it does |
| --- | --- |
| `crm_upsert_company` | Create or update a company; `flag_for_screen` with a `screen_note` asks for a screen |
| `crm_screen_company` | Clear or decline a screen (people with approval rights only) |
| `crm_upsert_contact` | Create or update a contact, including consent and do-not-contact |
| `crm_upsert_deal` | Create or update a deal: stage, values, expected close, next step, lost reason |
| `crm_start_engagement` | Create the client engagement project for a deal and link them |
| `crm_log_activity` | Log a call, email, meeting, message or note as a summary; can set the deal's next step |
| `crm_get` | A company, contact or deal with everything linked to it and its history |
| `crm_search`, `crm_list` | Find and filter companies, contacts and deals |
| `crm_pipeline` | The board as data: stages, totals, weighted forecast, stale deals, overdue next steps, pending screens |

## Privacy

- **Business contacts only:** name, role, work email and phone, and how they want to be contacted. Job candidates go in restricted `hiring` records, never in the CRM.
- **Summaries, not transcripts:** activities record who, what was discussed, decisions and next steps. Never paste full email bodies, attachments or anything from the client's own systems.
- **Consent:** record marketing consent with its source. Never send marketing to anyone not opted in, or to anyone marked do-not-contact.
- **Deletion requests:** archive the contact, then have an owner delete it in SQL (a `DELETE` naming that contact's ID) and record the request and deletion as a `decision`. Activity records about them should be edited or archived the same way.
- The CRM is company-visible: every active person and agent can read it. Keep sensitive notes about people out of it.
