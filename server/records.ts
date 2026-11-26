// Company records: create, update, read, search, link, comment and approve.
// Every function takes the request context so permissions and attribution are
// applied in one place.
import { db, vectorLiteral } from "./db.ts";
import { embed, extractTags } from "./ai.ts";
import { config } from "./config.ts";
import { AccessError, type Ctx, principalByHandle } from "./auth.ts";

export { InputError } from "./errors.ts";
import { InputError } from "./errors.ts";
import { resolveCompanyId, resolveContactId, resolveDealId } from "./crm_refs.ts";

export type RecordInput = {
  record_type?: string;
  title?: string;
  content?: string;
  status?: string;
  external_ref?: string;
  project_id?: string;
  area?: string;
  process_id?: string;
  process_step?: number;
  para?: "project" | "area" | "resource" | "archive";
  resource_topic?: string;
  owner?: string;
  assignee?: string;
  priority?: "high" | "normal" | "low";
  due_on?: string;
  tags?: string[];
  fields?: Record<string, unknown>;
  visibility?: "company" | "restricted";
  allowed?: string[];
  financial_or_ethical?: boolean;
  requires_approval?: boolean;
  metadata?: Record<string, unknown>;
  /** CRM links: company (ID, domain or exact name), contact (ID, email or exact name), deal (ID or exact name). */
  company?: string;
  contact?: string;
  deal?: string;
};

/** Resolve CRM links; a deal or contact implies its company when none is given. */
async function crmLinks(input: { company?: string; contact?: string; deal?: string }) {
  const company = await resolveCompanyId(input.company);
  const contact = await resolveContactId(input.contact);
  const deal = await resolveDealId(input.deal);
  let companyId = company;
  if (!companyId && deal) companyId = (await db()`SELECT company_id FROM crm_deals WHERE id = ${deal}`)[0].company_id;
  if (!companyId && contact) companyId = (await db()`SELECT company_id FROM crm_contacts WHERE id = ${contact}`)[0].company_id;
  return { crm_company_id: companyId, crm_contact_id: contact, crm_deal_id: deal };
}

const READ_FILTER = `ops_can_read($1, visibility, owner_id, assignee_id, created_by_id, allowed_principals)`;

function isManager(ctx: Ctx): boolean {
  return ctx.actor.role === "owner" || ctx.actor.role === "admin";
}

async function handleToId(handle: string | undefined | null, label: string): Promise<string | null> {
  if (handle === undefined || handle === null || handle === "") return null;
  const p = await principalByHandle(handle);
  if (!p || !p.active) throw new InputError(`Unknown or inactive ${label} "${handle}"`);
  return p.id;
}

async function handlesToIds(handles: string[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const h of handles ?? []) out.push((await handleToId(h, "principal"))!);
  return out;
}

function checkSize(text: string | undefined) {
  if (text && text.length > config.maxRecordChars) {
    throw new InputError(`Content is ${text.length} characters; the limit is ${config.maxRecordChars}. Store large documents in the document store and link them.`);
  }
}

async function embeddingFor(title: string | null | undefined, content: string): Promise<string | null> {
  const v = await embed(`${title ?? ""}\n\n${content}`.trim());
  return v ? vectorLiteral(v) : null;
}

// deno-lint-ignore no-explicit-any
type Tx = any;

async function logEvent(
  tx: Tx,
  recordId: string, ctx: Ctx, action: string, changes: Record<string, unknown> = {}, comment: string | null = null,
) {
  await tx`
    INSERT INTO ops_record_events (record_id, actor_id, authenticated_as, action, changes, comment)
    VALUES (${recordId}, ${ctx.actor.id}, ${ctx.auth.id}, ${action}, ${tx.json(changes as never)}, ${comment})`;
}

/** Load a raw record row the caller may read, by id or external_ref. */
export async function loadReadable(ctx: Ctx, ref: string): Promise<Record<string, any>> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  const rows = await db().unsafe(
    `SELECT * FROM ops_records WHERE ${isUuid ? "id = $2::uuid" : "external_ref = $2"} AND ${READ_FILTER}`,
    [ctx.actor.id, ref],
  );
  if (!rows.length) throw new AccessError(`Record "${ref}" not found or not visible to ${ctx.actor.handle}`);
  return rows[0];
}

