# 4. The PARA mirror (human-readable copy)

OpsBrain writes every company record to markdown files, organized with Tiago Forte's PARA method, four times a day. People can browse it in any editor, Obsidian, a file share or a private git repository without an AI client and without database access.

The database stays the source of truth. The mirror is regenerated on every export; edit records through OpsBrain, not in the files.

## Schedule

| Deployment | How | Default times |
| --- | --- | --- |
| Docker Compose | `para-export` container runs `deno task para:schedule` | `PARA_EXPORT_TIMES=00:00,06:00,12:00,18:00` in `TZ`, plus once on start |
| Kubernetes | `opsbrain-para-export` CronJob | `0 0,6,12,18 * * *` with `timeZone` |
| Anywhere else | cron or a systemd timer running `deno task para:export` | your choice |

Run one export now:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec para-export deno task para:export
```

## Folder structure

```text
para-output/
├── README.md                          dashboard: active projects, areas, approvals waiting, recent changes
├── 1-Projects/
│   └── ACME-01 - Acme customer portal/
│       ├── _index.md                  project summary, open items, links to every record
│       ├── Task cards/
│       │   └── 2026-11-01 Sprint 3 tests (0f3a2b1c).md
│       ├── QA records/
│       └── Decisions/
├── 2-Areas/
│   ├── Finance and administration/
│   │   ├── _index.md
│   │   ├── Invoices/
│   │   └── Kaizen cards/
│   └── General/                       records without an area
├── 3-Resources/
│   ├── Onboarding/                    by resource_topic, else first tag, else record type
│   └── SOPs/
└── 4-Archive/
    ├── Projects/                      completed and cancelled projects, moved whole
    ├── Areas/                         finished area records older than PARA_ARCHIVE_AFTER_DAYS
    └── Resources/                     archived resources
```

## CRM pages

The CRM gets its own folder, `2-Areas/CRM/` (`PARA_CRM_FOLDER`): `Pipeline.md`, `Contacts.md`, one page per company and per deal, and the activity and other records linked to a CRM company that have no project or area. Disqualified or archived companies, archived deals and deals closed more than `PARA_ARCHIVE_AFTER_DAYS` ago move to `4-Archive/CRM/`. Contact emails and phone numbers stay out of the files unless `PARA_CRM_CONTACT_DETAILS=true`. The front page links to the pipeline. See [CRM: In the PARA mirror](07-crm.md#in-the-para-mirror).

## Where a record goes

The first rule that matches wins:

1. `para_override` set on the record (`project`, `area`, `resource`, `archive`).
2. Archived (`archived_at` set) → `4-Archive`.
3. Belongs to a project:
   - project `completed` or `cancelled` → `4-Archive/Projects/<project>/`
   - otherwise → `1-Projects/<project>/<type folder>/`
4. Type is a resource (playbook, SOP, template, research, reference, policy) → `3-Resources/<topic>/`, where topic is `resource_topic`, else the first tag, else the type. Resources stay here until archived.
5. Finished (status is one of the type's finished statuses) and not updated for `PARA_ARCHIVE_AFTER_DAYS` (default 30) → `4-Archive/Areas/<area>/<type folder>/`.
6. Otherwise → `2-Areas/<area>/<type folder>/`.

File names are `YYYY-MM-DD <title> (<first 8 characters of the id>).md`, made safe for every operating system. When a record moves (for example its project completes), the old file is removed and the new one written.

## What each file contains

- YAML front matter: `id`, `type`, `title`, `status`, `external_ref`, `project`, `client`, `area`, `process`, `step`, `owner`, `assignee`, `created_by`, `updated_by`, `on_behalf_of`, `authenticated_as`, `priority`, `due`, `tags`, `visibility`, `approval`, `approved_by`, `version` and dates. Obsidian and other tools can query it.
- The body as written.
- A table of the type-specific `fields`.
- Links to related records (relative links that work in any markdown viewer).
- The last 15 history events.

## Restricted records

Restricted records (HR, salaries, legal, sensitive finance) are **never** written to the main mirror. If `PARA_RESTRICTED_DIR` is set, they are written there with the same structure. Keep that folder readable only by the owner (`chmod 700`), and do not sync it anywhere shared. Leave the variable empty to skip them entirely.

## Safe cleanup

Every generated file carries an `opsbrain:generated` marker and is listed in `.opsbrain/manifest.json`. On each export OpsBrain removes only files it generated before that are no longer needed, then empty folders. Files you add by hand are never deleted, but keep personal notes elsewhere: the mirror is not the place to edit.

Files are written only when their content changes, so a git history of the mirror shows real changes, not noise.

## Version history with git (optional)

To keep a history of every export:

```bash
sudo -u '#1993' git -C para-output init
```

Set `PARA_GIT_COMMIT=true` in `deploy/.env` and restart. Each export that changes something becomes one commit, authored as `PARA_GIT_AUTHOR_NAME`.

To share it, push to a **private** remote on a git server you control. The simplest setup pushes from the host on a timer (`git -C para-output push`), so no git credentials live in the container. If you set `PARA_GIT_PUSH=true`, the exporter's container needs credentials for that remote.

## Reading it in Obsidian

Open `para-output` (or a clone of its private git repository) as a vault. Use it read-only: sync tools that write back would be overwritten at the next export. Dataview queries can use the front matter, for example:

```text
TABLE status, assignee, due FROM "1-Projects" WHERE type = "task_card" AND status != "done"
```
