# 2. Connect AI clients

OpsBrain speaks MCP over Streamable HTTP at `POST <OPSBRAIN_PUBLIC_URL>/mcp`. Any client that can send a custom header works. The key can go in any of these:

| Where | Example |
| --- | --- |
| `x-opsbrain-key` header (preferred) | `x-opsbrain-key: obk_...` |
| `Authorization` header | `Authorization: Bearer obk_...` |
| `?key=` query parameter (only for clients that cannot send headers; disable with `OPSBRAIN_ALLOW_QUERY_KEY=false`) | `https://opsbrain.example/mcp?key=obk_...` |

Keep keys in environment variables or a secret store, never in committed files.

## Claude Code

Per user (all projects):

```bash
claude mcp add --transport http --scope user opsbrain https://opsbrain.example.internal/mcp --header "x-opsbrain-key: $OPSBRAIN_KEY"
```

Per project, committed to the repo without the secret: create `.mcp.json` in the project root. Claude Code expands environment variables when it loads the file.

```json
{
  "mcpServers": {
    "opsbrain": {
      "type": "http",
      "url": "${OPSBRAIN_URL}/mcp",
      "headers": { "x-opsbrain-key": "${OPSBRAIN_KEY}" }
    }
  }
}
```

Then set `OPSBRAIN_URL` and `OPSBRAIN_KEY` in your shell profile or secret manager before starting `claude`.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.opsbrain]
url = "https://opsbrain.example.internal/mcp"
bearer_token_env_var = "OPSBRAIN_KEY"
```

Export `OPSBRAIN_KEY` before starting Codex. If your Codex version does not support remote MCP servers yet, update it; HTTP transport support and its option names have changed between releases, so check `codex mcp --help`.

## OpenClaw, Hermes and other agent runtimes

Register an MCP server with:

- Transport: Streamable HTTP (sometimes listed as "http" or "remote")
- URL: `https://opsbrain.example.internal/mcp`
- Header: `x-opsbrain-key: <the agent's key>` (or `Authorization: Bearer <key>`)

Give each long-running agent its own key (`deno task admin key issue <agent-handle>`) so its records are attributed to it without `acting_as`.

## Claude Desktop and claude.ai

Custom connectors connect from Anthropic's cloud, so OpsBrain must be reachable over public HTTPS (for example a Cloudflare Tunnel). They cannot send custom headers, so put the key in the URL:

1. Settings, Connectors, Add custom connector.
2. Name: `OpsBrain`. URL: `https://opsbrain.example.com/mcp?key=obk_...`
3. Save, then enable the connector in a chat.

Use a dedicated key for this connector so you can revoke it on its own. Prefer Claude Code or Codex over a VPN for work with restricted records.

## ChatGPT and other clients that use `search` and `fetch`

OpsBrain also provides read-only `search` and `fetch` tools in the shape these clients expect. They respect the same visibility rules as everything else.

## Check the connection

Ask the client to call `whoami`. You should see something like:

```json
{
  "authenticated_as": { "handle": "alex-claude-code", "kind": "service", "role": "agent", "can_approve": false },
  "acting_as": "alex-claude-code",
  "may_act_as": ["quality-reviewer", "sales-agent"]
}
```

Then try `whoami` with `acting_as` set to one of the listed agents.

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Your principal, role, and the agents you may act as. |
| `create_record` | Create a record (task card, QA record, decision, kaizen card, meeting note, risk, lead, invoice record, playbook, ...). |
| `update_record` | Change fields, status, assignee; archive or unarchive. Supports `expected_version` to avoid overwriting someone else's change. |
| `comment_record` | Add a comment to a record's history (anyone who can read it). |
| `link_records` | Link two records (`reviews`, `decides`, `follows`, `blocks`, `supersedes`, `relates_to`, `returns_to`, or any lowercase relation name). |
| `decide_approval` | Approve, reject or request changes on a record that needs approval (people with approval rights only). |
| `get_record` | One record by ID or `external_ref`, with links and recent history. |
| `record_history` | The full event history of a record. |
| `list_records` | Filter by type, status, project, area, process, owner, assignee, creator, approval status, tag, or date. |
| `search_records` | Semantic search (falls back to keyword search when embeddings are unavailable). |
| `list_projects`, `upsert_project` | Projects and client engagements (PARA "Projects"). |
| `list_directory` | Areas, processes and record types. |
| `list_principals` | People, agents and services. |
| `stats` | Counts by type and status, pending approvals. |
| `capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats` | Open Brain compatible tools, so existing prompts and skills keep working. Thoughts are stored as `note` records with attribution. |
| `search`, `fetch` | Read-only tools for clients that expect them. |
| `crm_upsert_company`, `crm_upsert_contact`, `crm_upsert_deal` | Create or update CRM companies (matched by domain), contacts (matched by email) and deals |
| `crm_log_activity` | Log a call, email, meeting, message or note against a company, contact or deal |
| `crm_get`, `crm_search`, `crm_list`, `crm_pipeline` | Read the CRM: one entry with everything linked, search, filtered lists, and the pipeline with forecast and what needs attention |
| `crm_screen_company`, `crm_start_engagement` | Decide a company's screen (approvers only); turn a won deal into an engagement project |

Every write tool accepts `acting_as` (an agent handle) when your key is delegated. `create_record`, `update_record` and `list_records` also take `company`, `contact` and `deal` to link records to the CRM. Details: [CRM](07-crm.md).

People don't need an AI client for the CRM or approvals: they use the web UI at `<OPSBRAIN_PUBLIC_URL>/crm`.