function canWrite(ctx: Ctx, r: Record<string, any>): boolean {
  if (ctx.actor.role === "auditor") return false;
  if (isManager(ctx)) return true;
  const id = ctx.actor.id;
  return r.owner_id === id || r.assignee_id === id || r.created_by_id === id ||
    (r.allowed_principals ?? []).includes(id);
}

export async function createRecord(ctx: Ctx, input: RecordInput) {
  if (ctx.actor.role === "auditor") throw new AccessError("Auditors have read-only access");
  const content = (input.content ?? "").trim();
  if (!content) throw new InputError("content is required");
  checkSize(content);
  const recordType = input.record_type ?? "note";
  const typeRow = await db()`SELECT slug FROM ops_record_types WHERE slug = ${recordType}`;
  if (!typeRow.length) throw new InputError(`Unknown record_type "${recordType}". Use list_record_types.`);
  if (input.external_ref) {
    const dup = await db()`SELECT id FROM thoughts WHERE external_ref = ${input.external_ref}`;
    if (dup.length) throw new InputError(`A record with external_ref "${input.external_ref}" already exists (${dup[0].id}); use update_record`);
  }
  const ownerId = (await handleToId(input.owner, "owner")) ?? ctx.actor.id;
  const assigneeId = await handleToId(input.assignee, "assignee");
  const allowed = await handlesToIds(input.allowed);
  const embedding = await embeddingFor(input.title, content);
  const tags = recordType === "note" ? await extractTags(content) : {};
  const metadata = { ...(input.metadata ?? {}), ...(Object.keys(tags).length ? { extracted: tags } : {}) };
  const crm = await crmLinks(input);

  return await db().begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO thoughts (
        content, embedding, metadata, record_type, title, status, external_ref, project_id, area_slug,
        process_id, process_step, para_override, resource_topic, owner_id, assignee_id, created_by,
        updated_by, authenticated_as, on_behalf_of, priority, due_on, tags, fields, visibility,
        allowed_principals, financial_or_ethical, requires_approval, crm_company_id, crm_contact_id, crm_deal_id)
      VALUES (
        ${content}, ${embedding}::vector, ${tx.json(metadata as never)}, ${recordType}, ${input.title ?? null},
        ${input.status ?? null}, ${input.external_ref ?? null}, ${input.project_id ?? null}, ${input.area ?? null},
        ${input.process_id ?? null}, ${input.process_step ?? null}, ${input.para ?? null}, ${input.resource_topic ?? null},
        ${ownerId}, ${assigneeId}, ${ctx.actor.id}, ${ctx.actor.id}, ${ctx.auth.id}, ${ctx.onBehalfOf},
        ${input.priority ?? null}, ${input.due_on ?? null}, ${input.tags ?? []}::text[], ${tx.json((input.fields ?? {}) as never)},
        ${input.visibility ?? "company"}, ${allowed}::uuid[], ${input.financial_or_ethical ?? false},
        ${input.requires_approval ?? false}, ${crm.crm_company_id}, ${crm.crm_contact_id}, ${crm.crm_deal_id})
      RETURNING id, version, approval_status`;
    await logEvent(tx, row.id, ctx, "create", { record_type: recordType, title: input.title ?? null });
    return { id: row.id as string, version: row.version as number, approval_status: row.approval_status, embedded: embedding !== null };
  });
}

export type UpdateInput = RecordInput & {
  append_content?: string;
  archived?: boolean;
  expected_version?: number;
  comment?: string;
};

export async function updateRecord(ctx: Ctx, ref: string, input: UpdateInput) {
  const r = await loadReadable(ctx, ref);
  if (!canWrite(ctx, r)) {
    throw new AccessError(`${ctx.actor.handle} can read this record but not change it; add a comment or ask its owner (${r.owner ?? "none"})`);
  }
  if (input.expected_version !== undefined && input.expected_version !== r.version) {
    throw new InputError(`Version conflict: you expected version ${input.expected_version} but the record is at version ${r.version}. Re-read it and try again.`);
  }
  const set: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};
  const note = (k: string, from: unknown, to: unknown) => { changes[k] = { from, to }; };

  let content: string | undefined;
  if (input.content !== undefined) content = input.content.trim();
  if (input.append_content) content = `${(content ?? r.content).trimEnd()}\n\n${input.append_content.trim()}`;
  if (content !== undefined && content !== r.content) {
    if (!content) throw new InputError("content cannot be empty");
    checkSize(content);
    set.content = content;
    changes.content = { from_chars: r.content.length, to_chars: content.length };
  }
  const simple: [keyof UpdateInput, string, string][] = [
    ["title", "title", "title"], ["status", "status", "status"], ["priority", "priority", "priority"],
    ["due_on", "due_on", "due_on"], ["project_id", "project_id", "project_id"], ["area", "area_slug", "area_slug"],
    ["process_id", "process_id", "process_id"], ["process_step", "process_step", "process_step"],
    ["para", "para_override", "para_override"], ["resource_topic", "resource_topic", "resource_topic"],
    ["external_ref", "external_ref", "external_ref"],
  ];
  const norm = (x: unknown) => x instanceof Date ? x.toISOString().slice(0, 10) : String(x ?? "");
  for (const [inKey, col, viewCol] of simple) {
    const v = input[inKey];
    if (v !== undefined && norm(v) !== norm(r[viewCol])) {
      set[col] = v === "" ? null : v;
      note(col, r[viewCol] ?? null, set[col]);
    }
  }
  if (input.tags !== undefined) { set.tags = input.tags; note("tags", r.tags, input.tags); }
  if (input.fields !== undefined) {
    set.fields = { ...(r.fields ?? {}), ...input.fields };
    note("fields", Object.keys(input.fields), null);
  }
  for (const [key, col, resolve] of [
    ["company", "crm_company_id", resolveCompanyId], ["contact", "crm_contact_id", resolveContactId], ["deal", "crm_deal_id", resolveDealId],
  ] as const) {
    const v = input[key];
    if (v !== undefined) {
      const id = v === "" ? null : await resolve(v);
      if (id !== r[col]) { set[col] = id; note(col, r[col] ?? null, id); }
    }
  }
  if (input.assignee !== undefined) {
    set.assignee_id = await handleToId(input.assignee, "assignee");
    note("assignee", r.assignee, input.assignee || null);
  }
  const ownerOrManager = isManager(ctx) || r.owner_id === ctx.actor.id;
  if (input.owner !== undefined) {
    if (!ownerOrManager) throw new AccessError("Only the record owner, an admin or the owner role can reassign ownership");
    set.owner_id = await handleToId(input.owner, "owner");
    note("owner", r.owner, input.owner);
  }
  if (input.visibility !== undefined || input.allowed !== undefined) {
    if (!ownerOrManager) throw new AccessError("Only the record owner, an admin or the owner role can change visibility");
    if (input.visibility !== undefined) { set.visibility = input.visibility; note("visibility", r.visibility, input.visibility); }
    if (input.allowed !== undefined) { set.allowed_principals = await handlesToIds(input.allowed); note("allowed", null, input.allowed); }
  }
  for (const flag of ["financial_or_ethical", "requires_approval"] as const) {
    const v = input[flag];
    if (v !== undefined && v !== r[flag]) {
      if (v === false && !ctx.auth.can_approve) {
        throw new AccessError(`Only a person with approval rights can clear ${flag}`);
      }
      set[flag] = v;
      note(flag, r[flag], v);
    }
  }
  let action = "update";
  if (input.archived !== undefined && input.archived !== (r.archived_at !== null)) {
    set.archived_at = input.archived ? new Date().toISOString() : null;
    action = input.archived ? "archive" : "unarchive";
  }
  if (!Object.keys(set).length) {
    if (input.comment) return await commentRecord(ctx, r.id, input.comment);
    return { id: r.id, version: r.version, changed: false };
  }
  if (set.content !== undefined || set.title !== undefined) {
    set.embedding = await embeddingFor((set.title as string) ?? r.title, (set.content as string) ?? r.content);
  }
  set.updated_by = ctx.actor.id;

  return await db().begin(async (tx) => {
    const cols = Object.keys(set);
    const assignments = cols.map((c, i) => {
      if (c === "embedding") return `embedding = $${i + 2}::vector`;
      if (c === "allowed_principals") return `allowed_principals = $${i + 2}::uuid[]`;
      if (c === "fields") return `fields = $${i + 2}::jsonb`;
      return `${c} = $${i + 2}`;
    });
    // The driver serializes objects for jsonb parameters itself; a pre-serialized string would be stored as a JSON string.
    const values = cols.map((c) => set[c]);
    const [row] = await tx.unsafe(
      `UPDATE thoughts SET ${assignments.join(", ")} WHERE id = $1 RETURNING id, version, approval_status`,
      [r.id, ...values] as never[],
    );
    await logEvent(tx, r.id, ctx, action, changes, input.comment ?? null);
    return { id: row.id, version: row.version, approval_status: row.approval_status, changed: true };
  });
}

export async function commentRecord(ctx: Ctx, ref: string, comment: string) {
  if (!comment?.trim()) throw new InputError("comment is required");
  checkSize(comment);
  const r = await loadReadable(ctx, ref);
  await db().begin(async (tx) => { await logEvent(tx, r.id, ctx, "comment", {}, comment.trim()); });
  return { id: r.id, commented: true };
}

export async function linkRecords(ctx: Ctx, fromRef: string, toRef: string, relation: string) {
  const a = await loadReadable(ctx, fromRef);
  const b = await loadReadable(ctx, toRef);
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO ops_record_links (from_id, to_id, relation, created_by)
      VALUES (${a.id}, ${b.id}, ${relation}, ${ctx.actor.id}) ON CONFLICT DO NOTHING`;
    await logEvent(tx, a.id, ctx, "link", { relation, to: b.id });
  });
  return { from: a.id, to: b.id, relation };
}

