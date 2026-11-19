// CRM: companies, contacts and deals, plus activities (stored as 'activity' records).
//
// Any active principal except auditors can add and update CRM entries; every change is attributed
// and kept in crm_events. Ownership changes are limited to the current owner and managers.
// Decisions stay with people who have approval rights, and the database enforces them:
// clearing or declining a company's screen, and marking a deal won.
import { db } from "./db.ts";
import { AccessError, type Ctx, principalByHandle } from "./auth.ts";
import { InputError } from "./errors.ts";
import { createRecord, listRecords, upsertProject } from "./records.ts";
import { normalizeDomain, normalizeEmail, resolveCompanyId, resolveContactId, resolveDealId } from "./crm_refs.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Tx = any;

export const LIFECYCLES = ["prospect", "lead", "opportunity", "client", "former_client", "partner", "vendor", "disqualified"] as const;
export const SIZE_BANDS = ["1-9", "10-49", "50-99", "100-249", "250-999", "1000+"] as const;
export const ACTIVITY_KINDS = ["call", "email", "meeting", "message", "note"] as const;
export const CONSENT = ["unknown", "opted_in", "opted_out"] as const;

function writer(ctx: Ctx) {
  if (ctx.actor.role === "auditor") throw new AccessError("Auditors have read-only access");
}

function isManager(ctx: Ctx) {
  return ctx.actor.role === "owner" || ctx.actor.role === "admin";
}

function isApprover(ctx: Ctx) {
  return ctx.auth.kind === "human" && ctx.auth.can_approve && ctx.actor.id === ctx.auth.id;
}

async function principalId(handle: string | null | undefined, label: string): Promise<string | null> {
  if (handle === undefined || handle === null || handle === "") return null;
  const p = await principalByHandle(handle);
  if (!p || !p.active) throw new InputError(`Unknown or inactive ${label} "${handle}"`);
  return p.id;
}

async function event(tx: Tx, type: "company" | "contact" | "deal", id: string, ctx: Ctx, action: string, changes: Row = {}, comment: string | null = null) {
  await tx`
    INSERT INTO crm_events (entity_type, entity_id, actor_id, authenticated_as, action, changes, comment)
    VALUES (${type}, ${id}, ${ctx.actor.id}, ${ctx.auth.id}, ${action}, ${tx.json(changes as never)}, ${comment})`;
}

/** Turn database rule violations into errors people can act on. */
function translate(err: unknown): never {
  const e = err as Error & { code?: string };
  if (e.code === "42501") throw new AccessError(e.message);
  if (e.code === "23514") throw new InputError(e.message);
  if (e.code === "23505") throw new InputError(`Already exists: ${e.message}`);
  throw err;
}

const same = (a: unknown, b: unknown) => {
  const n = (x: unknown) => x instanceof Date ? x.toISOString().slice(0, 10) : x === undefined || x === null || x === "" ? null : Array.isArray(x) || typeof x === "object" ? JSON.stringify(x) : String(x);
  return n(a) === n(b);
};

type Plan = { set: Row; changes: Row };

/** Collect the provided fields that differ from the current row. */
function diff(current: Row | null, input: Row, cols: string[]): Plan {
  const set: Row = {};
  const changes: Row = {};
  for (const c of cols) {
    if (input[c] === undefined) continue;
    const v = input[c] === "" ? null : input[c];
    if (current && same(current[c], v)) continue;
    set[c] = v;
    changes[c] = current ? { from: current[c] ?? null, to: v } : v;
  }
  return { set, changes };
}

async function insertRow(tx: Tx, table: string, set: Row): Promise<Row> {
  const cols = Object.keys(set);
  const [row] = await tx.unsafe(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c, i) => cast(c, i + 1)).join(", ")}) RETURNING *`,
    cols.map((c) => param(c, set[c])) as never[],
  );
  return row;
}

async function updateRow(tx: Tx, table: string, id: string, set: Row): Promise<Row> {
  const cols = Object.keys(set);
  const [row] = await tx.unsafe(
    `UPDATE ${table} SET ${cols.map((c, i) => `${c} = ${cast(c, i + 2)}`).join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...cols.map((c) => param(c, set[c]))] as never[],
  );
  return row;
}

