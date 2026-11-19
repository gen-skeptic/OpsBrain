// Web UI routes: sign-in, CRM pages and approvals. People only; every page needs a session, every
// form post needs the session's CSRF token from the same origin, and every change goes through the
// same permission and approval rules as the MCP tools.
import type { Context, Hono } from "hono";
import { AccessError, type Principal, resolveCtx } from "../auth.ts";
import { config } from "../config.ts";
import * as crm from "../crm.ts";
import { isUuid } from "../crm_refs.ts";
import { db } from "../db.ts";
import { InputError } from "../errors.ts";
import { decideApproval, getRecord, listRecords } from "../records.ts";
import { type Html } from "./html.ts";
import { page, type PageOpts } from "./layout.ts";
import * as P from "./pages.ts";
import {
  clearCookie, createSession, destroySession, headerLoginEnabled, keyLoginEnabled, loadSession, principalFromKey,
  principalFromProxy, readCookie, safeEqual, type Session, sessionCookie,
} from "./session.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

const ASSET_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", svg: "image/svg+xml", woff2: "font/woff2", txt: "text/plain; charset=utf-8" };
const ASSET_DIR = new URL("./assets/", import.meta.url);

function listAssets(dir: URL, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isDirectory) out.push(...listAssets(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
    else if (ASSET_TYPES[e.name.split(".").pop() ?? ""]) out.push(prefix + e.name);
  }
  return out;
}

function htmlResponse(body: Html, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body.value, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra } });
}

function redirect(path: string, flash: { ok?: string; err?: string } = {}, extra: Record<string, string> = {}): Response {
  const q = new URLSearchParams();
  if (flash.ok) q.set("ok", flash.ok.slice(0, 300));
  if (flash.err) q.set("err", flash.err.slice(0, 300));
  const qs = q.toString();
  const location = qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra } });
}

/** Only redirect to our own pages. */
function safePath(p: string | null | undefined, fallback = "/crm"): string {
  if (!p) return fallback;
  return /^\/(crm|approvals|records)(\/[A-Za-z0-9\-_/]*)?(\?[A-Za-z0-9\-_=&%.+]*)?$/.test(p) && !p.startsWith("//") ? p : fallback;
}

function messageOf(err: unknown): string {
  const e = err as Error & { code?: string };
  if (err instanceof AccessError || err instanceof InputError) return e.message;
  if (["42501", "23514", "23505", "23503", "22P02", "22007", "22008", "22003"].includes(e.code ?? "")) return e.message;
  console.error(err);
  return "Something went wrong. The change was not saved.";
}

type Handler = (c: Context, s: Session, ctx: Awaited<ReturnType<typeof resolveCtx>>) => Promise<Response>;

/** Resolve the session from the cookie, or sign in through the trusted SSO proxy. */
async function sessionFor(c: Context): Promise<{ session: Session | null; setCookie?: string }> {
  const raw = readCookie(c.req.raw);
  let session = await loadSession(raw);
  const viaProxy = await principalFromProxy(c.req.raw);
  if (viaProxy && session?.principal.id !== viaProxy.id) {
    const fresh = await createSession(viaProxy, c.req.header("user-agent"));
    session = await loadSession(fresh);
    return { session, setCookie: sessionCookie(fresh) };
  }
  return { session };
}

function withSetCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append("Set-Cookie", cookie);
  return res;
}

function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin || origin === "null") return true; // older browsers; SameSite=Strict and the CSRF token still apply
  try {
    const allowed = new Set([c.req.header("x-forwarded-host"), c.req.header("host"), new URL(c.req.url).host, new URL(config.publicUrl).host].filter(Boolean));
    return allowed.has(new URL(origin).host);
  } catch {
    return false;
  }
}

async function form(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

function page404(s: Session, what: string): Response {
  return htmlResponse(page({ title: "Not found", user: s.principal, csrf: s.csrf, body: P.notFoundBody(what) }), 404);
}

/** Fields present in the form become updates; empty strings clear a value. */
function pick(body: Record<string, string>, keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) if (k in body) out[k] = body[k].trim();
  if ("tags" in body) out.tags = body.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if ("expected_version" in body && body.expected_version) out.expected_version = Number(body.expected_version);
  return out;
}

/** Drop empty values when creating (nothing to clear yet). */
const filled = (o: Row) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined));