export async function decideApproval(ctx: Ctx, ref: string, decision: "approve" | "reject" | "request_changes", comment?: string) {
  if (ctx.actor.id !== ctx.auth.id || ctx.auth.kind !== "human" || !ctx.auth.can_approve) {
    throw new AccessError("Approvals must come from a person with approval rights, using their own key (not acting as an agent)");
  }
  const r = await loadReadable(ctx, ref);
  if (!r.requires_approval) throw new InputError("This record does not require approval");
  const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested";
  return await db().begin(async (tx) => {
    const [row] = await tx`
      UPDATE thoughts SET approval_status = ${status},
             approved_by = ${decision === "request_changes" ? null : ctx.auth.id},
             updated_by = ${ctx.auth.id}
       WHERE id = ${r.id}
       RETURNING id, version, approval_status, approved_at`;
    await logEvent(tx, r.id, ctx, decision, { approval_status: { from: r.approval_status, to: status } }, comment ?? null);
    return row;
  });
}

export async function getRecord(ctx: Ctx, ref: string): Promise<Record<string, any>> {
  const r = await loadReadable(ctx, ref);
  const links = await db().unsafe(
    `SELECT l.relation, 'outgoing' AS direction, o.id, o.record_type, o.title, o.status
       FROM ops_record_links l JOIN ops_records o ON o.id = l.to_id
      WHERE l.from_id = $2 AND ops_can_read($1, o.visibility, o.owner_id, o.assignee_id, o.created_by_id, o.allowed_principals)
     UNION ALL
     SELECT l.relation, 'incoming', o.id, o.record_type, o.title, o.status
       FROM ops_record_links l JOIN ops_records o ON o.id = l.from_id
      WHERE l.to_id = $2 AND ops_can_read($1, o.visibility, o.owner_id, o.assignee_id, o.created_by_id, o.allowed_principals)`,
    [ctx.actor.id, r.id],
  );
  const history = await recordHistory(ctx, r.id, 20);
  const { allowed_principals: _a, owner_id: _o, assignee_id: _s, created_by_id: _c, ...rest } = r;
  return { ...rest, links, history };
}

