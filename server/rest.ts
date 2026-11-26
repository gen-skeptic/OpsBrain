// The Open Brain REST API (the contract of OB1's integrations/open-brain-rest), served by OpsBrain at
// /open-brain-rest so the Open Brain dashboard (dashboard/) runs on OpsBrain unchanged.
//
// It is a view of OpsBrain's records, not a second store:
// - Callers send their own OpsBrain key in x-brain-key. Only people may use it; agents use MCP.
// - Everything goes through ops_can_read, and writes go through records.ts, so they are attributed,
//   versioned and logged in ops_record_events like any other change.
// - Open Brain fields map onto OpsBrain records: a note keeps its Open Brain type in fields.thought_type;
//   task cards appear as "task", kaizen cards as "idea", meeting notes as "meeting", and so on.
//   Importance and quality live in fields; "restricted" is OpsBrain's restricted visibility.
// - Deleting archives the record (OpsBrain never loses history). Archived records show as status "archived".
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { embed } from "./ai.ts";
import { AccessError, authenticate, type Ctx, resolveCtx } from "./auth.ts";
import { config } from "./config.ts";
import { db, vectorLiteral } from "./db.ts";
import { InputError } from "./errors.ts";
import { createRecord, loadReadable, updateRecord, type UpdateInput } from "./records.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const READ = `ops_can_read($1, t.visibility, t.owner_id, t.assignee_id, t.created_by, t.allowed_principals)`;
const num = (expr: string) => `CASE WHEN (${expr}) ~ '^[0-9]+(\\.[0-9]+)?$' THEN least(100, (${expr})::numeric) END`;

/** Open Brain type of an OpsBrain record. */
const TYPE_SQL = `CASE t.record_type
  WHEN 'note' THEN coalesce(nullif(t.fields->>'thought_type', ''), nullif(t.metadata->>'type', ''), 'observation')
  WHEN 'task_card' THEN 'task' WHEN 'kaizen_card' THEN 'idea' WHEN 'meeting_note' THEN 'meeting'
  WHEN 'retrospective' THEN 'lesson' WHEN 'decision' THEN 'decision'
  WHEN 'research' THEN 'reference' WHEN 'reference' THEN 'reference' WHEN 'playbook' THEN 'reference'
  WHEN 'sop' THEN 'reference' WHEN 'template' THEN 'reference' WHEN 'policy' THEN 'reference'
  ELSE t.record_type END`;

/** Open Brain workflow status. Task cards keep OpsBrain's own statuses underneath. */
const STATUS_SQL = `CASE WHEN t.archived_at IS NOT NULL THEN 'archived'
  WHEN t.record_type = 'task_card' THEN CASE coalesce(t.status, 'ready')
    WHEN 'ready' THEN 'new' WHEN 'blocked' THEN 'planning' WHEN 'planning' THEN 'planning'
    WHEN 'in_progress' THEN 'active' WHEN 'changes_requested' THEN 'active' WHEN 'ready_for_qa' THEN 'review'
    WHEN 'done' THEN 'done' WHEN 'cancelled' THEN 'archived' ELSE t.status END
  WHEN t.record_type = 'kaizen_card' THEN CASE coalesce(t.status, 'new') WHEN 'declined' THEN 'archived' ELSE coalesce(t.status, 'new') END
  ELSE t.status END`;

const QUALITY_SQL = `coalesce(${num("t.fields->>'quality_score'")}, greatest(0, least(100, 30
  + CASE WHEN length(t.content) >= 200 THEN 25 WHEN length(t.content) >= 80 THEN 15 WHEN length(t.content) >= 40 THEN 5 ELSE -20 END
  + CASE WHEN t.title IS NOT NULL THEN 15 ELSE 0 END
  + CASE WHEN cardinality(t.tags) > 0 OR jsonb_typeof(t.metadata->'extracted'->'topics') = 'array' THEN 10 ELSE 0 END
  + CASE WHEN t.embedding IS NOT NULL THEN 15 ELSE -15 END
  + CASE WHEN t.record_type <> 'note' THEN 10 ELSE 0 END)))`;

