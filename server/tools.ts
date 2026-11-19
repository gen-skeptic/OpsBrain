// MCP tools. Every tool runs as the authenticated principal, or as the agent
// named in `acting_as` when that principal is allowed to act for it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AccessError, type Principal, resolveCtx } from "./auth.ts";
import * as rec from "./records.ts";
import { config } from "./config.ts";

const RECORD_TYPES_HINT =
  "note, task_card, qa_record, decision, approval, kaizen_card, meeting_note, risk, incident, change_record, support_request, lead, proposal, invoice, contract, hiring, feedback, report, plan, retrospective, playbook, sop, template, research, reference, policy";

const PRIVACY =
  " Never store client confidential data (client systems, customer records, credentials, health or financial data) or client deliverables in OpsBrain; store company records about the work, and link to deliverables in the client's own systems.";

const actingAs = z.string().optional().describe(
  "Handle of the agent you are acting as (e.g. dio-chief-of-staff). Required when one key is shared by several agents in a session; must be delegated to your key.",
);

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown, summary?: string): Result {
  const text = (summary ? summary + "\n\n" : "") + JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): Result {
  const e = err as Error & { code?: string };
  let msg = e.message ?? String(err);
  if (e.code === "23503") msg = `A referenced project, area, process, record type or principal does not exist (${msg})`;
  if (e.code === "23505") msg = `That value must be unique (${msg})`;
  const kind = err instanceof AccessError ? "Not allowed" : err instanceof rec.InputError ? "Invalid input" : "Error";
  return { content: [{ type: "text", text: `${kind}: ${msg}` }], isError: true };
}

function run<A extends { acting_as?: string }>(auth: Principal, fn: (ctx: Awaited<ReturnType<typeof resolveCtx>>, args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try {
      const ctx = await resolveCtx(auth, args.acting_as);
      return await fn(ctx, args);
    } catch (err) {
      return fail(err);
    }
  };
}

const recordFields = {
  title: z.string().max(300).optional().describe("Short title"),
  status: z.string().max(60).optional().describe("Status, e.g. ready, in_progress, ready_for_qa, changes_requested, done; pass, fail; decided"),
  external_ref: z.string().max(200).optional().describe("Your own stable ID, e.g. a task card ID such as ACME-01-P09-12-sprint-3-tests"),
  project_id: z.string().optional().describe("Project or client engagement ID (see list_projects); use for anything that belongs to a project"),
  area: z.string().optional().describe("Area of responsibility slug (see list_directory) for ongoing work outside a project"),
  process_id: z.string().optional().describe("Process ID, e.g. P09"),
  process_step: z.number().int().positive().optional(),
  para: z.enum(["project", "area", "resource", "archive"]).optional().describe("Override where the PARA export files this record"),
  resource_topic: z.string().optional().describe("Topic folder for resources"),
  owner: z.string().optional().describe("Handle of the accountable owner (defaults to you)"),
  assignee: z.string().optional().describe("Handle of the person or agent doing the work"),
  priority: z.enum(["high", "normal", "low"]).optional(),
  due_on: z.string().optional().describe("Due date, YYYY-MM-DD"),
  tags: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.unknown()).optional().describe("Type-specific fields, e.g. QA findings, decision options, invoice amount"),
  visibility: z.enum(["company", "restricted"]).optional().describe("restricted: only owners/admins, the record's owner, assignee, creator and allowed principals can read it (use for HR, legal, sensitive finance)"),
  allowed: z.array(z.string()).optional().describe("Extra handles that may read a restricted record"),
  financial_or_ethical: z.boolean().optional().describe("True when the record carries a financial or ethical consideration; it then needs approval from a person with approval rights"),
  requires_approval: z.boolean().optional(),
};

const listFilters = {
  record_type: z.string().optional(),
  status: z.string().optional(),
  project_id: z.string().optional(),
  area: z.string().optional(),
  process_id: z.string().optional(),
  owner: z.string().optional(),
  assignee: z.string().optional(),
  created_by: z.string().optional(),
  approval_status: z.enum(["pending", "approved", "rejected", "changes_requested"]).optional(),
  tag: z.string().optional(),
  updated_since: z.string().optional().describe("ISO date or timestamp"),
  include_archived: z.boolean().optional(),
  limit: z.number().int().optional(),
};