export async function recordHistory(ctx: Ctx, ref: string, limit = 50) {
  const r = await loadReadable(ctx, ref);
  return await db()`
    SELECT e.created_at, a.handle AS actor, au.handle AS authenticated_as, e.action, e.changes, e.comment
      FROM ops_record_events e
      LEFT JOIN ops_principals a ON a.id = e.actor_id
      LEFT JOIN ops_principals au ON au.id = e.authenticated_as
     WHERE e.record_id = ${r.id}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ${limit}`;
}

export type ListFilters = {
  record_type?: string; status?: string; project_id?: string; area?: string; process_id?: string;
  owner?: string; assignee?: string; created_by?: string; approval_status?: string; tag?: string;
  updated_since?: string; text?: string; include_archived?: boolean; limit?: number;
  company?: string; contact?: string; deal?: string;
};

const LIST_COLUMNS = `id, record_type, title, status, external_ref, project_id, area_slug, process_id, process_step,
  owner, assignee, created_by, updated_by, on_behalf_of, priority, due_on, tags, visibility, financial_or_ethical,
  requires_approval, approval_status, approved_by, version, archived_at, created_at, updated_at,
  crm_company_id, crm_company_name, crm_contact_id, crm_contact_name, crm_deal_id, crm_deal_name, fields,
  left(content, 600) AS excerpt`;