const NORMALIZED = `
  t.id, t.content, t.metadata, t.fields, t.record_type, t.title, t.tags, t.visibility, t.priority, t.archived_at,
  t.created_at, t.updated_at, cb.handle AS created_by,
  ${TYPE_SQL} AS type,
  coalesce(nullif(t.fields->>'source', ''), nullif(t.metadata->>'source_type', ''), nullif(t.metadata->>'source', ''),
           CASE WHEN cb.kind IS NULL THEN 'open_brain' WHEN cb.kind = 'human' THEN 'opsbrain' ELSE 'agent' END) AS source_type,
  coalesce(${num("t.fields->>'importance'")}, ${num("t.metadata->>'importance'")},
           CASE t.priority WHEN 'high' THEN 70 WHEN 'low' THEN 20 ELSE 50 END)::float AS importance,
  ${QUALITY_SQL}::float AS quality_score,
  CASE WHEN t.visibility = 'restricted' THEN 'restricted' ELSE 'standard' END AS sensitivity_tier,
  ${STATUS_SQL} AS status,
  CASE WHEN t.fields->>'status_updated_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (t.fields->>'status_updated_at')::timestamptz ELSE t.updated_at END AS status_updated_at`;

const FROM = `FROM thoughts t LEFT JOIN ops_principals cb ON cb.id = t.created_by WHERE ${READ}`;

const SORTS = new Set(["created_at", "updated_at", "importance", "quality_score", "type", "source_type", "status"]);
/** Open Brain kanban status → OpsBrain task card status. */
const TASK_STATUS_OUT: Record<string, string> = { new: "ready", planning: "planning", active: "in_progress", review: "ready_for_qa", done: "done" };

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((s) => s.trim()) : [];
}

/** The record as an Open Brain thought. */
function thought(r: Row, extra: Row = {}): Row {
  const meta: Row = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
  const ex: Row = meta.extracted && typeof meta.extracted === "object" ? meta.extracted : {};
  const topics = [...new Set([...list(meta.topics), ...list(ex.topics), ...list(r.tags)])];
  const { extracted: _e, ...rest } = meta;
  return {
    id: r.id,
    uuid: r.id,
    content: r.content,
    type: r.type,
    source_type: r.source_type,
    importance: Number(r.importance),
    quality_score: Number(r.quality_score),
    sensitivity_tier: r.sensitivity_tier,
    metadata: {
      ...rest,
      type: r.type,
      source: r.source_type,
      topics,
      people: [...new Set([...list(meta.people), ...list(ex.people)])],
      action_items: [...new Set([...list(meta.action_items), ...list(ex.action_items)])],
      dates_mentioned: [...new Set([...list(meta.dates_mentioned), ...list(ex.dates_mentioned)])],
      record_type: r.record_type,
      ...(r.title ? { title: r.title } : {}),
      ...(r.created_by ? { created_by: r.created_by } : {}),
      opsbrain_url: `${config.publicUrl}/records/${r.id}`,
    },
    created_at: r.created_at,
    updated_at: r.updated_at ?? r.created_at,
    status: r.status ?? null,
    status_updated_at: r.status ? r.status_updated_at : null,
    ...extra,
  };
}

function intParam(v: string | null | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** The OB1 fallback classifier, used when no type is given (no text leaves the server). */
export function guessType(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(todo|to do|next step|ship|implement|fix|review|publish|follow up)\b/.test(lower)) return "task";
  if (/\b(decided|decision|we will|agreed)\b/.test(lower)) return "decision";
  if (/\b(idea|what if|could we|maybe we)\b/.test(lower)) return "idea";
  if (/\b(learned|lesson|takeaway|next time)\b/.test(lower)) return "lesson";
  if (/\b(recipe|docs|reference|guide|https?:\/\/)\b/.test(lower)) return "reference";
  return "observation";
}

