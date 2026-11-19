// Web UI tests: sign-in rules, sessions, CSRF, SSO header sign-in and escaping (needs OPSBRAIN_TEST_ADMIN_URL).
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { ADMIN_URL, withScratchDb } from "./harness.ts";
import { esc, html } from "../server/ui/html.ts";

Deno.test("html templates escape interpolated values", () => {
  const evil = `<script>alert("x")</script>`;
  assertEquals(html`<p>${evil}</p>`.value, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  assertEquals(html`<p>${html`<b>${"&"}</b>`}</p>`.value, "<p><b>&amp;</b></p>");
  assertEquals(html`${[1, "<", null, false]}`.value, "1&lt;");
  assertEquals(esc(`'"`), "&#39;&quot;");
});

const SECRET = "test-proxy-secret-0123456789";

Deno.test({ name: "Web UI end to end", ignore: !ADMIN_URL, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await withScratchDb({ OPSBRAIN_PUBLIC_URL: "http://ui.test", OPSBRAIN_UI_AUTH: "both", OPSBRAIN_UI_PROXY_SECRET: SECRET }, async ({ keys, fetch, call, sql }) => {
    const base = "http://ui.test";
    const post = (path: string, data: Record<string, string>, cookie?: string, origin = base) =>
      fetch(new Request(base + path, {
        method: "POST", body: new URLSearchParams(data),
        headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(cookie ? { cookie } : {}) },
      }));
    const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
      fetch(new Request(base + path, { headers: { ...(cookie ? { cookie } : {}), ...headers } }));
    const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";
    const flashOf = (res: Response) => {
      const q = new URL(res.headers.get("location")!, base).searchParams;
      return { ok: q.get("ok") ?? "", err: q.get("err") ?? "" };
    };
    const csrfOf = async (res: Response) => (await res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

    await t.step("pages need a session; assets don't", async () => {
      const res = await get("/crm");
      assertEquals(res.status, 303);
      assertStringIncludes(res.headers.get("location")!, "/login?next=%2Fcrm");
      const css = await get("/assets/dautel.css");
      assertEquals(css.status, 200);
      await css.body?.cancel();
      const traversal = await get("/assets/../routes.ts");
      assert(traversal.status !== 200);
      await traversal.body?.cancel();
    });

    let cookie = "";
    let csrf = "";
    await t.step("people sign in with their key; agents and bad keys cannot", async () => {
      const agent = await post("/login", { key: keys["dio-a"] });
      assertEquals(agent.status, 401);
      await agent.body?.cancel();
      const bad = await post("/login", { key: "obk_wrong_wrong_wrong_wrong_wrong" });
      assertEquals(bad.status, 401);
      await bad.body?.cancel();
      const ok = await post("/login", { key: keys.sam, next: "/crm/companies" });
      assertEquals(ok.status, 303);
      assertEquals(ok.headers.get("location"), "/crm/companies");
      cookie = cookieOf(ok);
      const setCookie = ok.headers.get("set-cookie")!;
      assertStringIncludes(setCookie, "HttpOnly");
      assertStringIncludes(setCookie, "SameSite=Strict");
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ops_ui_sessions`;
      assertEquals(n, 1);
      const pageRes = await get("/crm", cookie);
      assertEquals(pageRes.status, 200);
      assertEquals(pageRes.headers.get("x-frame-options"), "DENY");
      assertStringIncludes(pageRes.headers.get("content-security-policy")!, "script-src 'none'");
      csrf = await csrfOf(pageRes);
      assert(csrf.length > 20);
      const offsite = await post("/login", { key: keys.sam, next: "https://evil.example/" });
      assertEquals(offsite.headers.get("location"), "/crm");
      await offsite.body?.cancel();
    });

    await t.step("forms need the CSRF token and the same origin", async () => {
      const noToken = await post("/crm/companies", { name: "Forged" }, cookie);
      assertEquals(noToken.status, 403);
      await noToken.body?.cancel();
      const crossSite = await post("/crm/companies", { name: "Forged", _csrf: csrf }, cookie, "https://evil.example");
      assertEquals(crossSite.status, 403);
      await crossSite.body?.cancel();
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM crm_companies`;
      assertEquals(n, 0);
    });

    let companyId = "";
    await t.step("creating through the UI is attributed and escaped on display", async () => {
      const res = await post("/crm/companies", { _csrf: csrf, name: `<img src=x onerror=alert(1)> Acme`, domain: "acme.test", lifecycle: "prospect", owner: "sam", tags: "dental, referral" }, cookie);
      assertEquals(res.status, 303);
      companyId = res.headers.get("location")!.split("/").pop()!.split("?")[0];
      const [row] = await sql`SELECT c.tags, p.handle FROM crm_companies c JOIN ops_principals p ON p.id = c.created_by WHERE c.id = ${companyId}`;
      assertEquals([row.handle, row.tags], ["sam", ["dental", "referral"]]);
      const body = await (await get(`/crm/companies/${companyId}`, cookie)).text();
      assert(!body.includes("<img src=x"), "unescaped user input in the page");
      assertStringIncludes(body, "&lt;img src=x onerror=alert(1)&gt; Acme");
    });

    await t.step("errors come back as a message, not a crash", async () => {
      const res = await post("/crm/deals", { _csrf: csrf, name: "No company" }, cookie);
      assertEquals(res.status, 303);
      assertStringIncludes(flashOf(res).err, "company is required");
      await res.body?.cancel();
    });

    await t.step("approvals: members see the queue; only approvers decide", async () => {
      const rec = await call(keys.session, "create_record", { acting_as: "dio-a", record_type: "invoice", title: "Invoice 1001", content: "Deposit $5,000", financial_or_ethical: true, company: companyId });
      assert(!rec.isError, rec.text);
      const page = await (await get("/approvals", cookie)).text();
      assertStringIncludes(page, "Invoice 1001");
      assert(!page.includes('value="approve"'), "a member was offered approval buttons");
      const tryIt = await post(`/approvals/${rec.data.id}`, { _csrf: csrf, decision: "approve" }, cookie);
      assertStringIncludes(flashOf(tryIt).err, "Approvals must come from a person with approval rights");
      await tryIt.body?.cancel();
    });

    await t.step("SSO header sign-in works only with the proxy secret", async () => {
      const spoofed = await get("/crm", undefined, { "x-authentik-username": "erich" });
      assertEquals(spoofed.status, 303);
      await spoofed.body?.cancel();
      const wrong = await get("/crm", undefined, { "x-authentik-username": "erich", "x-opsbrain-proxy-secret": "nope" });
      assertEquals(wrong.status, 303);
      await wrong.body?.cancel();
      const viaProxy = await get("/approvals", undefined, { "x-authentik-username": "erich", "x-opsbrain-proxy-secret": SECRET });
      assertEquals(viaProxy.status, 200);
      const erichCookie = cookieOf(viaProxy);
      const body = await viaProxy.text();
      assertStringIncludes(body, 'value="approve"');
      const erichCsrf = body.match(/name="_csrf" value="([^"]+)"/)![1];
      const id = body.match(/action="\/approvals\/([0-9a-f-]{36})"/)![1];
      const decided = await post(`/approvals/${id}`, { _csrf: erichCsrf, decision: "approve", comment: "OK" }, erichCookie);
      assertEquals(flashOf(decided).ok, "Approved.");
      await decided.body?.cancel();
      const [r] = await sql`SELECT approval_status FROM thoughts WHERE id = ${id}`;
      assertEquals(r.approval_status, "approved");
      const agentViaProxy = await get("/crm", undefined, { "x-authentik-username": "dio-a", "x-opsbrain-proxy-secret": SECRET });
      assertEquals(agentViaProxy.status, 303);
      await agentViaProxy.body?.cancel();
    });

    await t.step("signing out ends the session", async () => {
      const out = await post("/logout", { _csrf: csrf }, cookie);
      assertStringIncludes(out.headers.get("set-cookie")!, "Max-Age=0");
      await out.body?.cancel();
      const after = await get("/crm", cookie);
      assertEquals(after.status, 303);
      await after.body?.cancel();
    });
  });
});