export async function listRecords(ctx: Ctx, f: ListFilters) {
  const where: string[] = [READ_FILTER];
  const params: unknown[] = [ctx.actor.id];
  const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace("?", `$${params.length}`)); };
  if (!f.include_archived) where.push("archived_at IS NULL");
  if (f.record_type) add("record_type = ?", f.record_type);
  if (f.status) add("status = ?", f.status);
  if (f.project_id) add("project_id = ?", f.project_id);
  if (f.area) add("area_slug = ?", f.area);
  if (f.process_id) add("process_id = ?", f.process_id);
  if (f.owner) add("owner = ?", f.owner);
  if (f.assignee) add("assignee = ?", f.assignee);
  if (f.created_by) add("created_by = ?", f.created_by);
  if (f.approval_status) add("approval_status = ?", f.approval_status);
  if (f.tag) add("? = ANY(tags)", f.tag);
  if (f.updated_since) add("updated_at >= ?::timestamptz", f.updated_since);
  if (f.text) add("(coalesce(title,'') || ' ' || content) ILIKE '%' || ? || '%'", f.text);
  if (f.company) add("crm_company_id = ?::uuid", await resolveCompanyId(f.company));
  if (f.contact) add("crm_contact_id = ?::uuid", await resolveContactId(f.contact));
  if (f.deal) add("crm_deal_id = ?::uuid", await resolveDealId(f.deal));
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100);
  return await db().unsafe(
    `SELECT ${LIST_COLUMNS} FROM ops_records WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`,
    params as never[],
  );
}

export async function searchRecords(ctx: Ctx, query: string, f: ListFilters & { threshold?: number }) {
  const limit = Math.min(Math.max(f.limit ?? 10, 1), 50);
  const v = await embed(query);
  if (v) {
    const filters = {
      record_type: f.record_type, status: f.status, project_id: f.project_id, area_slug: f.area,
      process_id: f.process_id, include_archived: f.include_archived ?? false,
    };
    const rows = await db()`
      SELECT * FROM ops_match_records(${ctx.actor.id}, ${vectorLiteral(v)}::vector, ${f.threshold ?? 0.4}, ${limit},
                                      ${db().json(JSON.parse(JSON.stringify(filters)))})`;
    if (rows.length) return { mode: "semantic", results: rows };
  }
  // Keyword fallback: used when embeddings are off, unavailable, or found nothing.
  const where: string[] = [READ_FILTER, "to_tsvector('english', coalesce(title,'') || ' ' || content) @@ websearch_to_tsquery('english', $2)"];
  const params: unknown[] = [ctx.actor.id, query];
  if (!f.include_archived) where.push("archived_at IS NULL");
  for (const [k, col] of [["record_type", "record_type"], ["status", "status"], ["project_id", "project_id"], ["area", "area_slug"], ["process_id", "process_id"]] as const) {
    if (f[k]) { params.push(f[k]); where.push(`${col} = $${params.length}`); }
  }
  const rows = await db().unsafe(
    `SELECT id, record_type, title, content, status, project_id, area_slug, process_id, external_ref, created_at, updated_at
       FROM ops_records WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`,
    params as never[],
  );
  return { mode: "keyword", results: rows };
}