const UUID_COLS = new Set(["company_id", "primary_contact_id", "owner_id", "created_by", "updated_by", "authenticated_as", "on_behalf_of", "screened_by"]);
const cast = (col: string, n: number) =>
  col === "fields" ? `$${n}::jsonb` : col === "tags" ? `$${n}::text[]` : UUID_COLS.has(col) ? `$${n}::uuid` : `$${n}`;
const param = (col: string, v: unknown) => (col === "fields" ? JSON.stringify(v ?? {}) : v);

function checkVersion(current: Row, expected?: number) {
  if (expected !== undefined && expected !== current.version) {
    throw new InputError(`Version conflict: you expected version ${expected} but it is at version ${current.version}. Reload and try again.`);
  }
}

function checkOwnerChange(ctx: Ctx, current: Row | null, ownerId: string | null | undefined) {
  if (!current || ownerId === undefined || ownerId === current.owner_id) return;
  if (current.owner_id && current.owner_id !== ctx.actor.id && !isManager(ctx)) {
    throw new AccessError("Only the current owner, an admin or the owner role can reassign this");
  }
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export type CompanyInput = {
  id?: string; name?: string; domain?: string; website?: string; industry?: string; size_band?: string; phone?: string;
  city?: string; region?: string; country?: string; lifecycle?: string; source?: string; owner?: string;
  tags?: string[]; notes?: string; fields?: Row; flag_for_screen?: boolean; screen_note?: string;
  archived?: boolean; expected_version?: number; comment?: string;
};

const COMPANY_COLS = ["name", "domain", "website", "industry", "size_band", "phone", "city", "region", "country", "lifecycle", "source", "owner_id", "tags", "notes", "fields"];

export async function upsertCompany(ctx: Ctx, input: CompanyInput) {
  writer(ctx);
  const domain = input.domain !== undefined ? (input.domain === "" ? "" : normalizeDomain(input.domain) ?? (() => { throw new InputError(`"${input.domain}" is not a domain`); })()) : undefined;
  let current: Row | null = null;
  if (input.id) current = (await db()`SELECT * FROM crm_companies WHERE id = ${await resolveCompanyId(input.id)}`)[0];
  else if (domain) current = (await db()`SELECT * FROM crm_companies WHERE domain = ${domain}`)[0] ?? null;
  let matchedByName = false;
  if (!current && !input.id && input.name && !domain) {
    const byName = await db()`SELECT * FROM crm_companies WHERE lower(name) = lower(${input.name.trim()}) AND archived_at IS NULL`;
    if (byName.length === 1) { current = byName[0]; matchedByName = true; }
  }
  // A name used to find the company is not a rename (keep the stored spelling and casing).
  if (matchedByName) input = { ...input, name: undefined };
  if (current) checkVersion(current, input.expected_version);
  if (!current && !input.name?.trim()) throw new InputError("name is required for a new company");
  if (input.lifecycle && !LIFECYCLES.includes(input.lifecycle as never)) throw new InputError(`lifecycle must be one of ${LIFECYCLES.join(", ")}`);
  const ownerId = input.owner !== undefined ? await principalId(input.owner, "owner") : undefined;
  checkOwnerChange(ctx, current, ownerId);
  const { set, changes } = diff(current, {
    ...input, name: input.name?.trim(), domain, owner_id: ownerId,
    fields: input.fields !== undefined ? { ...(current?.fields ?? {}), ...input.fields } : undefined,
  }, COMPANY_COLS);
  if (input.flag_for_screen && current?.screen_status !== "pending") {
    set.screen_status = "pending";
    set.screen_note = input.screen_note ?? current?.screen_note ?? null;
    changes.screen_status = { from: current?.screen_status ?? null, to: "pending" };
  }
  let action = current ? "update" : "create";
  if (input.archived !== undefined && current && input.archived !== (current.archived_at !== null)) {
    set.archived_at = input.archived ? new Date().toISOString() : null;
    action = input.archived ? "archive" : "unarchive";
  }
  if (current && !Object.keys(set).length) {
    if (input.comment) await commentCrm(ctx, "company", current.id, input.comment);
    return { id: current.id, version: current.version, created: false, changed: false };
  }
  try {
    return await db().begin(async (tx: Tx) => {
      const row = current
        ? await updateRow(tx, "crm_companies", current.id, { ...set, updated_by: ctx.actor.id, authenticated_as: ctx.auth.id })
        : await insertRow(tx, "crm_companies", {
          owner_id: ctx.actor.id, ...set, created_by: ctx.actor.id, updated_by: ctx.actor.id,
          authenticated_as: ctx.auth.id, on_behalf_of: ctx.onBehalfOf,
        });
      await event(tx, "company", row.id, ctx, action, changes, input.comment ?? null);
      return { id: row.id as string, version: row.version as number, created: !current, changed: true, screen_status: row.screen_status };
    });
  } catch (err) {
    translate(err);
  }
}

/** Clear or decline a company's screen (for example the employer-boundary screen). People with approval rights only. */
export async function screenCompany(ctx: Ctx, ref: string, decision: "cleared" | "declined" | "not_needed", note?: string) {
  if (!isApprover(ctx)) throw new AccessError("Screens are decided by a person with approval rights, using their own key (not acting as an agent)");
  const id = await resolveCompanyId(ref);
  const current = (await db()`SELECT * FROM crm_companies WHERE id = ${id}`)[0];
  try {
    return await db().begin(async (tx: Tx) => {
      const row = await updateRow(tx, "crm_companies", id!, {
        screen_status: decision, screen_note: note ?? current.screen_note, screened_by: ctx.auth.id,
        updated_by: ctx.auth.id, authenticated_as: ctx.auth.id,
        ...(decision === "declined" ? { lifecycle: "disqualified" } : {}),
      });
      await event(tx, "company", id!, ctx, "screen", { screen_status: { from: current.screen_status, to: decision } }, note ?? null);
      return { id, screen_status: row.screen_status, screened_at: row.screened_at };
    });
  } catch (err) {
    translate(err);
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export type ContactInput = {
  id?: string; full_name?: string; email?: string; company?: string; job_title?: string; phone?: string; linkedin_url?: string;
  consent?: string; consent_source?: string; do_not_contact?: boolean; owner?: string; tags?: string[]; notes?: string;
  fields?: Row; archived?: boolean; expected_version?: number; comment?: string;
};

const CONTACT_COLS = ["full_name", "email", "company_id", "job_title", "phone", "linkedin_url", "consent", "consent_source", "do_not_contact", "owner_id", "tags", "notes", "fields"];

export async function upsertContact(ctx: Ctx, input: ContactInput) {
  writer(ctx);
  const email = input.email !== undefined ? (input.email === "" ? "" : normalizeEmail(input.email) ?? (() => { throw new InputError(`"${input.email}" is not an email address`); })()) : undefined;
  let current: Row | null = null;
  if (input.id) current = (await db()`SELECT * FROM crm_contacts WHERE id = ${await resolveContactId(input.id)}`)[0];
  else if (email) current = (await db()`SELECT * FROM crm_contacts WHERE lower(email) = ${email}`)[0] ?? null;
  if (current) checkVersion(current, input.expected_version);
  if (!current && !input.full_name?.trim()) throw new InputError("full_name is required for a new contact");
  if (input.consent && !CONSENT.includes(input.consent as never)) throw new InputError(`consent must be one of ${CONSENT.join(", ")}`);
  const ownerId = input.owner !== undefined ? await principalId(input.owner, "owner") : undefined;
  checkOwnerChange(ctx, current, ownerId);
  const companyId = input.company !== undefined ? (input.company === "" ? null : await resolveCompanyId(input.company)) : undefined;
  const { set, changes } = diff(current, {
    ...input, full_name: input.full_name?.trim(), email, owner_id: ownerId, company_id: companyId,
    fields: input.fields !== undefined ? { ...(current?.fields ?? {}), ...input.fields } : undefined,
  }, CONTACT_COLS);
  if (set.consent !== undefined) set.consent_at = new Date().toISOString();
  let action = current ? "update" : "create";
  if (input.archived !== undefined && current && input.archived !== (current.archived_at !== null)) {
    set.archived_at = input.archived ? new Date().toISOString() : null;
    action = input.archived ? "archive" : "unarchive";
  }
  if (current && !Object.keys(set).length) {
    if (input.comment) await commentCrm(ctx, "contact", current.id, input.comment);
    return { id: current.id, version: current.version, created: false, changed: false };
  }
  try {
    return await db().begin(async (tx: Tx) => {
      const row = current
        ? await updateRow(tx, "crm_contacts", current.id, { ...set, updated_by: ctx.actor.id, authenticated_as: ctx.auth.id })
        : await insertRow(tx, "crm_contacts", {
          owner_id: ctx.actor.id, ...set, created_by: ctx.actor.id, updated_by: ctx.actor.id,
          authenticated_as: ctx.auth.id, on_behalf_of: ctx.onBehalfOf,
        });
      await event(tx, "contact", row.id, ctx, action, changes, input.comment ?? null);
      return { id: row.id as string, version: row.version as number, created: !current, changed: true };
    });
  } catch (err) {
    translate(err);
  }
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------
export type DealInput = {
  id?: string; name?: string; company?: string; primary_contact?: string; stage?: string; service_line?: string;
  amount?: number | string | null; recurring_monthly?: number | string | null; currency?: string; probability?: number | null;
  expected_close?: string; source?: string; next_step?: string; next_step_due?: string; lost_reason?: string; project_id?: string;
  owner?: string; tags?: string[]; notes?: string; fields?: Row; archived?: boolean; expected_version?: number; comment?: string;
};

const DEAL_COLS = ["name", "company_id", "primary_contact_id", "stage", "service_line", "amount", "recurring_monthly", "currency", "probability", "expected_close", "source", "next_step", "next_step_due", "lost_reason", "project_id", "owner_id", "tags", "notes", "fields"];

export async function listStages(includeInactive = false) {
  return await db()`
    SELECT slug, name, sort_order, probability, is_won, is_lost, gate_screen, active, description
      FROM crm_pipeline_stages WHERE ${includeInactive} OR active ORDER BY sort_order, slug`;
}

const money = (v: unknown) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new InputError(`"${v}" is not an amount`);
  return n.toFixed(2);
};

export async function upsertDeal(ctx: Ctx, input: DealInput) {
  writer(ctx);
  let current: Row | null = null;
  if (input.id) current = (await db()`SELECT * FROM crm_deals WHERE id = ${await resolveDealId(input.id)}`)[0];
  if (current) checkVersion(current, input.expected_version);
  if (!current && !input.name?.trim()) throw new InputError("name is required for a new deal");
  const companyId = input.company !== undefined ? await resolveCompanyId(input.company) : undefined;
  if (!current && !companyId) throw new InputError("company is required for a new deal");
  const contactId = input.primary_contact !== undefined ? (input.primary_contact === "" ? null : await resolveContactId(input.primary_contact)) : undefined;
  const ownerId = input.owner !== undefined ? await principalId(input.owner, "owner") : undefined;
  checkOwnerChange(ctx, current, ownerId);

  const stages = await listStages(true);
  let stage = input.stage;
  if (!current && !stage) stage = stages.find((s) => s.active && !s.is_won && !s.is_lost)?.slug;
  const target = stage ? stages.find((s) => s.slug === stage) : null;
  if (stage && !target) throw new InputError(`Unknown stage "${stage}". Stages: ${stages.filter((s) => s.active).map((s) => s.slug).join(", ")}`);
  const stageChanges = !!target && target.slug !== current?.stage;
  if (stageChanges && !target!.active) throw new InputError(`Stage "${stage}" is no longer in use`);
  if (stageChanges && target!.is_won && !isApprover(ctx)) {
    throw new AccessError("Marking a deal won is a financial decision: a person with approval rights does it with their own key");
  }
  if (stageChanges && target!.is_lost && !(input.lost_reason ?? current?.lost_reason)) {
    throw new InputError("Give a lost_reason when you close a deal as lost (it feeds the win/loss review)");
  }
  if (input.probability !== undefined && input.probability !== null && (input.probability < 0 || input.probability > 100)) {
    throw new InputError("probability must be between 0 and 100");
  }
  const { set, changes } = diff(current, {
    ...input, name: input.name?.trim(), company_id: companyId, primary_contact_id: contactId, owner_id: ownerId, stage,
    amount: money(input.amount), recurring_monthly: money(input.recurring_monthly),
    currency: input.currency?.toUpperCase(),
    fields: input.fields !== undefined ? { ...(current?.fields ?? {}), ...input.fields } : undefined,
  }, DEAL_COLS);
  let action = current ? (set.stage ? "stage" : "update") : "create";
  if (input.archived !== undefined && current && input.archived !== (current.archived_at !== null)) {
    set.archived_at = input.archived ? new Date().toISOString() : null;
    action = input.archived ? "archive" : "unarchive";
  }
  if (current && !Object.keys(set).length) {
    if (input.comment) await commentCrm(ctx, "deal", current.id, input.comment);
    return { id: current.id, version: current.version, created: false, changed: false, stage: current.stage };
  }
  try {
    return await db().begin(async (tx: Tx) => {
      const row = current
        ? await updateRow(tx, "crm_deals", current.id, { ...set, updated_by: ctx.actor.id, authenticated_as: ctx.auth.id })
        : await insertRow(tx, "crm_deals", {
          owner_id: ctx.actor.id, ...set, created_by: ctx.actor.id, updated_by: ctx.actor.id,
          authenticated_as: ctx.auth.id, on_behalf_of: ctx.onBehalfOf,
        });
      await event(tx, "deal", row.id, ctx, action, changes, input.comment ?? null);
      // Keep the company's lifecycle in step with its deals.
      const st = stages.find((s) => s.slug === row.stage)!;
      const company = (await tx`SELECT id, lifecycle FROM crm_companies WHERE id = ${row.company_id}`)[0];
      const next = st.is_won
        ? (["prospect", "lead", "opportunity", "former_client"].includes(company.lifecycle) ? "client" : null)
        : !st.is_lost && ["prospect", "lead"].includes(company.lifecycle) ? "opportunity" : null;
      if (next) {
        await updateRow(tx, "crm_companies", company.id, { lifecycle: next, updated_by: ctx.actor.id, authenticated_as: ctx.auth.id });
        await event(tx, "company", company.id, ctx, "update", { lifecycle: { from: company.lifecycle, to: next } }, `Deal "${row.name}" is ${st.name}`);
      }
      return { id: row.id as string, version: row.version as number, created: !current, changed: true, stage: row.stage };
    });
  } catch (err) {
    translate(err);
  }
}

/** Create the engagement project for a deal (usually once it is won) and link both ways. */
export async function startEngagement(ctx: Ctx, dealRef: string, projectId: string, opts: { name?: string; area?: string; owner?: string } = {}) {
  writer(ctx);
  const deal = (await db()`SELECT d.*, c.name AS company_name FROM crm_deals d JOIN crm_companies c ON c.id = d.company_id WHERE d.id = ${await resolveDealId(dealRef)}`)[0];
  await upsertProject(ctx, {
    id: projectId, name: opts.name ?? deal.name, kind: "client_engagement", company: deal.company_id,
    area: opts.area, owner: opts.owner,
  });
  await upsertDeal(ctx, { id: deal.id, project_id: projectId, comment: `Engagement ${projectId} started` });
  return { deal: deal.id, project_id: projectId };
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------
export type ActivityInput = {
  kind: string; summary: string; title?: string; occurred_at?: string; direction?: "inbound" | "outbound";
  outcome?: string; company?: string; contact?: string; deal?: string; project_id?: string;
  next_step?: string; next_step_due?: string; visibility?: "company" | "restricted";
};

export async function logActivity(ctx: Ctx, a: ActivityInput) {
  writer(ctx);
  if (!ACTIVITY_KINDS.includes(a.kind as never)) throw new InputError(`kind must be one of ${ACTIVITY_KINDS.join(", ")}`);
  if (!a.company && !a.contact && !a.deal) throw new InputError("Link the activity to a company, contact or deal");
  const occurred = a.occurred_at ? new Date(a.occurred_at) : new Date();
  if (Number.isNaN(occurred.getTime())) throw new InputError(`"${a.occurred_at}" is not a date`);
  const dealId = await resolveDealId(a.deal);
  const contactId = await resolveContactId(a.contact);
  let companyId = await resolveCompanyId(a.company);
  const deal = dealId ? (await db()`SELECT id, name, company_id, project_id FROM crm_deals WHERE id = ${dealId}`)[0] : null;
  const contact = contactId ? (await db()`SELECT id, full_name, company_id FROM crm_contacts WHERE id = ${contactId}`)[0] : null;
  companyId ??= deal?.company_id ?? contact?.company_id ?? null;
  const company = companyId ? (await db()`SELECT id, name FROM crm_companies WHERE id = ${companyId}`)[0] : null;
  const label = { call: "Call", email: "Email", meeting: "Meeting", message: "Message", note: "Note" }[a.kind as typeof ACTIVITY_KINDS[number]];
  const title = a.title?.trim() || `${label} with ${contact?.full_name ?? company?.name ?? deal?.name}`;
  const r = await createRecord(ctx, {
    record_type: "activity", title, content: a.summary, status: "logged",
    project_id: a.project_id ?? deal?.project_id ?? undefined, visibility: a.visibility,
    company: companyId ?? undefined, contact: contactId ?? undefined, deal: dealId ?? undefined,
    fields: { kind: a.kind, direction: a.direction ?? null, occurred_at: occurred.toISOString(), outcome: a.outcome ?? null },
  });
  const ts = occurred.toISOString();
  for (const [table, id] of [["crm_companies", companyId], ["crm_contacts", contactId], ["crm_deals", dealId]] as const) {
    if (id) await db().unsafe(`UPDATE ${table} SET last_activity_at = GREATEST(coalesce(last_activity_at, $2::timestamptz), $2::timestamptz) WHERE id = $1`, [id, ts]);
  }
  if (dealId && (a.next_step !== undefined || a.next_step_due !== undefined)) {
    await upsertDeal(ctx, { id: dealId, next_step: a.next_step, next_step_due: a.next_step_due });
  }
  return { id: r.id, title, company_id: companyId, contact_id: contactId, deal_id: dealId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export async function commentCrm(ctx: Ctx, type: "company" | "contact" | "deal", id: string, comment: string) {
  if (!comment.trim()) throw new InputError("comment is required");
  await db().begin(async (tx: Tx) => { await event(tx, type, id, ctx, "comment", {}, comment.trim()); });
  return { id, commented: true };
}

export async function crmHistory(type: "company" | "contact" | "deal", id: string, limit = 30) {
  return await db()`
    SELECT e.created_at, a.handle AS actor, au.handle AS authenticated_as, e.action, e.changes, e.comment
      FROM crm_events e
      LEFT JOIN ops_principals a ON a.id = e.actor_id
      LEFT JOIN ops_principals au ON au.id = e.authenticated_as
     WHERE e.entity_type = ${type} AND e.entity_id = ${id}
     ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`;
}

const COMPANY_SELECT = `
  SELECT c.*, o.handle AS owner, cb.handle AS created_by_handle, ub.handle AS updated_by_handle, sb.handle AS screened_by_handle,
         (SELECT count(*)::int FROM crm_deals d JOIN crm_pipeline_stages s ON s.slug = d.stage
           WHERE d.company_id = c.id AND d.archived_at IS NULL AND NOT s.is_won AND NOT s.is_lost) AS open_deals
    FROM crm_companies c
    LEFT JOIN ops_principals o ON o.id = c.owner_id
    LEFT JOIN ops_principals cb ON cb.id = c.created_by
    LEFT JOIN ops_principals ub ON ub.id = c.updated_by
    LEFT JOIN ops_principals sb ON sb.id = c.screened_by`;

const CONTACT_SELECT = `
  SELECT ct.*, c.name AS company_name, o.handle AS owner, cb.handle AS created_by_handle, ub.handle AS updated_by_handle
    FROM crm_contacts ct
    LEFT JOIN crm_companies c ON c.id = ct.company_id
    LEFT JOIN ops_principals o ON o.id = ct.owner_id
    LEFT JOIN ops_principals cb ON cb.id = ct.created_by
    LEFT JOIN ops_principals ub ON ub.id = ct.updated_by`;

/** Records linked to a CRM entity that the caller can read, newest first. */
async function linkedRecords(ctx: Ctx, filter: { company?: string; contact?: string; deal?: string }, limit = 50) {
  return await listRecords(ctx, { ...filter, include_archived: true, limit });
}

export async function getCompany(ctx: Ctx, ref: string): Promise<Row> {
  const id = await resolveCompanyId(ref);
  const [company] = await db().unsafe(`${COMPANY_SELECT} WHERE c.id = $1`, [id]);
  const contacts = await db().unsafe(`${CONTACT_SELECT} WHERE ct.company_id = $1 ORDER BY ct.archived_at NULLS FIRST, ct.full_name`, [id]);
  const deals = await db()`SELECT * FROM crm_deals_view WHERE company_id = ${id} ORDER BY is_won OR is_lost, stage_order, updated_at DESC`;
  const projects = await db()`SELECT id, name, status, kind FROM ops_projects WHERE crm_company_id = ${id} ORDER BY id`;
  const records = await linkedRecords(ctx, { company: id! });
  return { ...company, contacts, deals, projects, records, history: await crmHistory("company", id!) };
}

export async function getContact(ctx: Ctx, ref: string): Promise<Row> {
  const id = await resolveContactId(ref);
  const [contact] = await db().unsafe(`${CONTACT_SELECT} WHERE ct.id = $1`, [id]);
  const deals = await db()`SELECT * FROM crm_deals_view WHERE primary_contact_id = ${id} ORDER BY updated_at DESC`;
  const records = await linkedRecords(ctx, { contact: id! });
  return { ...contact, deals, records, history: await crmHistory("contact", id!) };
}

export async function getDeal(ctx: Ctx, ref: string): Promise<Row> {
  const id = await resolveDealId(ref);
  const [deal] = await db()`SELECT * FROM crm_deals_view WHERE id = ${id}`;
  const records = await linkedRecords(ctx, { deal: id! });
  return { ...deal, records, history: await crmHistory("deal", id!) };
}

export type CrmListFilters = { q?: string; lifecycle?: string; owner?: string; company?: string; stage?: string; include_archived?: boolean; limit?: number; offset?: number };

function page(f: CrmListFilters) {
  return { limit: Math.min(Math.max(f.limit ?? 50, 1), 200), offset: Math.max(f.offset ?? 0, 0) };
}

export async function listCompanies(f: CrmListFilters = {}) {
  const where = ["TRUE"]; const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (!f.include_archived) where.push("c.archived_at IS NULL");
  if (f.q) add("(c.name ILIKE '%' || ? || '%' OR c.domain ILIKE '%' || ? || '%' OR c.industry ILIKE '%' || ? || '%')", f.q);
  if (f.lifecycle) add("c.lifecycle = ?", f.lifecycle);
  if (f.owner) add("o.handle = ?", f.owner);
  const { limit, offset } = page(f);
  return await db().unsafe(`${COMPANY_SELECT} WHERE ${where.join(" AND ")} ORDER BY lower(c.name) LIMIT ${limit} OFFSET ${offset}`, params as never[]);
}

export async function listContacts(f: CrmListFilters = {}) {
  const where = ["TRUE"]; const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (!f.include_archived) where.push("ct.archived_at IS NULL");
  if (f.q) add("(ct.full_name ILIKE '%' || ? || '%' OR ct.email ILIKE '%' || ? || '%' OR ct.job_title ILIKE '%' || ? || '%' OR c.name ILIKE '%' || ? || '%')", f.q);
  if (f.company) add("ct.company_id = ?::uuid", await resolveCompanyId(f.company));
  if (f.owner) add("o.handle = ?", f.owner);
  const { limit, offset } = page(f);
  return await db().unsafe(`${CONTACT_SELECT} WHERE ${where.join(" AND ")} ORDER BY lower(ct.full_name) LIMIT ${limit} OFFSET ${offset}`, params as never[]);
}

export async function listDeals(f: CrmListFilters & { open?: boolean } = {}) {
  const where = ["TRUE"]; const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (!f.include_archived) where.push("archived_at IS NULL");
  if (f.open) where.push("NOT is_won AND NOT is_lost");
  if (f.q) add("(name ILIKE '%' || ? || '%' OR company_name ILIKE '%' || ? || '%')", f.q);
  if (f.stage) add("stage = ?", f.stage);
  if (f.company) add("company_id = ?::uuid", await resolveCompanyId(f.company));
  if (f.owner) add("owner = ?", f.owner);
  const { limit, offset } = page(f);
  return await db().unsafe(`SELECT * FROM crm_deals_view WHERE ${where.join(" AND ")} ORDER BY stage_order, updated_at DESC LIMIT ${limit} OFFSET ${offset}`, params as never[]);
}

export async function searchCrm(query: string, type?: "company" | "contact" | "deal", includeArchived = false) {
  const q = query.trim();
  if (!q) throw new InputError("query is required");
  const out: Row = {};
  if (!type || type === "company") out.companies = await listCompanies({ q, include_archived: includeArchived, limit: 20 });
  if (!type || type === "contact") out.contacts = await listContacts({ q, include_archived: includeArchived, limit: 20 });
  if (!type || type === "deal") out.deals = await listDeals({ q, include_archived: includeArchived, limit: 20 });
  return out;
}

export type PipelineFilters = { owner?: string; service_line?: string; closed_days?: number; stale_days?: number };

/** Open deals by stage with totals and a weighted forecast, recently closed deals, and deals that need attention. */
export async function pipeline(f: PipelineFilters = {}) {
  const closedDays = f.closed_days ?? 30;
  const staleDays = f.stale_days ?? 14;
  const allStages = await listStages(true);
  const deals = await db()`
    SELECT * FROM crm_deals_view
     WHERE archived_at IS NULL
       AND (${f.owner ?? null}::text IS NULL OR owner = ${f.owner ?? null})
       AND (${f.service_line ?? null}::text IS NULL OR service_line = ${f.service_line ?? null})
       AND (NOT (is_won OR is_lost) OR closed_at >= now() - make_interval(days => ${closedDays}))
     ORDER BY stage_order, expected_close NULLS LAST, updated_at DESC`;
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  // Retired stages stay on the board while deals are still in them, so nothing disappears.
  const stages = allStages.filter((s) => s.active || deals.some((d) => d.stage === s.slug));
  const columns = stages.map((s) => {
    const ds = deals.filter((d) => d.stage === s.slug);
    return {
      ...s,
      deals: ds,
      count: ds.length,
      amount: ds.reduce((t, d) => t + num(d.amount), 0),
      weighted: ds.reduce((t, d) => t + num(d.amount) * num(d.probability) / 100, 0),
      recurring_monthly: ds.reduce((t, d) => t + num(d.recurring_monthly), 0),
    };
  });
  const open = deals.filter((d) => !d.is_won && !d.is_lost);
  const now = Date.now();
  const stale = open.filter((d) => now - new Date(d.last_activity_at ?? d.created_at).getTime() > staleDays * 86_400_000);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = open.filter((d) => d.next_step_due && new Date(d.next_step_due).toISOString().slice(0, 10) < today);
  const screens = await db()`SELECT id, name, screen_note, updated_at FROM crm_companies WHERE screen_status = 'pending' AND archived_at IS NULL ORDER BY updated_at`;
  return {
    stages: columns,
    totals: {
      open_count: open.length,
      open_amount: open.reduce((t, d) => t + num(d.amount), 0),
      weighted: open.reduce((t, d) => t + num(d.amount) * num(d.probability) / 100, 0),
      open_recurring_monthly: open.reduce((t, d) => t + num(d.recurring_monthly), 0),
      won_recent: deals.filter((d) => d.is_won).length,
      lost_recent: deals.filter((d) => d.is_lost).length,
    },
    attention: {
      stale: stale.map((d) => ({ id: d.id, name: d.name, company_name: d.company_name, last_activity_at: d.last_activity_at, owner: d.owner })),
      overdue_next_steps: overdue.map((d) => ({ id: d.id, name: d.name, next_step: d.next_step, next_step_due: d.next_step_due, owner: d.owner })),
      screens_pending: screens,
    },
    closed_days: closedDays,
    stale_days: staleDays,
  };
}

/** Seed or replace pipeline stages (used by the admin seed). Stages not listed are deactivated, never deleted. */
export async function seedStages(stages: { slug: string; name: string; probability?: number; is_won?: boolean; is_lost?: boolean; gate_screen?: boolean; description?: string }[]) {
  await db().begin(async (tx: Tx) => {
    let order = 10;
    for (const s of stages) {
      await tx`
        INSERT INTO crm_pipeline_stages (slug, name, sort_order, probability, is_won, is_lost, gate_screen, active, description)
        VALUES (${s.slug}, ${s.name}, ${order}, ${s.probability ?? 0}, ${s.is_won ?? false}, ${s.is_lost ?? false},
                ${s.gate_screen ?? false}, true, ${s.description ?? null})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, probability = EXCLUDED.probability,
          is_won = EXCLUDED.is_won, is_lost = EXCLUDED.is_lost, gate_screen = EXCLUDED.gate_screen, active = true,
          description = EXCLUDED.description`;
      order += 10;
    }
    await tx`UPDATE crm_pipeline_stages SET active = false WHERE slug <> ALL(${stages.map((s) => s.slug)}::text[])`;
  });
}