const priorityFor = (importance: number) => (importance >= 60 ? "high" : importance >= 30 ? "normal" : "low");

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listThoughts(ctx: Ctx, url: URL) {
  const q = url.searchParams;
  const page = intParam(q.get("page"), 1, 1, 100_000);
  const perPage = intParam(q.get("per_page"), 25, 1, 100);
  const params: unknown[] = [ctx.actor.id];
  const where: string[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replaceAll("?", `$${params.length}`));
  };
  const statuses = (q.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!statuses.includes("archived")) where.push("archived_at IS NULL");
  if (statuses.length) add("status = ANY(?::text[])", statuses);
  if (q.get("exclude_restricted") !== "false") where.push("sensitivity_tier <> 'restricted'");
  if (q.get("type")) add("type = ?", q.get("type"));
  if (q.get("source_type")) add("source_type = ?", q.get("source_type"));
  if (q.get("importance_min") !== null && q.get("importance_min") !== "") add("importance >= ?::float", Number(q.get("importance_min")) || 0);
  if (q.get("quality_score_max") !== null && q.get("quality_score_max") !== "") add("quality_score <= ?::float", Number(q.get("quality_score_max")) || 0);
  const sort = SORTS.has(q.get("sort") ?? "") ? q.get("sort")! : "created_at";
  const order = q.get("order") === "asc" ? "ASC" : "DESC";
  const rows = await db().unsafe(
    `WITH v AS (SELECT ${NORMALIZED} ${FROM})
     SELECT *, count(*) OVER ()::int AS total_count FROM v ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${sort} ${order} NULLS LAST, id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
    params as never[],
  );
  return { data: rows.map((r) => thought(r)), total: rows[0]?.total_count ?? 0, page, per_page: perPage };
}

async function oneThought(ctx: Ctx, id: string): Promise<Row | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db().unsafe(`SELECT ${NORMALIZED} ${FROM} AND t.id = $2`, [ctx.actor.id, id]);
  return rows[0] ?? null;
}

async function byIds(ctx: Ctx, ids: string[]): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const rows = await db().unsafe(`SELECT ${NORMALIZED} ${FROM} AND t.id = ANY($2::uuid[])`, [ctx.actor.id, ids]);
  return new Map(rows.map((r) => [r.id as string, r]));
}

async function stats(ctx: Ctx, url: URL) {
  const days = intParam(url.searchParams.get("days"), 0, 0, 3650);
  const exclude = url.searchParams.get("exclude_restricted") !== "false";
  const where = [
    "archived_at IS NULL",
    ...(exclude ? ["sensitivity_tier <> 'restricted'"] : []),
    ...(days ? [`created_at > now() - make_interval(days => ${days})`] : []),
  ].join(" AND ");
  const base = `WITH v AS (SELECT ${NORMALIZED} ${FROM}) `;
  const [{ total }] = await db().unsafe(`${base} SELECT count(*)::int AS total FROM v WHERE ${where}`, [ctx.actor.id]);
  const types = await db().unsafe(`${base} SELECT type, count(*)::int AS n FROM v WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, [ctx.actor.id]);
  const topics = await db().unsafe(
    `${base}, x AS (
       SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(metadata->'topics') = 'array' THEN metadata->'topics' ELSE '[]'::jsonb END) AS topic FROM v WHERE ${where}
       UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(metadata->'extracted'->'topics') = 'array' THEN metadata->'extracted'->'topics' ELSE '[]'::jsonb END) FROM v WHERE ${where}
       UNION ALL SELECT unnest(tags) FROM v WHERE ${where})
     SELECT topic, count(*)::int AS count FROM x WHERE length(trim(topic)) > 0 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`,
    [ctx.actor.id],
  );
  return { total_thoughts: total, window_days: days || "all", types: Object.fromEntries(types.map((t) => [t.type, t.n])), top_topics: topics };
}

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  mode: z.enum(["semantic", "text"]).default("semantic"),
  limit: z.number().int().min(1).max(100).default(25),
  page: z.number().int().min(1).default(1),
  threshold: z.number().min(0).max(1).default(0.35),
  exclude_restricted: z.boolean().default(true),
});

