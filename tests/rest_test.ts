// End-to-end tests of the Open Brain REST API used by the dashboard (server/rest.ts). Needs OPSBRAIN_TEST_ADMIN_URL.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { ADMIN_URL, withScratchDb } from "./harness.ts";
import { guessType, splitThoughts } from "../server/rest.ts";

Deno.test("ingest splits lists, paragraphs and keeps short scraps out", () => {
  assertEquals(splitThoughts("Notes from the call:\n- Client wants weekly reports\n- Budget is approved for Q1\n- ok"), [
    "Client wants weekly reports",
    "Budget is approved for Q1",
    "Notes from the call:",
  ]);
  assertEquals(splitThoughts("First paragraph about pricing.\n\nSecond paragraph about hiring."), ["First paragraph about pricing.", "Second paragraph about hiring."]);
  assertEquals(guessType("TODO: fix the intake form"), "task");
  assertEquals(guessType("We decided to raise prices"), "decision");
  assertEquals(guessType("The office closes early on Fridays"), "observation");
});

Deno.test({ name: "Open Brain REST API end to end", ignore: !ADMIN_URL, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await withScratchDb({ OPSBRAIN_PUBLIC_URL: "https://ops.test" }, async ({ keys, fetch, call, sql }) => {
    const api = async (key: string | null, method: string, path: string, body?: unknown) => {
      const res = await fetch(new Request(`https://ops.test/open-brain-rest${path}`, {
        method,
        headers: { ...(key ? { "x-brain-key": key } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    };

    await t.step("people only, with their own key", async () => {
      assertEquals((await api(null, "GET", "/health")).status, 401);
      assertEquals((await api("obk_not_a_real_key_at_all_xxxxxx", "GET", "/health")).status, 401);
      const agent = await api(keys["dio-a"], "GET", "/health");
      assertEquals(agent.status, 403);
      assertStringIncludes(agent.data.error, "Agents use MCP");
      assertEquals((await api(keys.sam, "GET", "/health")).data.status, "ok");
    });

    let note = "";
    await t.step("capture saves an attributed note with Open Brain fields", async () => {
      const r = await api(keys.sam, "POST", "/capture", { content: "TODO: send the Acme proposal by Friday" });
      assertEquals(r.status, 200, JSON.stringify(r.data));
      assertEquals([r.data.action, r.data.type], ["created", "task"]);
      note = r.data.thought_id;
      const [row] = await sql`SELECT record_type, status, priority, fields, created_by, authenticated_as FROM thoughts WHERE id = ${note}`;
      const [sam] = await sql`SELECT id FROM ops_principals WHERE handle = 'sam'`;
      assertEquals([row.record_type, row.status, row.priority, row.fields.thought_type, row.fields.source], ["note", "new", "normal", "task", "dashboard"]);
      assertEquals([row.created_by, row.authenticated_as], [sam.id, sam.id]);
      const [ev] = await sql`SELECT action FROM ops_record_events WHERE record_id = ${note}`;
      assertEquals(ev.action, "create");
      const again = await api(keys.sam, "POST", "/capture", { content: "TODO: send the Acme proposal by Friday" });
      assertEquals([again.data.action, again.data.thought_id], ["existing", note]);
      const one = await api(keys.sam, "GET", `/thought/${note}`);
      assertEquals([one.data.type, one.data.status, one.data.importance, one.data.sensitivity_tier, one.data.source_type], ["task", "new", 50, "standard", "dashboard"]);
      assertEquals(one.data.metadata.opsbrain_url, `https://ops.test/records/${note}`);
    });

    await t.step("auditors can read but not write", async () => {
      assertEquals((await api(keys.ava, "POST", "/capture", { content: "An auditor note that should be refused" })).status, 403);
      assertEquals((await api(keys.ava, "GET", `/thought/${note}`)).status, 200);
    });

    let card = "";
    await t.step("task cards from agents show on the board; moving them keeps OpsBrain's statuses", async () => {
      const c = await call(keys["dio-a"], "create_record", { record_type: "task_card", title: "Draft SOW", content: "Draft the SOW for Acme", status: "in_progress", assignee: "sam" });
      assert(!c.isError, c.text);
      card = c.data.id;
      const board = await api(keys.sam, "GET", "/thoughts?type=task&status=new,planning,active,review,done&per_page=100&sort=importance&order=desc");
      const ids = board.data.data.map((x: { id: string }) => x.id);
      assert(ids.includes(card) && ids.includes(note), JSON.stringify(ids));
      assertEquals(board.data.data.find((x: { id: string }) => x.id === card).status, "active");
      assertEquals((await api(keys.sam, "PUT", `/thought/${card}`, { status: "review" })).status, 200);
      const [row] = await sql`SELECT status, fields FROM thoughts WHERE id = ${card}`;
      assertEquals(row.status, "ready_for_qa");
      assert(row.fields.status_updated_at);
      assertEquals((await api(keys.sam, "GET", `/thought/${card}`)).data.status, "review");
      const retype = await api(keys.sam, "PUT", `/thought/${card}`, { type: "idea" });
      assertEquals(retype.status, 400);
      assertStringIncludes(retype.data.error, "task card");
    });

    await t.step("edits are versioned and logged; importance maps to priority", async () => {
      const r = await api(keys.sam, "PUT", `/thought/${note}`, { importance: 85, type: "idea", content: "Idea: send the Acme proposal with a pilot option" });
      assertEquals(r.status, 200, JSON.stringify(r.data));
      const [row] = await sql`SELECT priority, fields, content, version FROM thoughts WHERE id = ${note}`;
      assertEquals([row.priority, row.fields.importance, row.fields.thought_type, row.version], ["high", 85, "idea", 2]);
      const events = await sql`SELECT action FROM ops_record_events WHERE record_id = ${note} ORDER BY created_at`;
      assertEquals(events.map((e: { action: string }) => e.action), ["create", "update"]);
      const viaMcp = await call(keys.sam, "update_record", { id: note, fields: { channel: "email" } });
      assert(!viaMcp.isError, viaMcp.text);
      const [kept] = await sql`SELECT jsonb_typeof(fields) AS t, fields FROM thoughts WHERE id = ${note}`;
      assertEquals([kept.t, kept.fields.channel, kept.fields.thought_type], ["object", "email", "idea"], "fields stay an object and merge");
      const other = await api(keys.erich, "PUT", `/thought/${note}`, { sensitivity_tier: "restricted" });
      assertEquals(other.status, 200, "owners may change visibility");
      const denied = await api(keys.sam, "GET", `/thought/${note}`);
      assertEquals(denied.status, 403, "restricted records are hidden unless asked for");
      assertEquals((await api(keys.sam, "GET", `/thought/${note}?exclude_restricted=false`)).status, 200);
      await api(keys.erich, "PUT", `/thought/${note}`, { sensitivity_tier: "standard" });
    });

    await t.step("restricted records stay private to the people who may read them", async () => {
      const secret = await call(keys.erich, "create_record", { record_type: "note", content: "Private salary planning notes", visibility: "restricted" });
      const asSam = await api(keys.sam, "GET", `/thought/${secret.data.id}?exclude_restricted=false`);
      assertEquals(asSam.status, 404);
      const list = await api(keys.sam, "GET", "/thoughts?exclude_restricted=false&per_page=100");
      assert(!list.data.data.some((x: { id: string }) => x.id === secret.data.id));
      assertEquals((await api(keys.erich, "GET", `/thought/${secret.data.id}?exclude_restricted=false`)).status, 200);
    });

    await t.step("browse, filter, sort and page", async () => {
      await api(keys.sam, "POST", "/capture", { content: "The client prefers email updates on Fridays", type: "observation" });
      await api(keys.sam, "POST", "/capture", { content: "the client prefers email updates on fridays", type: "observation" });
      const all = await api(keys.sam, "GET", "/thoughts?per_page=2&page=1");
      assertEquals([all.data.data.length, all.data.page, all.data.per_page], [2, 1, 2]);
      assert(all.data.total >= 4);
      const obs = await api(keys.sam, "GET", "/thoughts?type=observation");
      assertEquals(obs.data.total, 2);
      const low = await api(keys.sam, "GET", "/thoughts?quality_score_max=100&sort=quality_score&order=asc");
      assert(low.data.data[0].quality_score <= low.data.data.at(-1).quality_score);
    });

    await t.step("stats count types and topics", async () => {
      await call(keys.sam, "create_record", { record_type: "note", content: "Pricing review for dental practices", tags: ["pricing"] });
      const s = await api(keys.sam, "GET", "/stats");
      assert(s.data.total_thoughts >= 5);
      assertEquals(s.data.types.observation, 3);
      assert(s.data.top_topics.some((x: { topic: string }) => x.topic === "pricing"));
    });

    await t.step("search by meaning and by keyword", async () => {
      const sem = await api(keys.sam, "POST", "/search", { query: "client prefers email updates on fridays", mode: "semantic" });
      assertEquals(sem.data.mode, "semantic");
      assert(sem.data.results.length >= 2 && sem.data.results[0].similarity > 0.9, JSON.stringify(sem.data));
      const fallback = await api(keys.sam, "POST", "/search", { query: "dental", mode: "semantic", threshold: 0.99 });
      assertEquals(fallback.data.mode, "text", "nothing alike enough: keyword results instead of none");
      assert(fallback.data.results.length >= 1);
      const text = await api(keys.sam, "POST", "/search", { query: "pricing", mode: "text" });
      assertEquals(text.data.mode, "text");
      assert(text.data.results.some((x: { content: string }) => x.content.includes("Pricing review")));
    });

    let dupA = "";
    let dupB = "";
    await t.step("duplicates pair near-identical records", async () => {
      const d = await api(keys.sam, "GET", "/duplicates?threshold=0.9");
      const pair = d.data.pairs.find((p: { content_a: string }) => /email updates/i.test(p.content_a));
      assert(pair, JSON.stringify(d.data));
      assert(pair.similarity >= 0.9);
      dupA = pair.thought_id_a;
      dupB = pair.thought_id_b;
    });

    await t.step("deleting archives, keeps history, and archived records can come back", async () => {
      const r = await api(keys.sam, "DELETE", `/thought/${dupB}`);
      assertEquals(r.status, 200);
      const [row] = await sql`SELECT archived_at FROM thoughts WHERE id = ${dupB}`;
      assert(row.archived_at, "archived, not deleted");
      const [ev] = await sql`SELECT action, comment FROM ops_record_events WHERE record_id = ${dupB} ORDER BY created_at DESC LIMIT 1`;
      assertEquals(ev.action, "archive");
      assertStringIncludes(ev.comment, "Deleted in the dashboard");
      const current = await api(keys.sam, "GET", "/thoughts?per_page=100");
      assert(!current.data.data.some((x: { id: string }) => x.id === dupB));
      const archived = await api(keys.sam, "GET", "/thoughts?status=archived&per_page=100");
      assert(archived.data.data.some((x: { id: string }) => x.id === dupB));
      await api(keys.sam, "PUT", `/thought/${dupB}`, { status: "new" });
      const [back] = await sql`SELECT archived_at FROM thoughts WHERE id = ${dupB}`;
      assertEquals(back.archived_at, null);
      assert(dupA);
    });

    await t.step("connections and reflections", async () => {
      const conn = await api(keys.sam, "GET", `/thought/${dupA}/connections`);
      assert(conn.data.connections.some((x: { id: string }) => x.id === dupB));
      const r = await api(keys.sam, "POST", `/thought/${note}/reflection`, { trigger_context: "Proposal timing", options: [{ label: "Send now" }, { label: "Wait" }], factors: [{ label: "Budget", weight: 0.7 }], conclusion: "Send it with the pilot option", reflection_type: "decision" });
      assertEquals(r.status, 200, JSON.stringify(r.data));
      const list = await api(keys.sam, "GET", `/thought/${note}/reflection`);
      assertEquals(list.data.reflections[0].conclusion, "Send it with the pilot option");
      const [ev] = await sql`SELECT action, comment FROM ops_record_events WHERE record_id = ${note} ORDER BY created_at DESC LIMIT 1`;
      assertEquals([ev.action, ev.comment], ["comment", "Reflection: Send it with the pilot option"]);
      assertEquals((await api(keys.ava, "POST", `/thought/${note}/reflection`, { conclusion: "no" })).status, 403);
    });

    await t.step("ingest previews, then saves each thought as an attributed note", async () => {
      const text = "Meeting takeaways:\n- Acme wants a pilot in January\n- Their IT lead is the decision maker\n- TODO: send the security questionnaire";
      const dry = await api(keys.sam, "POST", "/ingest", { text, dry_run: true });
      assertEquals([dry.data.status, dry.data.extracted_count], ["dry_run_complete", 4]);
      const before = (await sql`SELECT count(*)::int AS n FROM thoughts`)[0].n;
      const job = await api(keys.sam, "GET", `/ingestion-jobs/${dry.data.job_id}`);
      assertEquals(job.data.items.length, 4);
      assertEquals(job.data.items[2].type, "task");
      assertEquals((await sql`SELECT count(*)::int AS n FROM thoughts`)[0].n, before, "a dry run saves nothing");
      assertEquals((await api(keys.erich, "GET", `/ingestion-jobs/${dry.data.job_id}`)).status, 404, "jobs are private to their author");
      const done = await api(keys.sam, "POST", `/ingestion-jobs/${dry.data.job_id}/execute`);
      assertEquals([done.data.status, done.data.added_count], ["complete", 4]);
      const jobs = await api(keys.sam, "GET", "/ingestion-jobs");
      assertEquals(jobs.data.jobs[0].added_count, 4);
      const repeat = await api(keys.sam, "POST", "/ingest", { text });
      assertEquals([repeat.data.added_count, repeat.data.skipped_count], [0, 4]);
    });

    await t.step("the Agent Memory API says it isn't part of OpsBrain", async () => {
      const res = await fetch(new Request("https://ops.test/agent-memory-api/memories", { headers: { "x-brain-key": keys.sam } }));
      assertEquals(res.status, 501);
      await res.body?.cancel();
    });
  });
});
