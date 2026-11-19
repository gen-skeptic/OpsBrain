# 6. Conventions for agents

These conventions make records from many people and agents consistent, so work can be handed off, reviewed and found later. Agent instructions (for example the experts repo's protocol) should follow them.

## Before you start

1. Call `whoami` once per session. Note the agents you may act as.
2. On every write, set `acting_as` to the agent role doing the work (if your key is shared by several agents).
3. Look before you create: `get_record` by `external_ref`, or `list_records` / `search_records`, so you update the existing record instead of creating a duplicate.

## Task cards (hand-offs)

- One `task_card` per unit of work handed from one role to another.
- `external_ref`: `<project or area>-<process>-<step>-<short-slug>`, for example `ACME-01-P09-12-sprint-3-tests`. Reuse it for every update.
- `owner`: the agent accountable for the step. `assignee`: who is doing it now. Hand off by changing `assignee` and `status` in one `update_record` call, with a `comment` saying what is ready and where.
- `status`: `ready` → `in_progress` → `ready_for_qa` → `changes_requested` (back to the producer) → `done`, or `blocked` / `cancelled`.
- `fields`: inputs, acceptance criteria, artifacts (as locations, not contents), and the next step.

## QA records

- One `qa_record` per review, linked to what it reviews: `link_records(from: qa, to: task, relation: "reviews")`.
- `status`: `pass`, `pass_with_notes` or `fail`. Put itemized findings in `fields.findings` (each with severity, location and the fix needed).
- On `fail`, set the task card to `changes_requested` and assign it back to the producer. Re-review creates a new QA record linked to the same task card, so the history shows every loop.

## Decisions and approvals

- Record every material decision as a `decision` with the options considered (`fields.options`), the choice and the reason.
- Set `financial_or_ethical: true` when the decision involves spending, pricing, discounts, refunds, payments, contracts, hiring and compensation, a final deployment to a customer, or any ethical consideration. OpsBrain then holds it as `pending` until a person with approval rights decides.
- Do not proceed with a pending item. Check it with `list_records(approval_status: "pending")` and continue only after `approved`.
- Agents never approve. Approval comes from the human, with their own key, through `decide_approval`.
- Decisions without financial or ethical considerations are made by the accountable owner and recorded as `status: decided`.

## Everything else

| Situation | Record type |
| --- | --- |
| An improvement idea or waste you noticed | `kaizen_card` |
| Something could go wrong | `risk` |
| Something went wrong | `incident`, then `retrospective` |
| A change to a production system | `change_record` (link the approval) |
| A client question or bug report | `support_request` |
| A sales conversation | CRM: `crm_log_activity` on the company, contact and deal (see below) |
| Proposal, contract or invoice status | `proposal`, `contract`, `invoice` (the document stays in the document store) |
| How we do something | `playbook`, `sop`, `template` (resources) |
| Research with sources | `research` |
| Meeting notes and actions | `meeting_note` |
| Anything else worth remembering | `note` |

## CRM

- **Before adding**, `crm_search` for the company or contact. `crm_upsert_*` matches by domain and email anyway, so repeating a call is safe.
- **One deal per opportunity**, owned by the agent or person who runs it. Keep `next_step` and `next_step_due` current; the pipeline flags deals with no activity for 14 days.
- **Log every meaningful touch** with `crm_log_activity`: a short summary of who, what was discussed, decisions and the next step. Never paste full emails.
- **Screens:** flag a company with `flag_for_screen` and a `screen_note` when it needs the owner's screen (a conflict-of-interest check; your operating manual says which prospects need one). Don't scope or propose until it is cleared.
- **Money:** proposals, contracts and invoices are records (`proposal`, `contract`, `invoice`) linked with `deal`, with `financial_or_ethical: true`, so they wait for approval. Only a person with approval rights marks a deal won; then `crm_start_engagement` creates the engagement project.
- **Lost deals** get a `lost_reason`.
- **Consent:** set `consent` with `consent_source` when someone opts in or out; never market to anyone not opted in or marked `do_not_contact`.

## Never store

- Client deliverables (code, documents, designs, data produced for a client).
- Client confidential data, credentials, secrets, API keys, or personal data from client systems.
- Your own secrets or keys.

Store a reference instead: "Delivered in the client repository `acme/portal`, tag v1.3.0".

## When OpsBrain is unavailable

Keep working. Write the record you would have created as a markdown block in your output, headed `OPSBRAIN PENDING`, with the tool name and arguments. Whoever next has OpsBrain access replays pending blocks in order and removes them.