export async function stats(ctx: Ctx) {
  const byType = await db().unsafe(
    `SELECT record_type, count(*)::int AS n FROM ops_records WHERE ${READ_FILTER} AND archived_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
    [ctx.actor.id],
  );
  const pending = await db().unsafe(
    `SELECT count(*)::int AS n FROM ops_records WHERE ${READ_FILTER} AND requires_approval AND approval_status = 'pending'`,
    [ctx.actor.id],
  );
  const projects = await db()`SELECT status, count(*)::int AS n FROM ops_projects GROUP BY 1 ORDER BY 1`;
  return { records_by_type: byType, pending_approvals: pending[0].n, projects_by_status: projects };
}

// ---------------- Projects, areas, processes, principals ----------------

export async function listProjects(_ctx: Ctx, status?: string) {
  return await db()`
    SELECT p.id, p.name, p.kind, p.client_name, p.crm_company_id, p.status, p.area_slug, o.handle AS owner,
           p.started_on, p.due_on, p.completed_on, p.description, p.updated_at
      FROM ops_projects p LEFT JOIN ops_principals o ON o.id = p.owner_id
     WHERE ${status ?? null}::text IS NULL OR p.status = ${status ?? null}
     ORDER BY p.status, p.id`;
}

export type ProjectInput = {
  id: string; name?: string; kind?: "client_engagement" | "internal"; client_name?: string;
  status?: "planned" | "active" | "on_hold" | "completed" | "cancelled"; area?: string; owner?: string;
  started_on?: string; due_on?: string; completed_on?: string; description?: string;
  /** CRM company this engagement is for (ID, domain or exact name). */
  company?: string;
};

export async function upsertProject(ctx: Ctx, p: ProjectInput) {
  if (ctx.actor.role === "auditor") throw new AccessError("Auditors have read-only access");
  const existing = (await db()`SELECT * FROM ops_projects WHERE id = ${p.id}`)[0];
  const ownerId = await handleToId(p.owner, "owner");
  const companyId = await resolveCompanyId(p.company);
  const clientName = p.client_name ?? (companyId ? (await db()`SELECT name FROM crm_companies WHERE id = ${companyId}`)[0].name : null);
  if (!existing) {
    if (!p.name) throw new InputError("name is required for a new project");
    await db()`
      INSERT INTO ops_projects (id, name, kind, client_name, status, area_slug, owner_id, started_on, due_on, description, created_by, crm_company_id)
      VALUES (${p.id}, ${p.name}, ${p.kind ?? (companyId ? "client_engagement" : "internal")}, ${clientName}, ${p.status ?? "active"},
              ${p.area ?? null}, ${ownerId ?? ctx.actor.id}, ${p.started_on ?? null}, ${p.due_on ?? null},
              ${p.description ?? null}, ${ctx.actor.id}, ${companyId})`;
    return { id: p.id, created: true };
  }
  if (!isManager(ctx) && existing.owner_id !== ctx.actor.id) {
    throw new AccessError(`Only the project owner or an admin can change project ${p.id}`);
  }
  await db()`
    UPDATE ops_projects SET
      name = coalesce(${p.name ?? null}, name), kind = coalesce(${p.kind ?? null}, kind),
      client_name = coalesce(${clientName}, client_name), status = coalesce(${p.status ?? null}, status),
      crm_company_id = coalesce(${companyId}::uuid, crm_company_id),
      area_slug = coalesce(${p.area ?? null}, area_slug), owner_id = coalesce(${ownerId}, owner_id),
      started_on = coalesce(${p.started_on ?? null}::date, started_on), due_on = coalesce(${p.due_on ?? null}::date, due_on),
      completed_on = CASE WHEN ${p.status ?? null} IN ('completed','cancelled') THEN coalesce(${p.completed_on ?? null}::date, current_date)
                          ELSE coalesce(${p.completed_on ?? null}::date, completed_on) END,
      description = coalesce(${p.description ?? null}, description)
    WHERE id = ${p.id}`;
  return { id: p.id, updated: true };
}

export async function listDirectory() {
  const areas = await db()`SELECT a.slug, a.name, o.handle AS owner FROM ops_areas a LEFT JOIN ops_principals o ON o.id = a.owner_id WHERE a.active ORDER BY a.sort_order, a.name`;
  const processes = await db()`SELECT p.id, p.name, p.area_slug, o.handle AS owner FROM ops_processes p LEFT JOIN ops_principals o ON o.id = p.owner_id ORDER BY p.id`;
  const types = await db()`SELECT slug, name, para_default, terminal_statuses FROM ops_record_types ORDER BY slug`;
  return { areas, processes, record_types: types };
}

export async function listPrincipals() {
  return await db()`
    SELECT handle, display_name, kind, role, job_title, can_approve FROM ops_principals WHERE active ORDER BY kind, handle`;
}