export function mountUi(app: Hono) {
  const assets = new Set(listAssets(ASSET_DIR));

  app.get("/assets/*", async (c) => {
    const name = c.req.path.slice("/assets/".length);
    if (!assets.has(name)) return c.notFound();
    const body = await Deno.readFile(new URL(name, ASSET_DIR));
    return new Response(body, {
      headers: { "Content-Type": ASSET_TYPES[name.split(".").pop()!], "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" },
    });
  });

  const get = (path: string, h: Handler) =>
    app.get(path, async (c) => {
      const { session, setCookie } = await sessionFor(c);
      if (!session) return redirect(`/login?next=${encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""))}`);
      try {
        return withSetCookie(await h(c, session, await resolveCtx(session.principal, undefined)), setCookie);
      } catch (err) {
        if (err instanceof InputError || err instanceof AccessError) return page404(session, "That page");
        throw err;
      }
    });

  const post = (path: string, h: Handler, back: (c: Context, body: Record<string, string>) => string) =>
    app.post(path, async (c) => {
      const { session } = await sessionFor(c);
      if (!session) return redirect("/login");
      if (!sameOrigin(c)) return new Response("Cross-origin form posts are not allowed", { status: 403, headers: SECURITY_HEADERS });
      const body = await form(c);
      if (!safeEqual(body._csrf ?? "", session.csrf)) return new Response("Your session expired or the form is stale. Reload the page and try again.", { status: 403, headers: SECURITY_HEADERS });
      c.set("form" as never, body as never);
      try {
        return await h(c, session, await resolveCtx(session.principal, undefined));
      } catch (err) {
        return redirect(safePath(back(c, body)), { err: messageOf(err) });
      }
    });

  const render = async (c: Context, s: Session, o: Omit<PageOpts, "user" | "csrf" | "flash" | "pending">, status = 200) => {
    const [{ n }] = await db().unsafe(
      `SELECT count(*)::int AS n FROM ops_records
        WHERE requires_approval AND approval_status = 'pending' AND archived_at IS NULL
          AND ops_can_read($1, visibility, owner_id, assignee_id, created_by_id, allowed_principals)`,
      [s.principal.id],
    );
    return htmlResponse(page({ ...o, user: s.principal, csrf: s.csrf, pending: n, flash: { ok: c.req.query("ok"), err: c.req.query("err") } }), status);
  };

  const view = async (s: Session, withCompanies = false): Promise<P.View> => ({
    user: s.principal,
    csrf: s.csrf,
    owners: (await db()`SELECT handle, display_name, kind FROM ops_principals WHERE active ORDER BY kind DESC, handle`) as unknown as Row[],
    stages: (await crm.listStages(true)) as unknown as Row[],
    companies: withCompanies ? (await db()`SELECT id, name FROM crm_companies WHERE archived_at IS NULL ORDER BY lower(name) LIMIT 2000`) as unknown as Row[] : undefined,
  });

  const formOf = (c: Context) => c.get("form" as never) as unknown as Record<string, string>;

  // ---------------- Sign in and out ----------------
  app.get("/", (c) => c.redirect("/crm", 303));

  app.get("/login", async (c) => {
    const next = safePath(c.req.query("next"));
    const { session, setCookie } = await sessionFor(c);
    if (session) return redirect(next, {}, setCookie ? { "Set-Cookie": setCookie } : {});
    return htmlResponse(page({ title: "Sign in", body: P.loginBody({ keyLogin: keyLoginEnabled(), ssoHint: headerLoginEnabled(), next }) }));
  });

  app.post("/login", async (c) => {
    if (!sameOrigin(c)) return new Response("Cross-origin sign-in is not allowed", { status: 403, headers: SECURITY_HEADERS });
    const body = await form(c);
    const next = safePath(body.next);
    const p: Principal | null = keyLoginEnabled() && body.key ? await principalFromKey(body.key) : null;
    if (!p) {
      await new Promise((r) => setTimeout(r, 400));
      return htmlResponse(page({ title: "Sign in", body: P.loginBody({ keyLogin: keyLoginEnabled(), ssoHint: headerLoginEnabled(), next, error: "That key isn't valid for a person's sign-in (it may be revoked, expired, or belong to an agent)." }) }), 401);
    }
    const raw = await createSession(p, c.req.header("user-agent"));
    return redirect(next, {}, { "Set-Cookie": sessionCookie(raw) });
  });

  app.post("/logout", async (c) => {
    const raw = readCookie(c.req.raw);
    const s = await loadSession(raw);
    const body = await form(c);
    if (s && safeEqual(body._csrf ?? "", s.csrf)) await destroySession(raw);
    return redirect("/login", {}, { "Set-Cookie": clearCookie() });
  });

  // ---------------- Pipeline ----------------
  get("/crm", async (c, s) => {
    const f = { owner: c.req.query("owner") || undefined, service_line: c.req.query("service_line") || undefined };
    return await render(c, s, { title: "Pipeline", active: "pipeline", body: P.pipelineBody(await view(s), await crm.pipeline(f), f) });
  });

  // ---------------- Companies ----------------
  get("/crm/companies", async (c, s) => {
    const f = { q: c.req.query("q") || undefined, lifecycle: c.req.query("lifecycle") || undefined };
    return await render(c, s, { title: "Companies", active: "companies", body: P.companiesBody(await view(s), await crm.listCompanies({ ...f, limit: 200 }), f) });
  });
  get("/crm/companies/new", async (c, s) => render(c, s, { title: "New company", active: "companies", body: P.companyNewBody(await view(s)) }));
  get("/crm/companies/:id", async (c, s, ctx) => {
    if (!isUuid(c.req.param("id"))) return page404(s, "That company");
    const company = await crm.getCompany(ctx, c.req.param("id"));
    return await render(c, s, { title: company.name, active: "companies", body: P.companyBody(await view(s), company) });
  });

  const COMPANY_KEYS = ["name", "domain", "website", "industry", "size_band", "phone", "city", "region", "country", "lifecycle", "source", "owner", "notes"];
  post("/crm/companies", async (c, _s, ctx) => {
    const b = formOf(c);
    const r = await crm.upsertCompany(ctx, { ...filled(pick(b, COMPANY_KEYS)), flag_for_screen: b.flag_for_screen === "on", screen_note: b.screen_note || undefined } as crm.CompanyInput);
    return redirect(`/crm/companies/${r!.id}`, { ok: r!.created ? "Company created." : "That company already existed; it was updated." });
  }, () => "/crm/companies/new");
  post("/crm/companies/:id", async (c, _s, ctx) => {
    const b = formOf(c);
    const input: Row = "archived" in b ? { archived: b.archived === "1" } : pick(b, COMPANY_KEYS);
    await crm.upsertCompany(ctx, { ...input, id: c.req.param("id"), expected_version: input.expected_version } as crm.CompanyInput);
    return redirect(`/crm/companies/${c.req.param("id")}`, { ok: "Saved." });
  }, (c) => `/crm/companies/${c.req.param("id")}`);
  post("/crm/companies/:id/flag", async (c, _s, ctx) => {
    await crm.upsertCompany(ctx, { id: c.req.param("id"), flag_for_screen: true, screen_note: formOf(c).screen_note });
    return redirect(`/crm/companies/${c.req.param("id")}`, { ok: "Flagged for a screen." });
  }, (c) => `/crm/companies/${c.req.param("id")}`);
  post("/crm/companies/:id/screen", async (c, _s, ctx) => {
    const b = formOf(c);
    if (!["cleared", "declined"].includes(b.decision)) throw new InputError("Choose clear or decline");
    await crm.screenCompany(ctx, c.req.param("id"), b.decision as "cleared" | "declined", b.note || undefined);
    return redirect(`/crm/companies/${c.req.param("id")}`, { ok: `Screen ${b.decision}.` });
  }, (c) => `/crm/companies/${c.req.param("id")}`);

  // ---------------- Contacts ----------------
  get("/crm/contacts", async (c, s) => {
    const f = { q: c.req.query("q") || undefined };
    return await render(c, s, { title: "Contacts", active: "contacts", body: P.contactsBody(await view(s), await crm.listContacts({ ...f, limit: 200 }), f) });
  });
  get("/crm/contacts/new", async (c, s) => {
    const company = c.req.query("company");
    return await render(c, s, { title: "New contact", active: "contacts", body: P.contactNewBody(await view(s, true), company && isUuid(company) ? company : undefined) });
  });
  get("/crm/contacts/:id", async (c, s, ctx) => {
    if (!isUuid(c.req.param("id"))) return page404(s, "That contact");
    const contact = await crm.getContact(ctx, c.req.param("id"));
    return await render(c, s, { title: contact.full_name, active: "contacts", body: P.contactBody(await view(s, true), contact) });
  });

  const CONTACT_KEYS = ["full_name", "email", "company", "job_title", "phone", "linkedin_url", "consent", "consent_source", "owner", "notes"];
  const contactInput = (b: Record<string, string>, create: boolean): Row => {
    const input = create ? filled(pick(b, CONTACT_KEYS)) : pick(b, CONTACT_KEYS);
    if (b.has_do_not_contact) input.do_not_contact = b.do_not_contact === "on";
    return input;
  };
  post("/crm/contacts", async (c, _s, ctx) => {
    const r = await crm.upsertContact(ctx, contactInput(formOf(c), true) as crm.ContactInput);
    return redirect(`/crm/contacts/${r!.id}`, { ok: r!.created ? "Contact created." : "A contact with that email already existed; it was updated." });
  }, () => "/crm/contacts/new");
  post("/crm/contacts/:id", async (c, _s, ctx) => {
    const b = formOf(c);
    const input: Row = "archived" in b ? { archived: b.archived === "1" } : contactInput(b, false);
    await crm.upsertContact(ctx, { ...input, id: c.req.param("id") } as crm.ContactInput);
    return redirect(`/crm/contacts/${c.req.param("id")}`, { ok: "Saved." });
  }, (c) => `/crm/contacts/${c.req.param("id")}`);

  // ---------------- Deals ----------------
  get("/crm/deals", (c) => Promise.resolve(c.redirect("/crm", 303)));
  get("/crm/deals/new", async (c, s) => {
    const company = c.req.query("company");
    const companyId = company && isUuid(company) ? company : undefined;
    const contacts = companyId ? await crm.listContacts({ company: companyId, limit: 200 }) : [];
    return await render(c, s, { title: "New deal", active: "pipeline", body: P.dealNewBody(await view(s, true), companyId, contacts) });
  });
  get("/crm/deals/:id", async (c, s, ctx) => {
    if (!isUuid(c.req.param("id"))) return page404(s, "That deal");
    const deal = await crm.getDeal(ctx, c.req.param("id"));
    const contacts = await crm.listContacts({ company: deal.company_id, limit: 200 });
    return await render(c, s, { title: deal.name, active: "pipeline", body: P.dealBody(await view(s, true), deal, contacts) });
  });

  const DEAL_KEYS = ["name", "company", "primary_contact", "stage", "service_line", "amount", "recurring_monthly", "probability", "expected_close", "source", "next_step", "next_step_due", "lost_reason", "owner", "notes", "comment"];
  const dealInput = (b: Record<string, string>, create: boolean): Row => {
    const input = create ? filled(pick(b, DEAL_KEYS)) : pick(b, DEAL_KEYS);
    if ("probability" in input) input.probability = input.probability === "" ? null : Number(input.probability);
    if (input.comment === "") delete input.comment;
    return input;
  };
  post("/crm/deals", async (c, _s, ctx) => {
    const r = await crm.upsertDeal(ctx, dealInput(formOf(c), true) as crm.DealInput);
    return redirect(`/crm/deals/${r!.id}`, { ok: "Deal created." });
  }, (_c, b) => `/crm/deals/new${b.company ? `?company=${encodeURIComponent(b.company)}` : ""}`);
  post("/crm/deals/:id", async (c, _s, ctx) => {
    const b = formOf(c);
    const input: Row = "archived" in b ? { archived: b.archived === "1" } : dealInput(b, false);
    const r = await crm.upsertDeal(ctx, { ...input, id: c.req.param("id") } as crm.DealInput);
    return redirect(`/crm/deals/${c.req.param("id")}`, { ok: r!.changed ? "Saved." : "Nothing changed." });
  }, (c) => `/crm/deals/${c.req.param("id")}`);
  post("/crm/deals/:id/engagement", async (c, _s, ctx) => {
    const b = formOf(c);
    await crm.startEngagement(ctx, c.req.param("id"), b.project_id, { name: b.name || undefined });
    return redirect(`/crm/deals/${c.req.param("id")}`, { ok: `Engagement ${b.project_id} created.` });
  }, (c) => `/crm/deals/${c.req.param("id")}`);

  // ---------------- Activities ----------------
  post("/crm/activities", async (c, _s, ctx) => {
    const b = formOf(c);
    await crm.logActivity(ctx, {
      kind: b.kind, summary: b.summary, title: b.title || undefined, occurred_at: b.occurred_at || undefined,
      direction: (b.direction || undefined) as "inbound" | "outbound" | undefined, outcome: b.outcome || undefined,
      company: b.company || undefined, contact: b.contact || undefined, deal: b.deal || undefined,
      next_step: b.next_step || undefined, next_step_due: b.next_step_due || undefined,
    });
    return redirect(safePath(b.return_to), { ok: "Activity logged." });
  }, (_c, b) => b.return_to ?? "/crm");

  // ---------------- Records and approvals ----------------
  get("/records/:id", async (c, s, ctx) => {
    if (!isUuid(c.req.param("id"))) return page404(s, "That record");
    const r = await getRecord(ctx, c.req.param("id"));
    return await render(c, s, { title: r.title ?? "Record", body: P.recordBody(await view(s), r) });
  });
  get("/approvals", async (c, s, ctx) => {
    const pending = await listRecords(ctx, { approval_status: "pending", limit: 100 });
    const changes = await listRecords(ctx, { approval_status: "changes_requested", limit: 100 });
    return await render(c, s, { title: "Approvals", active: "approvals", body: P.approvalsBody(await view(s), pending, changes) });
  });
  post("/approvals/:id", async (c, _s, ctx) => {
    const b = formOf(c);
    if (!["approve", "reject", "request_changes"].includes(b.decision)) throw new InputError("Choose a decision");
    await decideApproval(ctx, c.req.param("id"), b.decision as "approve" | "reject" | "request_changes", b.comment || undefined);
    const done = { approve: "Approved.", reject: "Rejected.", request_changes: "Changes requested." }[b.decision as "approve"];
    return redirect("/approvals", { ok: done });
  }, () => "/approvals");
}
