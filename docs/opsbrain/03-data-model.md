# 3. Data model

OpsBrain keeps Open Brain's `thoughts` table and adds company columns to it (it never alters or drops the original columns), plus tables for the people and agents who use it.

```text
ops_principals ──< ops_principal_keys            who is calling (hashed keys)
      │      └──< ops_delegations                 which agents a key may act as
      │
      ├── owner / assignee / created_by / updated_by / authenticated_as / on_behalf_of / approved_by
      ▼
  thoughts (records) ──< ops_record_events        append-only history
      │   │        └──< ops_record_links          reviews, blocks, supersedes, ...
      │   ├── record_type ─> ops_record_types     task_card, qa_record, decision, ...
      │   ├── project_id  ─> ops_projects         PARA Projects (client engagements, internal projects)
      │   ├── area_slug   ─> ops_areas            PARA Areas (ongoing responsibilities)
      │   └── process_id  ─> ops_processes        work processes (P01, P02, ...), each in an area
      ▼
  ops_records (view)  records joined with handles and names; what tools and the exporter read
```

## Principals: people, agents and services

| Column | Meaning |
| --- | --- |
| `handle` | Unique lowercase name used everywhere (`alex`, `quality-reviewer`). |
| `display_name`, `job_title`, `email` | Who this is. Email is optional; leave it empty for agents. |
| `kind` | `human`, `agent` (an AI role) or `service` (a key holder such as a Claude Code session or an integration). |
| `role` | `owner`, `admin`, `member`, `agent`, `auditor` (see [Setup, Step 5](01-setup.md#step-5-add-the-owner)). |
| `can_approve` | May approve records with financial or ethical considerations. Only humans; enforced by a database constraint. |
| `responsible_human_id` | The person accountable for an agent or service. Recorded as `on_behalf_of` on everything it writes. |
| `active` | Disabled principals cannot authenticate. Their records stay. |

**Keys** (`ops_principal_keys`) belong to one principal, are stored as SHA-256 hashes, and can expire or be revoked. **Delegations** (`ops_delegations`) let one principal act as another, normally a session key acting as agents. Owners and admins may act as any agent.

## Attribution on every record

| Column | Set by | Meaning |
| --- | --- | --- |
| `created_by` | OpsBrain | The principal that created the record (the agent, when `acting_as` is used). |
| `authenticated_as` | OpsBrain | The principal whose key made the call. |
| `on_behalf_of` | OpsBrain | The human accountable: the caller if human, otherwise the agent's or service's responsible person. |
| `updated_by` | OpsBrain | Last principal to change the record. |
| `owner` | You (defaults to creator) | Accountable for the record. |
| `assignee` | You | Doing the work now. Handing off work means changing the assignee. |
| `approved_by`, `approved_at` | OpsBrain | Who decided an approval, and when. |

Every change also writes an event to `ops_record_events` (`create`, `update`, `comment`, `approve`, `reject`, `request_changes`, `archive`, `unarchive`, `link`) with the actor, the key holder, the changed fields and an optional comment.

## Records

| Column | Meaning |
| --- | --- |
| `record_type` | One of the types below. |
| `title`, `content` | Short title and the body (markdown). Embedded for semantic search. |
| `status` | Free text, conventions per type (for example `ready`, `in_progress`, `ready_for_qa`, `changes_requested`, `done`). |
| `external_ref` | Your stable ID, unique across records (for example a task card ID such as `ACME-01-P09-12-sprint-3-tests`). `get_record` accepts it in place of the UUID. |
| `project_id`, `area_slug`, `process_id`, `process_step` | Where the record belongs. A record in a project inherits the project's area. |
| `priority`, `due_on`, `tags` | Planning fields. |
| `fields` | JSON for type-specific data (QA findings, decision options, invoice amount and due date, lead source...). |
| `visibility`, `allowed_principals` | `company` (every active principal can read) or `restricted` (owners and admins, the record's owner, assignee and creator, and anyone listed in `allowed_principals`). |
| `financial_or_ethical`, `requires_approval`, `approval_status` | Decision rights (below). |
| `version` | Increments on every change. Pass `expected_version` to `update_record` to detect conflicting edits. |
| `para_override`, `resource_topic` | Control where the PARA mirror files the record. |
| `archived_at` | Archived records drop out of default lists and move to `4-Archive`. |

## Record types

| Type | Default PARA place | Finished when status is |
| --- | --- | --- |
| `task_card` | Project | `done`, `cancelled` |
| `qa_record` | Project | `pass`, `pass_with_notes`, `fail` |
| `incident`, `change_record`, `support_request`, `retrospective` | Project | type-specific |
| `decision`, `approval`, `kaizen_card`, `meeting_note`, `risk` | Area | type-specific |
| `lead`, `proposal`, `invoice`, `contract`, `hiring`, `feedback`, `report`, `plan`, `note` | Area | type-specific |
| `playbook`, `sop`, `template`, `research`, `reference`, `policy` | Resource | `superseded` |

The full list with finished statuses is in `ops_record_types` (`list_directory` shows it). Add types with an `INSERT` in a new migration.

Records of type `proposal`, `invoice` and `contract` are *records about* the document: amounts, dates, status, approvals, where the document lives. The documents themselves stay in your document store.

## Decision rights, enforced by the database

These rules hold no matter which client or agent writes the record:

1. A record marked `financial_or_ethical` always requires approval, and starts as `pending`.
2. Only an active human with `can_approve` can set `approved` or `rejected`. Anyone else, including direct SQL, gets `insufficient_privilege`.
3. Changing the title, content or `fields` of an approved record sends it back to `pending`. Editing a record after the approver requested changes resubmits it (`pending`). Status-only changes keep the approval.
4. Only a person with approval rights can clear the `financial_or_ethical` or `requires_approval` flags.
5. Approvals go through `decide_approval`, with the person's own key and without `acting_as`.

A typical policy built on these rules: final deployments to customers, financial transactions and any decision with financial or ethical considerations need the owner's approval; everything else is decided by the accountable owner without escalation.

## CRM

The CRM adds `crm_companies`, `crm_contacts`, `crm_pipeline_stages`, `crm_deals` and their history in `crm_events`, with the same attribution columns as records. Activities are records of type `activity`. Records link to the CRM through `crm_company_id`, `crm_contact_id` and `crm_deal_id`; projects through `crm_company_id`. Two more database rules: only a person with approval rights can clear or decline a company's screen, and only a person with approval rights can mark a deal won. See [CRM](07-crm.md).

The web UI stores sessions in `ops_ui_sessions` (hashed session IDs, expiry, CSRF token).

## What OpsBrain is the system of record for

Everything about how the company runs: task cards, QA records, decisions and approvals, process improvement (kaizen), meeting notes, risks, incidents, changes, support requests, the CRM (companies, contacts, deals, activities), proposal, invoice and contract records, hiring records, feedback, plans, reports, retrospectives, playbooks, SOPs, templates, research and policies.

**Not stored in OpsBrain:** client deliverables (code, documents, designs, data you produce for a client) and client confidential data or credentials. Those live in the client's own systems or your delivery repositories and document store. OpsBrain records point to them by reference.