export function buildServer(auth: Principal): McpServer {
  const server = new McpServer({ name: "opsbrain", version: "1.0.0" });
  const ro = { readOnlyHint: true };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("whoami", {
    title: "Who am I",
    description: "Show the principal your key belongs to, its role, and the agents it may act as.",
    annotations: ro, inputSchema: { acting_as: actingAs },
  }, run(auth, async (ctx) => {
    const { db } = await import("./db.ts");
    const delegates = await db()`
      SELECT p.handle FROM ops_delegations d JOIN ops_principals p ON p.id = d.may_act_as
       WHERE d.principal_id = ${ctx.auth.id} ORDER BY p.handle`;
    return ok({
      authenticated_as: { handle: ctx.auth.handle, kind: ctx.auth.kind, role: ctx.auth.role, can_approve: ctx.auth.can_approve },
      acting_as: ctx.actor.handle,
      may_act_as: delegates.map((d) => d.handle),
    });
  }));

  server.registerTool("create_record", {
    title: "Create company record",
    description: `Create a company record: a task card, QA record, decision, kaizen card, meeting note, risk, lead, invoice record, playbook and so on (types: ${RECORD_TYPES_HINT}). Attribution (who created it, on whose behalf) is recorded automatically.${PRIVACY}`,
    annotations: { ...rw, idempotentHint: false },
    inputSchema: {
      record_type: z.string().describe(`One of: ${RECORD_TYPES_HINT}`),
      content: z.string().describe("The body in Markdown: a clear, standalone record"),
      ...recordFields,
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => {
    const r = await rec.createRecord(ctx, a);
    return ok(r, `Created ${a.record_type} ${r.id}${r.approval_status ? ` (approval ${r.approval_status})` : ""}${r.embedded || config.embeddingProvider === "none" ? "" : " — saved without an embedding (embedding service unreachable); run `deno task admin reembed` later"}`);
  }));

  server.registerTool("update_record", {
    title: "Update company record",
    description: "Change a record you own, are assigned, created or are allowed on (owners and admins can change any). Every change is kept in the record's history. Pass expected_version to avoid overwriting someone else's change.",
    annotations: { ...rw, idempotentHint: false },
    inputSchema: {
      id: z.string().describe("Record UUID or external_ref"),
      content: z.string().optional().describe("Replace the body"),
      append_content: z.string().optional().describe("Append to the body"),
      ...recordFields,
      archived: z.boolean().optional(),
      expected_version: z.number().int().optional(),
      comment: z.string().optional().describe("Why the change was made (kept in history)"),
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => ok(await rec.updateRecord(ctx, a.id, a))));

  server.registerTool("comment_record", {
    title: "Comment on record",
    description: "Add a comment to any record you can read (kept in its history).",
    annotations: { ...rw, idempotentHint: false },
    inputSchema: { id: z.string(), comment: z.string(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.commentRecord(ctx, a.id, a.comment))));

  server.registerTool("link_records", {
    title: "Link records",
    description: "Link two records, e.g. a QA record 'reviews' a task card, a decision 'decides' a task card, a record 'supersedes' another, or 'relates_to'.",
    annotations: { ...rw, idempotentHint: true },
    inputSchema: {
      from: z.string(), to: z.string(),
      relation: z.string().regex(/^[a-z][a-z_]{1,39}$/).describe("reviews, decides, follows, blocks, supersedes, relates_to, returns_to"),
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => ok(await rec.linkRecords(ctx, a.from, a.to, a.relation))));

  server.registerTool("decide_approval", {
    title: "Approve, reject or request changes",
    description: "For people with approval rights only, using their own key: approve, reject or request changes on a record that requires approval (final deployments to customers, financial transactions, financial or ethical decisions).",
    annotations: { ...rw, idempotentHint: false },
    inputSchema: {
      id: z.string(),
      decision: z.enum(["approve", "reject", "request_changes"]),
      comment: z.string().optional(),
    },
  }, run(auth, async (ctx, a: any) => ok(await rec.decideApproval(ctx, a.id, a.decision, a.comment))));

  server.registerTool("get_record", {
    title: "Get record",
    description: "Read one record by UUID or external_ref, with its links and recent history.",
    annotations: ro, inputSchema: { id: z.string(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.getRecord(ctx, a.id))));

  server.registerTool("record_history", {
    title: "Record history",
    description: "Who changed what and when on a record.",
    annotations: ro, inputSchema: { id: z.string(), limit: z.number().int().optional(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.recordHistory(ctx, a.id, Math.min(a.limit ?? 50, 200)))));

  server.registerTool("list_records", {
    title: "List records",
    description: "List records you can read, newest first, with filters (type, status, project, area, process, owner, assignee, approval status, tag, date, text).",
    annotations: ro,
    inputSchema: { ...listFilters, text: z.string().optional(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.listRecords(ctx, a))));

  server.registerTool("search_records", {
    title: "Search records",
    description: "Search records you can read by meaning (falls back to keywords when embeddings are unavailable).",
    annotations: ro,
    inputSchema: { query: z.string(), ...listFilters, threshold: z.number().optional(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.searchRecords(ctx, a.query, a))));

  server.registerTool("list_projects", {
    title: "List projects",
    description: "List projects and client engagements (PARA projects).",
    annotations: ro, inputSchema: { status: z.enum(["planned", "active", "on_hold", "completed", "cancelled"]).optional(), acting_as: actingAs },
  }, run(auth, async (_ctx, a: any) => ok(await rec.listProjects(_ctx, a.status))));

  server.registerTool("upsert_project", {
    title: "Create or update project",
    description: "Create a project or client engagement, or update one you own (owners and admins can update any). Completing or cancelling a project moves its records to the PARA archive.",
    annotations: { ...rw, idempotentHint: true },
    inputSchema: {
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$/).describe("Engagement or project ID, e.g. ACME-01"),
      name: z.string().optional(),
      kind: z.enum(["client_engagement", "internal"]).optional(),
      client_name: z.string().optional(),
      status: z.enum(["planned", "active", "on_hold", "completed", "cancelled"]).optional(),
      area: z.string().optional(), owner: z.string().optional(),
      started_on: z.string().optional(), due_on: z.string().optional(), completed_on: z.string().optional(),
      description: z.string().optional(),
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => ok(await rec.upsertProject(ctx, a))));

  server.registerTool("list_directory", {
    title: "List areas, processes and record types",
    description: "The company's areas of responsibility, processes and record types.",
    annotations: ro, inputSchema: {},
  }, run(auth, async () => ok(await rec.listDirectory())));

  server.registerTool("list_principals", {
    title: "List people and agents",
    description: "Active people, agents and services with their handles and roles.",
    annotations: ro, inputSchema: {},
  }, run(auth, async () => ok(await rec.listPrincipals())));

  server.registerTool("stats", {
    title: "OpsBrain statistics",
    description: "Record counts by type, pending approvals and projects by status (only what you can read).",
    annotations: ro, inputSchema: { acting_as: actingAs },
  }, run(auth, async (ctx) => ok(await rec.stats(ctx))));

  // ---- Open Brain compatibility (existing clients and skills keep working) ----
  server.registerTool("capture_thought", {
    title: "Capture thought",
    description: `Open Brain compatible: save a free-form note. Prefer create_record for company records.${PRIVACY}`,
    annotations: { ...rw, idempotentHint: false },
    inputSchema: { content: z.string(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => {
    const r = await rec.createRecord(ctx, { record_type: "note", content: a.content });
    return ok(r, `Captured note ${r.id}`);
  }));

  server.registerTool("search_thoughts", {
    title: "Search thoughts",
    description: "Open Brain compatible: search records by meaning.",
    annotations: ro,
    inputSchema: { query: z.string(), limit: z.number().optional(), threshold: z.number().optional(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.searchRecords(ctx, a.query, { limit: a.limit, threshold: a.threshold }))));

  server.registerTool("list_thoughts", {
    title: "List thoughts",
    description: "Open Brain compatible: list recent records.",
    annotations: ro,
    inputSchema: { limit: z.number().optional(), type: z.string().optional(), days: z.number().optional(), acting_as: actingAs },
  }, run(auth, async (ctx, a: any) => ok(await rec.listRecords(ctx, {
    limit: a.limit, record_type: a.type,
    updated_since: a.days ? new Date(Date.now() - a.days * 86400_000).toISOString() : undefined,
  }))));

  server.registerTool("thought_stats", {
    title: "Thought statistics",
    description: "Open Brain compatible: same as stats.",
    annotations: ro, inputSchema: { acting_as: actingAs },
  }, run(auth, async (ctx) => ok(await rec.stats(ctx))));

  // ChatGPT connector compatibility: exact `search` / `fetch` shapes.
  server.registerTool("search", {
    title: "Search OpsBrain",
    description: "Read-only search for ChatGPT connectors.",
    annotations: ro, inputSchema: { query: z.string() },
  }, run(auth, async (ctx, a: any) => {
    const { results } = await rec.searchRecords(ctx, a.query, { limit: 10 });
    return { content: [{ type: "text", text: JSON.stringify({ results: (results as any[]).map((r) => ({ id: r.id, title: r.title ?? String(r.content).slice(0, 80), url: `${config.publicUrl}/records/${r.id}` })) }) }] };
  }));

  server.registerTool("fetch", {
    title: "Fetch OpsBrain record",
    description: "Read-only fetch for ChatGPT connectors.",
    annotations: ro, inputSchema: { id: z.string() },
  }, run(auth, async (ctx, a: any) => {
    const r = await rec.getRecord(ctx, a.id);
    return { content: [{ type: "text", text: JSON.stringify({ id: r.id, title: r.title ?? r.record_type, text: r.content, url: `${config.publicUrl}/records/${r.id}`, metadata: { ...r, content: undefined } }) }] };
  }));

  return server;
}
