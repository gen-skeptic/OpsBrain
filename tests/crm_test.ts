// End-to-end tests of the CRM through the MCP tools (needs OPSBRAIN_TEST_ADMIN_URL; see tests/harness.ts).
import { assert, assertEquals, assertRejects, assertStringIncludes } from "./assert.ts";
import { ADMIN_URL, withScratchDb } from "./harness.ts";

Deno.test({ name: "CRM end to end", ignore: !ADMIN_URL, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await withScratchDb({}, async ({ keys, call, sql, seedFile }) => {
    const S = keys.session;
    let acme = "";
    await t.step("companies are matched by domain and name instead of duplicated", async () => {
      const a = await call(S, "crm_upsert_company", { acting_as: "dio-a", name: "Acme Dental", domain: "https://www.AcmeDental.com/about", industry: "Dental", size_band: "10-49", source: "referral" });
      assert(!a.isError, a.text);
      acme = a.data.id;
      const again = await call(S, "crm_upsert_company", { acting_as: "dio-b", domain: "acmedental.com", city: "Boca Raton" });
      assertEquals([again.data.id, again.data.created], [acme, false]);
      const byName = await call(S, "crm_upsert_company", { acting_as: "dio-b", name: "acme dental", region: "FL" });
      assertEquals(byName.data.id, acme);
      const [row] = await sql`SELECT domain, owner_id, version FROM crm_companies WHERE id = ${acme}`;
      assertEquals(row.domain, "acmedental.com");
      assertEquals(row.version, 3);
      const bad = await call(S, "crm_upsert_company", { acting_as: "dio-a", name: "X", domain: "not a domain" });
      assertStringIncludes(bad.text, "Invalid input");
    });

    await t.step("contacts are matched by email and linked to companies", async () => {
      const c = await call(S, "crm_upsert_contact", { acting_as: "dio-a", full_name: "Dana Ortiz", email: "Dana@AcmeDental.com", company: "acmedental.com", job_title: "Practice manager" });
      assert(!c.isError, c.text);
      const again = await call(S, "crm_upsert_contact", { acting_as: "dio-a", email: "dana@acmedental.com", consent: "opted_in", consent_source: "Webinar sign-up" });
      assertEquals(again.data.id, c.data.id);
      const [row] = await sql`SELECT company_id, consent, consent_at FROM crm_contacts WHERE id = ${c.data.id}`;
      assertEquals([row.company_id, row.consent], [acme, "opted_in"]);
      assert(row.consent_at);
    });

    let deal = "";
    await t.step("deals start in the first stage and move the company to opportunity", async () => {
      const d = await call(S, "crm_upsert_deal", { acting_as: "dio-a", name: "Acme intake automation", company: "Acme Dental", primary_contact: "dana@acmedental.com", amount: "$12,500", recurring_monthly: 1500, expected_close: "2026-12-15", service_line: "B" });
      assert(!d.isError, d.text);
      deal = d.data.id;
      assertEquals(d.data.stage, "lead");
      const [c] = await sql`SELECT lifecycle FROM crm_companies WHERE id = ${acme}`;
      assertEquals(c.lifecycle, "opportunity");
      const lost = await call(S, "crm_upsert_deal", { acting_as: "dio-a", id: deal, stage: "lost" });
      assertStringIncludes(lost.text, "lost_reason");
    });

    await t.step("a flagged company blocks screened stages until a person with approval rights clears it", async () => {
      await call(S, "crm_upsert_company", { acting_as: "dio-a", id: acme, flag_for_screen: true, screen_note: "Field-services adjacent?" });
      const blocked = await call(S, "crm_upsert_deal", { acting_as: "dio-a", id: deal, stage: "proposal" });
      assert(blocked.isError);
      assertStringIncludes(blocked.text, "must be cleared");
      const agentScreen = await call(S, "crm_screen_company", { acting_as: "dio-a", company: acme, decision: "cleared" });
      assertStringIncludes(agentScreen.text, "Not allowed");
      await assertRejects(
        () => sql`UPDATE crm_companies SET screen_status = 'cleared', screened_by = (SELECT id FROM ops_principals WHERE handle = 'sam') WHERE id = ${acme}`,
        "approval rights",
      );
      const pipeline = await call(keys.sam, "crm_pipeline");
      assertEquals(pipeline.data.attention.screens_pending.length, 1);
      const cleared = await call(keys.erich, "crm_screen_company", { company: "acmedental.com", decision: "cleared", note: "Dental practice, not utility related" });
      assertEquals(cleared.data.screen_status, "cleared");
      const moved = await call(S, "crm_upsert_deal", { acting_as: "dio-a", id: deal, stage: "proposal", expected_version: 1 });
      assert(!moved.isError, moved.text);
    });

    await t.step("activities are records linked to the CRM and keep deals fresh", async () => {
      const before = (await sql`SELECT version FROM crm_deals WHERE id = ${deal}`)[0].version;
      const a = await call(S, "crm_log_activity", { acting_as: "dio-b", kind: "call", contact: "dana@acmedental.com", deal, direction: "outbound", summary: "Walked through the proposal. Dana wants the intake form live before March.", next_step: "Send revised timeline", next_step_due: "2026-11-25" });
      assert(!a.isError, a.text);
      assertEquals(a.data.company_id, acme);
      const [r] = await sql`SELECT record_type, crm_company_id, crm_contact_id, crm_deal_id, fields FROM thoughts WHERE id = ${a.data.id}`;
      assertEquals([r.record_type, r.crm_company_id, r.crm_deal_id], ["activity", acme, deal]);
      assertEquals(r.fields.kind, "call");
      const [d] = await sql`SELECT version, last_activity_at, next_step FROM crm_deals WHERE id = ${deal}`;
      assert(d.last_activity_at);
      assertEquals(d.next_step, "Send revised timeline");
      assertEquals(d.version, before + 1); // the next-step change, not the activity timestamp
      const none = await call(S, "crm_log_activity", { acting_as: "dio-b", kind: "note", summary: "Orphan" });
      assertStringIncludes(none.text, "Link the activity");
    });

    await t.step("records link to deals and show up on them", async () => {
      const p = await call(S, "create_record", { acting_as: "dio-a", record_type: "proposal", title: "Acme proposal v1", content: "Scope and price.", deal, financial_or_ethical: true });
      assert(!p.isError, p.text);
      const [row] = await sql`SELECT crm_company_id FROM thoughts WHERE id = ${p.data.id}`;
      assertEquals(row.crm_company_id, acme); // implied by the deal
      const list = await call(keys.sam, "list_records", { deal });
      assertEquals(list.data.length, 2);
      const got = await call(keys.sam, "crm_get", { deal });
      assertEquals(got.data.records.length, 2);
      assert(got.data.history.some((e: { action: string }) => e.action === "stage"));
      const company = await call(keys.sam, "crm_get", { company: "acmedental.com" });
      assertEquals(company.data.contacts.length, 1);
      assertEquals(company.data.deals.length, 1);
    });

    await t.step("only a person with approval rights marks a deal won", async () => {
      const agent = await call(S, "crm_upsert_deal", { acting_as: "dio-a", id: deal, stage: "won" });
      assertStringIncludes(agent.text, "Not allowed");
      const sam = await call(keys.sam, "crm_upsert_deal", { id: deal, stage: "won" });
      assertStringIncludes(sam.text, "Not allowed");
      await assertRejects(
        () => sql`UPDATE crm_deals SET stage = 'won', updated_by = (SELECT id FROM ops_principals WHERE handle = 'dio-a') WHERE id = ${deal}`,
        "approval rights",
      );
      const won = await call(keys.erich, "crm_upsert_deal", { id: deal, stage: "won", comment: "SOW signed" });
      assert(!won.isError, won.text);
      const [c] = await sql`SELECT lifecycle FROM crm_companies WHERE id = ${acme}`;
      assertEquals(c.lifecycle, "client");
      const [d] = await sql`SELECT closed_at FROM crm_deals WHERE id = ${deal}`;
      assert(d.closed_at);
    });

    await t.step("a won deal starts its engagement project", async () => {
      const e = await call(S, "crm_start_engagement", { acting_as: "dio-a", deal, project_id: "ACME-01" });
      assert(!e.isError, e.text);
      const [p] = await sql`SELECT kind, client_name, crm_company_id FROM ops_projects WHERE id = 'ACME-01'`;
      assertEquals([p.kind, p.client_name, p.crm_company_id], ["client_engagement", "Acme Dental", acme]);
      const [d] = await sql`SELECT project_id FROM crm_deals WHERE id = ${deal}`;
      assertEquals(d.project_id, "ACME-01");
    });

    await t.step("pipeline totals, weighted forecast and stale deals", async () => {
      const other = await call(S, "crm_upsert_company", { acting_as: "dio-a", name: "Beta Law", domain: "betalaw.com" });
      const d2 = await call(S, "crm_upsert_deal", { acting_as: "dio-a", name: "Beta assessment", company: other.data.id, stage: "qualified", amount: 4000 });
      await sql`UPDATE crm_deals SET created_at = now() - interval '30 days' WHERE id = ${d2.data.id}`;
      const p = await call(keys.sam, "crm_pipeline");
      assertEquals(p.data.totals.open_count, 1);
      assertEquals(p.data.totals.open_amount, 4000);
      assertEquals(p.data.totals.weighted, 1000); // 25% in Qualified
      assertEquals(p.data.totals.won_recent, 1);
      assertEquals(p.data.attention.stale.map((d: { id: string }) => d.id), [d2.data.id]);
      const won = p.data.stages.find((s: { slug: string }) => s.slug === "won");
      assertEquals(won.count, 1);
    });

    await t.step("auditors read but cannot write; search finds all three kinds", async () => {
      const denied = await call(keys.ava, "crm_upsert_company", { name: "Nope Inc" });
      assertStringIncludes(denied.text, "Not allowed");
      const s = await call(keys.ava, "crm_search", { query: "acme" });
      assertEquals([s.data.companies.length, s.data.contacts.length, s.data.deals.length], [1, 1, 1]);
    });

    await t.step("seeded pipeline stages replace the defaults without losing deals", async () => {
      const { main: adminCli } = await import("../admin/opsbrain-admin.ts");
      await adminCli(["seed", await seedFile({
        pipeline_stages: [
          { slug: "prospect", name: "Prospect", probability: 5 },
          { slug: "fit_call", name: "Fit call", probability: 15 },
          { slug: "proposal", name: "Proposal sent", probability: 60, gate_screen: true },
          { slug: "won", name: "Won", probability: 100, is_won: true, gate_screen: true },
          { slug: "lost", name: "Lost", is_lost: true },
        ],
      })]);
      const p = await call(keys.sam, "crm_pipeline");
      // "qualified" is retired but still holds a deal, so it stays on the board.
      assertEquals(p.data.stages.map((s: { slug: string }) => s.slug), ["prospect", "fit_call", "qualified", "proposal", "won", "lost"]);
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM crm_deals WHERE stage = 'qualified'`;
      assertEquals(n, 1); // still there; the stage is only inactive
      const stale = await call(keys.erich, "crm_upsert_deal", { name: "New", company: "betalaw.com", stage: "qualified" });
      assertStringIncludes(stale.text, "no longer in use");
    });

    await t.step("the PARA mirror gets the pipeline, company and deal pages, with activities beside them", async () => {
      const { exportPara } = await import("../para/export.ts");
      const out = await Deno.makeTempDir();
      await exportPara({ outputDir: out, visibility: "company", archiveAfterDays: 30, title: "OpsBrain" });
      const read = (p: string) => Deno.readTextFile(`${out}/${p}`);
      const pipeline = await read("2-Areas/CRM/Pipeline.md");
      assertStringIncludes(pipeline, "Beta assessment");
      const companies = [...Deno.readDirSync(`${out}/2-Areas/CRM/Companies`)].map((e) => e.name);
      assert(companies.some((n) => n.startsWith("Acme Dental (")), companies.join(", "));
      const acme = await read(`2-Areas/CRM/Companies/${companies.find((n) => n.startsWith("Acme Dental ("))}`);
      assert(!acme.includes("dana@acmedental.com"), "contact email leaked into the mirror");
      assertStringIncludes(acme, "](../Activities/");
      const activities = [...Deno.readDirSync(`${out}/2-Areas/CRM/Activities`)].map((e) => e.name);
      assertEquals(activities.length, 1);
      assertStringIncludes(await read("README.md"), "[Pipeline](2-Areas/CRM/Pipeline.md)");
    });
  });
});