async function search(ctx: Ctx, body: z.infer<typeof searchSchema>) {
  const offset = (body.page - 1) * body.limit;
  const page = (results: Row[], total: number, mode: string) => ({
    results, count: results.length, total, page: body.page, per_page: body.limit, total_pages: Math.max(1, Math.ceil(total / body.limit)), mode,
  });
  if (body.mode === "semantic") {
    const v = await embed(body.query);
    if (v) {
      const matches = await db()`
        SELECT id, similarity FROM ops_match_records(${ctx.actor.id}, ${vectorLiteral(v)}::vector, ${body.threshold},
                                                     ${Math.min(300, body.limit * body.page * 3)}, ${db().json({})})`;
      const rows = await byIds(ctx, matches.map((m) => m.id as string));
      const ordered = matches
        .map((m) => rows.get(m.id as string) && { row: rows.get(m.id as string)!, similarity: Number(m.similarity) })
        .filter((x): x is { row: Row; similarity: number } => !!x && (!body.exclude_restricted || x.row.sensitivity_tier !== "restricted"))
        .map((x, i) => thought(x.row, { similarity: x.similarity, rank: i + 1 }));
      if (ordered.length) return page(ordered.slice(offset, offset + body.limit), ordered.length, "semantic");
    }
  }
  // Keyword search: asked for, or when embeddings are off, unavailable or found nothing (as OpsBrain's own search does).
  const restricted = body.exclude_restricted ? "AND sensitivity_tier <> 'restricted'" : "";
  const rows = await db().unsafe(
    `WITH v AS (SELECT ${NORMALIZED}, ts_rank(to_tsvector('english', coalesce(t.title, '') || ' ' || t.content), websearch_to_tsquery('english', $2)) AS rank_score ${FROM}
                  AND t.archived_at IS NULL
                  AND (to_tsvector('english', coalesce(t.title, '') || ' ' || t.content) @@ websearch_to_tsquery('english', $2)
                       OR (coalesce(t.title, '') || ' ' || t.content) ILIKE '%' || $2 || '%'))
     SELECT *, count(*) OVER ()::int AS total_count FROM v WHERE true ${restricted}
      ORDER BY rank_score DESC, created_at DESC LIMIT ${body.limit} OFFSET ${offset}`,
    [ctx.actor.id, body.query],
  );
  return page(rows.map((r, i) => thought(r, { rank: offset + i + 1 })), rows[0]?.total_count ?? 0, "text");
}

async function duplicates(ctx: Ctx, url: URL) {
  const threshold = Math.min(1, Math.max(0.5, Number(url.searchParams.get("threshold") ?? 0.85) || 0.85));
  const limit = intParam(url.searchParams.get("limit"), 50, 1, 100);
  const offset = intParam(url.searchParams.get("offset"), 0, 0, 10_000);
  const pairs = await db().unsafe(
    `WITH recent AS (
       SELECT t.id, t.embedding, t.content FROM thoughts t
        WHERE t.archived_at IS NULL AND t.visibility <> 'restricted' AND ${READ}
        ORDER BY t.created_at DESC LIMIT 400
     ), near AS (
       SELECT least(r.id, n.id) AS a, greatest(r.id, n.id) AS b, n.similarity
         FROM recent r
         CROSS JOIN LATERAL (
           SELECT o.id, 1 - (o.embedding <=> r.embedding) AS similarity FROM thoughts o
            WHERE r.embedding IS NOT NULL AND o.id <> r.id AND o.embedding IS NOT NULL AND o.archived_at IS NULL AND o.visibility <> 'restricted'
              AND ops_can_read($1, o.visibility, o.owner_id, o.assignee_id, o.created_by, o.allowed_principals)
            ORDER BY o.embedding <=> r.embedding LIMIT 3) n
        WHERE n.similarity >= $2
       UNION ALL
       SELECT least(x.id, y.id), greatest(x.id, y.id), 1.0 FROM recent x JOIN recent y
           ON x.id < y.id AND lower(regexp_replace(x.content, '\\s+', ' ', 'g')) = lower(regexp_replace(y.content, '\\s+', ' ', 'g'))
     )
     SELECT a, b, max(similarity)::float AS similarity FROM near GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`,
    [ctx.actor.id, threshold],
  );
  const page = pairs.slice(offset, offset + limit);
  const rows = await byIds(ctx, page.flatMap((p) => [p.a as string, p.b as string]));
  const out = page
    .map((p) => {
      const a = rows.get(p.a as string);
      const b = rows.get(p.b as string);
      if (!a || !b) return null;
      return {
        thought_id_a: a.id, thought_id_b: b.id, similarity: Number(p.similarity),
        content_a: a.content, content_b: b.content, type_a: a.type, type_b: b.type,
        quality_a: Number(a.quality_score), quality_b: Number(b.quality_score), created_a: a.created_at, created_b: b.created_at,
      };
    })
    .filter(Boolean);
  return { pairs: out, threshold, limit, offset };
}

