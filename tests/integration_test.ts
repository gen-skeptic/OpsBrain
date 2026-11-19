// End-to-end tests against a real Postgres with pgvector, through the MCP HTTP interface.
// Skipped unless OPSBRAIN_TEST_ADMIN_URL points at a Postgres server where the test
// may create and drop a scratch database, e.g.
//   OPSBRAIN_TEST_ADMIN_URL=postgres://postgres@localhost:5432/postgres deno task test
import { assert, assertEquals, assertRejects, assertStringIncludes } from "./assert.ts";

const ADMIN_URL = Deno.env.get("OPSBRAIN_TEST_ADMIN_URL");
const ignore = !ADMIN_URL;

Deno.test({ name: "OpsBrain end to end", ignore, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  const postgres = (await import("postgres")).default;
  const dbName = `opsbrain_test_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(ADMIN_URL!, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  Deno.env.set("DATABASE_URL", url.toString());
  Deno.env.set("EMBEDDING_PROVIDER", "fake");
  Deno.env.set("EMBEDDING_DIM", "64");

  const { migrate } = await import("../db/migrate.ts");
  const { db, closeDb } = await import("../server/db.ts");
  const { newRawKey, sha256Hex } = await import("../server/auth.ts");
  const { main: adminCli } = await import("../admin/opsbrain-admin.ts");
  const { buildApp } = await import("../server/app.ts");
  const { exportPara } = await import("../para/export.ts");

  try {
    await migrate(() => {});
    await migrate(() => {}); // idempotent

    const seedFile = await Deno.makeTempFile({ suffix: ".json" });
    await Deno.writeTextFile(seedFile, JSON.stringify({
      principals: [
        { handle: "erich", display_name: "Erich", kind: "human", role: "owner", can_approve: true },
        { handle: "sam", display_name: "Sam", kind: "human", role: "member" },
        { handle: "dio-a", display_name: "Agent A", kind: "agent", role: "agent" },
        { handle: "dio-b", display_name: "Agent B", kind: "agent", role: "agent" },
        { handle: "erich-claude-code", display_name: "Erich's Claude Code", kind: "service", role: "agent", responsible: "erich" },
      ],
      areas: [{ slug: "service-delivery", name: "Service delivery", sort_order: 1 }],
      processes: [{ id: "P09", name: "Custom software", area: "service-delivery" }],
      delegations: [{ principal: "erich-claude-code", may_act_as: "all-agents" }],
      projects: [{ id: "ACME-01", name: "Acme portal", kind: "client_engagement", client_name: "Acme", area: "service-delivery", owner: "erich" }],
    }));
    await adminCli(["seed", seedFile]);
    await adminCli(["seed", seedFile]); // idempotent

    const keys: Record<string, string> = {};
    for (const h of ["erich", "sam", "dio-a", "dio-b", "erich-claude-code"]) {
      keys[h] = newRawKey();
      await db()`INSERT INTO ops_principal_keys (key_hash, principal_id) SELECT ${await sha256Hex(keys[h])}, id FROM ops_principals WHERE handle = ${h}`;
    }

    const app = buildApp();
    let rpcId = 0;
    async function call(key: string | null, name: string, args: Record<string, unknown> = {}) {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (key) headers["x-opsbrain-key"] = key;
      const res = await app.fetch(new Request("http://test/mcp", {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      }));
      const text = await res.text();
      const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
      if (json.error) return { error: json.error, text: "", isError: true };
      const body = json.result.content[0].text as string;
      // Tool results are JSON, optionally after a one-line summary; errors are plain text.
      let data: any = null;
      for (const candidate of [body, body.slice(body.indexOf("\n\n") + 2)]) {
        try {
          data = JSON.parse(candidate);
          break;
        } catch { /* try the next form */ }
      }
      return { text: body, isError: !!json.result.isError, data };
    }

    await t.step("GET on the MCP endpoint is refused instead of opening an empty stream", async () => {
      const res = await app.fetch(new Request("http://test/mcp", { headers: { Accept: "text/event-stream", "x-opsbrain-key": keys.erich } }));
      assertEquals(res.status, 405);
      await res.body?.cancel();
      const health = await app.fetch(new Request("http://test/healthz"));
      assertEquals((await health.json()).ok, true);
    });

    await t.step("requests without a valid key are rejected", async () => {
      const r = await call(null, "whoami");
      assertEquals(r.error?.code, -32001);
      const r2 = await call("obk_not-a-real-key-at-all-123456", "whoami");
      assertEquals(r2.error?.code, -32001);
    });

    await t.step("a session key can act as delegated agents", async () => {
      const r = await call(keys["erich-claude-code"], "whoami", { acting_as: "dio-a" });
      assertEquals(r.data.acting_as, "dio-a");
      assert(r.data.may_act_as.includes("dio-b"));
      const denied = await call(keys.sam, "whoami", { acting_as: "dio-a" });
      assert(denied.isError);
      assertStringIncludes(denied.text, "not allowed to act as");
    });

    let taskId = "";
    await t.step("the admin CLI manages delegations", async () => {
      await adminCli(["principal", "add", "ci-bot", "--name", "CI bot", "--kind", "service", "--role", "agent", "--responsible", "erich"]);
      const bot = newRawKey();
      await db()`INSERT INTO ops_principal_keys (key_hash, principal_id) SELECT ${await sha256Hex(bot)}, id FROM ops_principals WHERE handle = 'ci-bot'`;
      assert((await call(bot, "whoami", { acting_as: "dio-b" })).isError);
      await adminCli(["delegate", "ci-bot", "dio-b"]);
      assertEquals((await call(bot, "whoami", { acting_as: "dio-b" })).data.acting_as, "dio-b");
      await adminCli(["undelegate", "ci-bot", "dio-b"]);
      assert((await call(bot, "whoami", { acting_as: "dio-b" })).isError);
      await adminCli(["principal", "disable", "ci-bot"]);
      assertEquals((await call(bot, "whoami")).error?.code, -32001);
      await assertRejects(() => adminCli(["delegate", "ci-bot"]), "usage");
    });

    await t.step("records carry full attribution", async () => {
      const r = await call(keys["erich-claude-code"], "create_record", {
        acting_as: "dio-a", record_type: "task_card", title: "Sprint 3 tests", content: "Run the regression suite on staging.",
        project_id: "ACME-01", process_id: "P09", process_step: 12, assignee: "dio-a", status: "ready",
        external_ref: "ACME-01-P09-12-sprint-3-tests",
      });
      assert(!r.isError, r.text);
      taskId = r.data.id;
      const g = await call(keys.erich, "get_record", { id: "ACME-01-P09-12-sprint-3-tests" });
      assertEquals([g.data.created_by, g.data.authenticated_as, g.data.on_behalf_of, g.data.owner], ["dio-a", "erich-claude-code", "erich", "dio-a"]);
      assertEquals(g.data.area_slug, "service-delivery");
      assertEquals(g.data.history[0].action, "create");
    });

    await t.step("only owners, assignees, creators and managers can change a record", async () => {
      const denied = await call(keys["dio-b"], "update_record", { id: taskId, status: "done" });
      assert(denied.isError);
      assertStringIncludes(denied.text, "can read this record but not change it");
      const comment = await call(keys["dio-b"], "comment_record", { id: taskId, comment: "Staging is down until 3pm." });
      assert(!comment.isError, comment.text);
      const ok = await call(keys["dio-a"], "update_record", { id: taskId, status: "ready_for_qa", expected_version: 1, comment: "Suite green" });
      assert(!ok.isError, ok.text);
      assertEquals(ok.data.version, 2);
      const conflict = await call(keys["dio-a"], "update_record", { id: taskId, status: "done", expected_version: 1 });
      assertStringIncludes(conflict.text, "Version conflict");
    });

    await t.step("restricted records are visible only to the right principals", async () => {
      const r = await call(keys["dio-a"], "create_record", { record_type: "hiring", title: "Offer for candidate X", content: "Salary band discussion.", visibility: "restricted" });
      assert(!r.isError, r.text);
      assert((await call(keys["dio-b"], "get_record", { id: r.data.id })).isError);
      assert(!(await call(keys.erich, "get_record", { id: r.data.id })).isError);
      const list = await call(keys["dio-b"], "list_records", { record_type: "hiring" });
      assertEquals(list.data.length, 0);
    });

    let decisionId = "";
    await t.step("financial or ethical decisions need a person with approval rights", async () => {
      const r = await call(keys["erich-claude-code"], "create_record", {
        acting_as: "dio-a", record_type: "decision", title: "Discount for Acme", content: "Offer 10% off the build.", financial_or_ethical: true, project_id: "ACME-01",
      });
      decisionId = r.data.id;
      assertEquals(r.data.approval_status, "pending");
      const agentTry = await call(keys["erich-claude-code"], "decide_approval", { id: decisionId, decision: "approve" });
      assert(agentTry.isError);
      const clear = await call(keys["dio-a"], "update_record", { id: decisionId, financial_or_ethical: false });
      assertStringIncludes(clear.text, "Only a person with approval rights");
      await assertRejects(
        () => db()`UPDATE thoughts SET approval_status = 'approved', approved_by = (SELECT id FROM ops_principals WHERE handle = 'dio-a') WHERE id = ${decisionId}`,
        "approval rights",
      );
      const approve = await call(keys.erich, "decide_approval", { id: decisionId, decision: "approve", comment: "OK for a founding client" });
      assert(!approve.isError, approve.text);
      assertEquals(approve.data.approval_status, "approved");
      const edited = await call(keys.erich, "update_record", { id: decisionId, content: "Offer 15% off the build." });
      assertEquals(edited.data.approval_status, "pending");
      await call(keys.erich, "decide_approval", { id: decisionId, decision: "approve" });
    });

    await t.step("search, links, history and compatibility tools", async () => {
      const s = await call(keys["dio-b"], "search_records", { query: "regression suite staging" });
      assertEquals(s.data.mode, "semantic");
      assert(s.data.results.some((x: { id: string }) => x.id === taskId));
      const qa = await call(keys["erich-claude-code"], "create_record", { acting_as: "dio-b", record_type: "qa_record", title: "QA sprint 3", content: "PASS", status: "pass", project_id: "ACME-01" });
      const link = await call(keys["dio-b"], "link_records", { from: qa.data.id, to: taskId, relation: "reviews" });
      assert(!link.isError, link.text);
      const g = await call(keys.erich, "get_record", { id: taskId });
      assertEquals(g.data.links[0].relation, "reviews");
      const h = await call(keys.erich, "record_history", { id: taskId });
      assert(h.data.some((e: { action: string }) => e.action === "comment"));
      const note = await call(keys.sam, "capture_thought", { content: "Remember to renew the domain in March." });
      assert(!note.isError, note.text);
      const stats = await call(keys.erich, "thought_stats");
      assertEquals(stats.data.pending_approvals, 0);
    });

    await t.step("PARA export: placement, restricted split, archive moves, safe cleanup", async () => {
      const out = await Deno.makeTempDir();
      const restrictedOut = await Deno.makeTempDir();
      await exportPara({ outputDir: out, visibility: "company", archiveAfterDays: 30, title: "OpsBrain" });
      await exportPara({ outputDir: restrictedOut, visibility: "restricted", archiveAfterDays: 30, title: "OpsBrain (restricted)" });
      const files: string[] = [];
      for await (const e of walk(out)) files.push(e);
      const projectDir = "1-Projects/ACME-01 - Acme portal";
      assert(files.some((f) => f.startsWith(`${projectDir}/Task cards/`) && f.includes("Sprint 3 tests")), files.join("\n"));
      assert(files.includes(`${projectDir}/_index.md`));
      assert(files.some((f) => f.startsWith("2-Areas/General/Notes/")));
      assert(!files.some((f) => f.includes("Offer for candidate X")), "restricted record leaked into the company mirror");
      const restrictedFiles: string[] = [];
      for await (const e of walk(restrictedOut)) restrictedFiles.push(e);
      assert(restrictedFiles.some((f) => f.includes("Offer for candidate X")));
      const task = await Deno.readTextFile(`${out}/${files.find((f) => f.includes("Sprint 3 tests"))}`);
      assertStringIncludes(task, "../QA%20records/");
      assertStringIncludes(task, 'created_by: "dio-a"');

      await Deno.writeTextFile(`${out}/${projectDir}/my-own-notes.md`, "Written by a person");
      const again = await exportPara({ outputDir: out, visibility: "company", archiveAfterDays: 30, title: "OpsBrain" });
      assert(again.written <= 1, `rewrote ${again.written} unchanged files`); // at most the README's export time changes

      await call(keys.erich, "upsert_project", { id: "ACME-01", status: "completed" });
      const moved = await exportPara({ outputDir: out, visibility: "company", archiveAfterDays: 30, title: "OpsBrain" });
      assert(moved.removed > 0);
      const after: string[] = [];
      for await (const e of walk(out)) after.push(e);
      assert(after.some((f) => f.startsWith("4-Archive/Projects/ACME-01 - Acme portal/Task cards/")), after.join("\n"));
      assert(after.includes(`${projectDir}/my-own-notes.md`), "a person's own file was removed");
    });
  } finally {
    await closeDb();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});

async function* walk(root: string, prefix = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(`${root}/${prefix}`)) {
    if (e.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) yield* walk(root, rel);
    else yield rel;
  }
}
