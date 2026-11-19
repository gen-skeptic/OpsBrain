# 5. Security and privacy

OpsBrain holds how the company runs. It is private by design: it runs on servers you control, clients never see it, and nothing in it is published.

## Privacy rules

1. **Private servers only.** The database, the MCP server, the embedding model and the PARA mirror run on hardware you control. No third-party database or SaaS memory service.
2. **Clients never see OpsBrain.** There are no client logins, no client-facing exports, and the PARA mirror is for the team only. Status reports to clients are written from OpsBrain records and sent through normal client channels, never as OpsBrain links or files.
3. **No client deliverables and no client confidential data.** Store records *about* client work (task cards, QA verdicts, decisions, invoice records), not the deliverables themselves, and never client secrets, credentials, personal data from client systems, or regulated data. Reference those by location (repository, document store) instead.
4. **Restricted records for sensitive internal topics.** HR, compensation, legal and sensitive finance use `visibility: restricted`. They are excluded from the main PARA mirror.
5. **Local embeddings by default.** The default configuration embeds text with a local Ollama model, so record text does not leave your network for indexing. If you point `EMBEDDING_API_BASE` at a hosted provider, record titles and content are sent to it; decide that deliberately.
6. **AI clients see what they read.** Any AI client you connect (Claude, Codex, an agent runtime) receives the records it reads or searches, under that provider's data terms. Use business plans with appropriate data terms, and keep restricted work to clients and keys you trust.

## Access control

| Control | How |
| --- | --- |
| Authentication | Every request needs a key. Keys are random 32-byte values, stored only as SHA-256 hashes, and can expire or be revoked. |
| Least privilege | One key per person, agent runtime or session. Agents get the `agent` role. Auditors get read-only access. |
| Delegation | A session key can act only as the agents it is delegated to; every record shows both the agent and the key holder. |
| Restricted visibility | Enforced in every read path (get, list, search, fetch, export) by the `ops_can_read` database function. |
| Write permission | Only owners and admins, or the record's owner, assignee, creator or allowed principals can change a record. Anyone who can read it can comment. |
| Decision rights | Approval of financial or ethical records is enforced by a database trigger: only an active human with `can_approve`. |
| Audit trail | Every change is an event with actor, key holder and changed fields. Events are append-only through the tools. |

## Network

- Port 8787 is bound to localhost in Docker Compose. Publish it only through TLS (reverse proxy, VPN, or tunnel).
- The database port is not published at all.
- Prefer a VPN for team access. Use a public tunnel only for clients that require it (Claude Desktop and claude.ai custom connectors), with a dedicated, revocable key.
- Set `OPSBRAIN_ALLOW_QUERY_KEY=false` if no client needs `?key=`, so keys never appear in URLs or proxy logs.
- The server accepts only `POST` for MCP; `GET` returns 405.

## Keys

- Store keys in a password manager or secret store; pass them to clients through environment variables.
- Give session and connector keys an expiry (`--expires-days`) and rotate them.
- Revoke a key the moment a device or session is lost: `deno task admin key revoke <hash-prefix>`.
- Disable principals who leave: `deno task admin principal disable <handle>`.

## Data protection

- Back up nightly with `pg_dump` to encrypted storage you control, keep at least 30 days, and test restores quarterly.
- Encrypt disks on the database host and wherever the PARA mirror is synced.
- Keep the restricted mirror folder `chmod 700`, owned by the exporter, and out of shared sync.
- If you version the mirror with git, push only to a private remote on a server you control.

## Retention

Records are never hard-deleted through the tools; they are archived. To remove data you are obliged to delete (for example personal data on request), an owner deletes it in SQL with a `WHERE` clause naming the specific records, and records the deletion as a `decision`.

## License

OpsBrain is a fork of [Open Brain](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones, licensed under the Functional Source License 1.1 with an MIT future license (FSL-1.1-MIT, see [LICENSE.md](../../LICENSE.md)).

- **Allowed:** internal use as the company's system of record; using it while providing professional services; modifying it.
- **Not allowed until the MIT change date of each version:** making OpsBrain, or something substantially similar, available to others as a commercial product or service (a "Competing Use"). Do not sell or host OpsBrain for clients as a product. If a client needs a similar system, build it independently or use a differently licensed foundation, and get legal advice first.
- Keep the license file and the copyright notice. Do not use the Open Brain name or logo for this fork beyond stating where it comes from.