async function connections(ctx: Ctx, id: string, url: URL) {
  const limit = intParam(url.searchParams.get("limit"), 20, 1, 50);
  const exclude = url.searchParams.get("exclude_restricted") !== "false";
  const source = await oneThought(ctx, id);
  if (!source) return [];
  const near = await db().unsafe(
    `SELECT o.id, 1 - (o.embedding <=> r.embedding) AS similarity
       FROM thoughts r JOIN thoughts o ON o.id <> r.id AND o.embedding IS NOT NULL AND o.archived_at IS NULL
      WHERE r.id = $2 AND r.embedding IS NOT NULL
        AND ops_can_read($1, o.visibility, o.owner_id, o.assignee_id, o.created_by, o.allowed_principals)
        ${exclude ? "AND o.visibility <> 'restricted'" : ""}
      ORDER BY o.embedding <=> r.embedding LIMIT $3`,
    [ctx.actor.id, id, limit],
  );
  const rows = await byIds(ctx, near.map((n) => n.id as string));
  const src = thought(source).metadata;
  return near
    .filter((n) => Number(n.similarity) > 0.25 && rows.has(n.id as string))
    .map((n) => {
      const t = thought(rows.get(n.id as string)!);
      const sharedTopics = (t.metadata.topics as string[]).filter((x) => (src.topics as string[]).includes(x));
      const sharedPeople = (t.metadata.people as string[]).filter((x) => (src.people as string[]).includes(x));
      return {
        id: t.id, type: t.type, importance: t.importance, preview: String(t.content).slice(0, 200), content: t.content,
        created_at: t.created_at, similarity: Number(n.similarity), metadata: { topics: t.metadata.topics, people: t.metadata.people },
        shared_topics: sharedTopics, shared_people: sharedPeople, overlap_count: sharedTopics.length + sharedPeople.length,
      };
    });
}

// ---------------------------------------------------------------------------
// Writes (attributed through records.ts)
// ---------------------------------------------------------------------------

const captureSchema = z.object({
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  type: z.string().max(40).optional(),
  source_type: z.string().max(60).optional(),
  importance: z.number().min(0).max(100).optional(),
  quality_score: z.number().min(0).max(100).optional(),
  sensitivity_tier: z.string().max(40).optional(),
  status: z.string().max(40).nullable().optional(),
});

async function capture(ctx: Ctx, body: z.infer<typeof captureSchema>) {
  const content = body.content.trim();
  if (!content) throw new InputError("content is required");
  const existing = await db().unsafe(
    `SELECT t.id FROM thoughts t WHERE ${READ} AND t.archived_at IS NULL AND t.content = $2 LIMIT 1`,
    [ctx.actor.id, content],
  );
  const type = body.type || (typeof body.metadata?.type === "string" ? body.metadata.type : "") || guessType(content);
  const restricted = body.sensitivity_tier === "restricted";
  if (existing.length) {
    return { thought_id: existing[0].id, action: "existing", type, sensitivity_tier: restricted ? "restricted" : "standard", content_fingerprint: "", message: "Already captured" };
  }
  const importance = body.importance ?? 50;
  const status = body.status !== undefined ? body.status : ["task", "idea"].includes(type) ? "new" : null;
  const source = body.source_type || "dashboard";
  const { type: _t, ...metadata } = body.metadata ?? {};
  const r = await createRecord(ctx, {
    record_type: "note",
    content,
    status: status ?? undefined,
    priority: priorityFor(importance),
    visibility: restricted ? "restricted" : "company",
    fields: {
      thought_type: type,
      importance,
      source,
      ...(body.quality_score !== undefined ? { quality_score: body.quality_score } : {}),
      ...(status ? { status_updated_at: new Date().toISOString() } : {}),
    },
    metadata: { ...metadata, source_type: source },
  });
  return { thought_id: r.id, action: "created", type, sensitivity_tier: restricted ? "restricted" : "standard", content_fingerprint: "", message: "Thought captured" };
}

const updateSchema = z.object({
  content: z.string().min(1).optional(),
  type: z.string().max(40).optional(),
  importance: z.number().min(0).max(100).optional(),
  quality_score: z.number().min(0).max(100).optional(),
  sensitivity_tier: z.string().max(40).optional(),
  status: z.string().max(40).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

async function update(ctx: Ctx, id: string, body: z.infer<typeof updateSchema>) {
  const current = await oneThought(ctx, id);
  if (!current) throw new AccessError("Thought not found");
  const input: UpdateInput = {};
  const fields: Row = {};
  if (body.content !== undefined) input.content = body.content;
  if (body.type !== undefined && body.type !== current.type) {
    if (current.record_type !== "note") throw new InputError(`This is an OpsBrain ${current.record_type.replaceAll("_", " ")}; change its type in OpsBrain.`);
    fields.thought_type = body.type;
  }
  if (body.importance !== undefined) {
    fields.importance = body.importance;
    input.priority = priorityFor(body.importance);
  }
  if (body.quality_score !== undefined) fields.quality_score = body.quality_score;
  if (body.sensitivity_tier !== undefined) input.visibility = body.sensitivity_tier === "restricted" ? "restricted" : "company";
  if (body.status !== undefined && body.status !== current.status) {
    if (body.status === "archived") input.archived = true;
    else {
      if (current.archived_at) input.archived = false;
      input.status = body.status === null ? "" : current.record_type === "task_card" ? (TASK_STATUS_OUT[body.status] ?? body.status) : body.status;
      fields.status_updated_at = new Date().toISOString();
    }
  }
  if (Object.keys(fields).length) input.fields = fields;
  await updateRecord(ctx, current.id, input);
  return { id: current.id, action: "updated", message: "Thought updated" };
}

/** Open Brain deletes; OpsBrain archives, so the record and its history are kept. */
async function remove(ctx: Ctx, id: string) {
  const current = await oneThought(ctx, id);
  if (!current) throw new AccessError("Thought not found");
  if (!current.archived_at) await updateRecord(ctx, current.id, { archived: true, comment: "Deleted in the dashboard (archived; the record and its history are kept)." });
  return { id: current.id, action: "deleted", message: "Thought archived" };
}

const reflectionSchema = z.object({
  trigger_context: z.string().max(4000).optional().default(""),
  options: z.array(z.unknown()).max(50).optional().default([]),
  factors: z.array(z.unknown()).max(50).optional().default([]),
  conclusion: z.string().max(20000).optional().default(""),
  confidence: z.number().min(0).max(1).optional().default(0.75),
  reflection_type: z.string().max(60).optional().default("reflection"),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

async function reflections(ctx: Ctx, id: string) {
  const r = await loadReadable(ctx, id);
  return await db()`
    SELECT id, record_id AS thought_id, trigger_context, options, factors, conclusion, confidence, reflection_type, metadata, created_at
      FROM ops_reflections WHERE record_id = ${r.id} ORDER BY created_at DESC LIMIT 100`;
}

async function reflect(ctx: Ctx, id: string, body: z.infer<typeof reflectionSchema>) {
  if (ctx.actor.role === "auditor") throw new AccessError("Auditors have read-only access");
  const r = await loadReadable(ctx, id);
  return await db().begin(async (tx) => {
    const [row] = await tx`
      INSERT INTO ops_reflections (record_id, trigger_context, options, factors, conclusion, confidence, reflection_type, metadata,
                                   created_by, authenticated_as, on_behalf_of)
      VALUES (${r.id}, ${body.trigger_context}, ${tx.json(body.options as never)}, ${tx.json(body.factors as never)}, ${body.conclusion},
              ${body.confidence}, ${body.reflection_type}, ${tx.json(body.metadata as never)}, ${ctx.actor.id}, ${ctx.auth.id}, ${ctx.onBehalfOf})
      RETURNING id, record_id AS thought_id, trigger_context, options, factors, conclusion, confidence, reflection_type, metadata, created_at`;
    await tx`
      INSERT INTO ops_record_events (record_id, actor_id, authenticated_as, action, changes, comment)
      VALUES (${r.id}, ${ctx.actor.id}, ${ctx.auth.id}, 'comment', ${tx.json({ reflection_id: Number(row.id), reflection_type: body.reflection_type } as never)},
              ${`Reflection: ${body.conclusion || body.trigger_context || body.reflection_type}`.slice(0, 2000)})`;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Ingest: split longer text into separate thoughts, preview it (dry run), then save
// ---------------------------------------------------------------------------

/** Split text into candidate thoughts: list items, speaker turns, or paragraphs. */
export function splitThoughts(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const items: string[] = [];
  if (lines.filter((l) => bullet.test(l)).length >= 2) {
    let lead: string[] = [];
    for (const l of lines) {
      if (bullet.test(l)) items.push(l.replace(bullet, "").trim());
      else if (l.trim() && items.length && /^\s{2,}\S/.test(l)) items[items.length - 1] += ` ${l.trim()}`;
      else if (l.trim()) lead.push(l.trim());
      else if (lead.length) {
        items.push(lead.join(" "));
        lead = [];
      }
    }
    if (lead.length) items.push(lead.join(" "));
  } else {
    items.push(...text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()));
  }
  return [...new Set(items.filter((s) => s.length >= 12))].slice(0, 50);
}

async function ingest(ctx: Ctx, text: string, dryRun: boolean) {
  if (ctx.actor.role === "auditor") throw new AccessError("Auditors have read-only access");
  const parts = splitThoughts(text);
  if (!parts.length) throw new InputError("Nothing long enough to save as a thought.");
  const items: Row[] = [];
  for (const [i, content] of parts.entries()) {
    const dup = await db().unsafe(`SELECT t.id FROM thoughts t WHERE ${READ} AND t.archived_at IS NULL AND t.content = $2 LIMIT 1`, [ctx.actor.id, content]);
    const tooLong = content.length > config.maxRecordChars;
    items.push({
      id: i + 1, content, type: guessType(content), fingerprint: "", similarity: dup.length ? 1 : null, metadata: {},
      action: dup.length || tooLong ? "skip" : "add",
      reason: dup.length ? "Already in OpsBrain" : tooLong ? `Longer than ${config.maxRecordChars} characters` : null,
      status: "pending",
    });
  }
  const [job] = await db()`
    INSERT INTO ops_ingest_jobs (principal_id, status, items, extracted_count)
    VALUES (${ctx.actor.id}, 'dry_run_complete', ${db().json(items as never)}, ${items.length})
    RETURNING id`;
  if (dryRun) return { job_id: Number(job.id), status: "dry_run_complete", extracted_count: items.length };
  return await executeJob(ctx, Number(job.id));
}

async function executeJob(ctx: Ctx, id: number) {
  const [job] = await db()`SELECT * FROM ops_ingest_jobs WHERE id = ${id} AND principal_id = ${ctx.actor.id}`;
  if (!job) throw new AccessError("Ingestion job not found");
  if (job.status !== "dry_run_complete") return { job_id: id, status: job.status, extracted_count: job.extracted_count };
  const items: Row[] = job.items;
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.action !== "add") {
      item.status = "skipped";
      skipped++;
      continue;
    }
    const r = await capture(ctx, { content: item.content, type: item.type, source_type: "dashboard_ingest", metadata: { ingest_job: id } });
    item.status = r.action === "created" ? "added" : "skipped";
    item.thought_id = r.thought_id;
    if (r.action === "created") added++;
    else skipped++;
  }
  await db()`
    UPDATE ops_ingest_jobs SET status = 'complete', items = ${db().json(items as never)}, added_count = ${added}, skipped_count = ${skipped},
           completed_at = now()
     WHERE id = ${id} AND principal_id = ${ctx.actor.id}`;
  return { job_id: id, status: "complete", extracted_count: items.length, added_count: added, skipped_count: skipped };
}

function jobOut(j: Row) {
  return {
    id: Number(j.id), source_label: j.source_label, status: j.status, extracted_count: j.extracted_count, added_count: j.added_count,
    skipped_count: j.skipped_count, appended_count: 0, revised_count: 0, created_at: j.created_at, completed_at: j.completed_at,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Handler = (c: Context, ctx: Ctx) => Promise<Response>;

export function restApi(): Hono {
  const rest = new Hono();
  rest.use("*", bodyLimit({ maxSize: Math.max(1_000_000, config.maxRecordChars * 8), onError: (c) => c.json({ error: "Request too large" }, 413) }));

  const handle = (fn: Handler) => async (c: Context) => {
    const principal = await authenticate(c.req.header("x-brain-key") ?? c.req.header("x-opsbrain-key") ?? null);
    if (!principal) return c.json({ error: "Invalid or missing access key" }, 401);
    if (principal.kind !== "human") return c.json({ error: "This API is for people. Agents use MCP." }, 403);
    try {
      return await fn(c, await resolveCtx(principal, undefined));
    } catch (err) {
      if (err instanceof AccessError) return c.json({ error: err.message }, err.message.includes("not found") ? 404 : 403);
      if (err instanceof InputError) return c.json({ error: err.message }, 400);
      const e = err as Error & { code?: string };
      if (["42501", "23514", "23505", "23503", "22P02"].includes(e.code ?? "")) return c.json({ error: e.message }, 400);
      console.error(err);
      return c.json({ error: "Request failed" }, 500);
    }
  };
  const json = async <T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new InputError(`Invalid payload: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return parsed.data;
  };

  rest.get("/health", handle(async (c) => c.json({ ok: true, status: "ok", service: "opsbrain-open-brain-rest", version: "1.0.0" })));
  rest.get("/stats", handle(async (c, ctx) => c.json(await stats(ctx, new URL(c.req.url)))));
  rest.get("/thoughts", handle(async (c, ctx) => c.json(await listThoughts(ctx, new URL(c.req.url)))));
  rest.get("/thought/:id", handle(async (c, ctx) => {
    const r = await oneThought(ctx, c.req.param("id"));
    if (!r) return c.json({ error: "Thought not found" }, 404);
    if (r.sensitivity_tier === "restricted" && new URL(c.req.url).searchParams.get("exclude_restricted") !== "false") return c.json({ error: "Restricted thought" }, 403);
    return c.json(thought(r));
  }));
  rest.put("/thought/:id", handle(async (c, ctx) => c.json(await update(ctx, c.req.param("id"), await json(c, updateSchema)))));
  rest.delete("/thought/:id", handle(async (c, ctx) => c.json(await remove(ctx, c.req.param("id")))));
  rest.post("/capture", handle(async (c, ctx) => c.json(await capture(ctx, await json(c, captureSchema)))));
  rest.post("/search", handle(async (c, ctx) => c.json(await search(ctx, await json(c, searchSchema)))));
  rest.get("/duplicates", handle(async (c, ctx) => c.json(await duplicates(ctx, new URL(c.req.url)))));
  rest.get("/thought/:id/connections", handle(async (c, ctx) => c.json({ connections: await connections(ctx, c.req.param("id"), new URL(c.req.url)) })));
  rest.get("/thought/:id/reflection", handle(async (c, ctx) => c.json({ reflections: await reflections(ctx, c.req.param("id")) })));
  rest.post("/thought/:id/reflection", handle(async (c, ctx) => c.json(await reflect(ctx, c.req.param("id"), await json(c, reflectionSchema)))));
  rest.get("/ingestion-jobs", handle(async (c, ctx) => {
    const jobs = await db()`SELECT * FROM ops_ingest_jobs WHERE principal_id = ${ctx.actor.id} ORDER BY created_at DESC LIMIT 50`;
    return c.json({ jobs: jobs.map(jobOut), count: jobs.length });
  }));
  rest.get("/ingestion-jobs/:id", handle(async (c, ctx) => {
    const [job] = await db()`SELECT * FROM ops_ingest_jobs WHERE id = ${intParam(c.req.param("id"), 0, 0, 2 ** 52)} AND principal_id = ${ctx.actor.id}`;
    if (!job) return c.json({ error: "Ingestion job not found" }, 404);
    return c.json({ job: jobOut(job), items: (job.items as Row[]).map((i) => ({ ...i, job_id: Number(job.id) })) });
  }));
  rest.post("/ingestion-jobs/:id/execute", handle(async (c, ctx) => c.json(await executeJob(ctx, intParam(c.req.param("id"), 0, 0, 2 ** 52)))));
  rest.post("/ingest", handle(async (c, ctx) => {
    const body = await json(c, z.object({ text: z.string().min(1), dry_run: z.boolean().optional() }));
    return c.json(await ingest(ctx, body.text, body.dry_run === true));
  }));
  rest.all("*", (c) => c.json({ error: "Not found" }, 404));
  return rest;
}

/** OB1's Agent Memory API is not part of OpsBrain; its dashboard pages say so instead of failing silently. */
export function agentMemoryStub(): Hono {
  const stub = new Hono();
  stub.all("*", (c) =>
    c.json({ error: "OpsBrain does not run the Open Brain Agent Memory API. Agents' work is in Records and Approvals in OpsBrain." }, 501)
  );
  return stub;
}
