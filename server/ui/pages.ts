// Page bodies for the web UI. Pure rendering: data in, escaped HTML out.
import type { Principal } from "../auth.ts";
import { ACTIVITY_KINDS, CONSENT, LIFECYCLES, SIZE_BANDS } from "../crm.ts";
import { ago, day, daysSince, type Html, html, label, money } from "./html.ts";
import { checkbox, facts, field, form, heading, lifecycleTag, screenTag, section, select, table, tag, textarea } from "./layout.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type View = {
  user: Principal;
  csrf: string;
  owners: Row[];
  stages: Row[];
  companies?: Row[];
};

const canWrite = (v: View) => v.user.role !== "auditor";
const ownerOptions = (v: View): [string, string][] => v.owners.map((o) => [o.handle, `${o.display_name} (${o.handle})`]);
const tagsText = (t: unknown) => (Array.isArray(t) ? t.join(", ") : "");
const companyLink = (id: string | null, name: string | null) => (id ? html`<a href="/crm/companies/${id}">${name}</a>` : "");
const contactLink = (id: string | null, name: string | null) => (id ? html`<a href="/crm/contacts/${id}">${name}</a>` : "");
const dealLink = (id: string | null, name: string | null) => (id ? html`<a href="/crm/deals/${id}">${name}</a>` : "");

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
export function loginBody(o: { keyLogin: boolean; ssoHint: boolean; next: string; error?: string }): Html {
  return html`<div class="login panel-cut">
  <h1 class="page-title"><span>&gt;_</span> Sign in</h1>
  <p class="lead-sm">OpsBrain is DIO's private system of record. People only; agents connect through MCP.</p>
  ${o.error ? html`<p class="flash flash-err" role="alert"><strong>Error:</strong> ${o.error}</p>` : ""}
  ${o.ssoHint ? html`<p class="note">Sign in through your company SSO portal to open OpsBrain directly.</p>` : ""}
  ${o.keyLogin ? html`<form method="post" action="/login" class="form-grid">
    <input type="hidden" name="next" value="${o.next}">
    ${field("Your OpsBrain key", "key", "", { type: "password", required: true, full: true, autocomplete: "current-password", help: "The obk_ key issued to you. It is checked and never stored in the browser; a session cookie is set instead." })}
    <div class="form-actions"><button type="submit" class="button button-primary">Sign in</button></div>
  </form>` : ""}
</div>`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
export function pipelineBody(v: View, p: Row, f: { owner?: string; service_line?: string }): Html {
  const t = p.totals;
  const open = p.stages.filter((s: Row) => !s.is_won && !s.is_lost);
  const closed = p.stages.filter((s: Row) => s.is_won || s.is_lost).flatMap((s: Row) => s.deals);
  const staleIds = new Set(p.attention.stale.map((d: Row) => d.id));
  const card = (d: Row) => html`<article class="card ${staleIds.has(d.id) ? "is-stale" : ""}">
    <a href="/crm/deals/${d.id}">${d.name}</a>
    <p>${d.company_name}${d.company_screen_status === "pending" ? html` ${tag("Screen pending", "peach")}` : ""}</p>
    <p><b>${money(d.amount, d.currency) || "No amount"}</b>${d.recurring_monthly ? html` · ${money(d.recurring_monthly, d.currency)}/mo` : ""} · ${d.probability}%</p>
    <p class="micro">${d.owner ?? "unowned"}${d.expected_close ? html` · closes ${day(d.expected_close)}` : ""}</p>
    <p class="micro">${d.last_activity_at ? `Last activity ${ago(d.last_activity_at)}` : "No activity yet"}${staleIds.has(d.id) ? html` · ${tag("Stale", "peach")}` : ""}</p>
    ${d.next_step ? html`<p class="micro">Next: ${d.next_step}${d.next_step_due ? ` (${day(d.next_step_due)})` : ""}</p>` : ""}
  </article>`;
  return html`${heading("Pipeline", "Open deals by stage. Weighted value uses each deal's probability.")}
<form method="get" action="/crm" class="filters">
  <label><span>Owner</span><select name="owner"><option value="">Everyone</option>${ownerOptions(v).map(([h, n]) => html`<option value="${h}"${f.owner === h ? html` selected` : ""}>${n}</option>`)}</select></label>
  <label><span>Service line</span><input name="service_line" value="${f.service_line ?? ""}"></label>
  <button type="submit" class="button button-small">Filter</button>
  ${canWrite(v) ? html`<a class="button button-small" href="/crm/deals/new">New deal</a>` : ""}
</form>
<div class="stats">
  <div class="stat"><b>${t.open_count}</b><span>open deals</span></div>
  <div class="stat"><b>${money(t.open_amount)}</b><span>open value</span></div>
  <div class="stat"><b>${money(t.weighted)}</b><span>weighted forecast</span></div>
  <div class="stat"><b>${money(t.open_recurring_monthly)}</b><span>monthly recurring in play</span></div>
  <div class="stat"><b>${t.won_recent} / ${t.lost_recent}</b><span>won / lost, last ${p.closed_days} days</span></div>
</div>
<div class="board">${open.map((s: Row) => html`<section class="column" aria-label="${s.name}">
  <div class="column-head"><b>${s.name}</b><span>${s.count} · ${money(s.amount)}</span></div>
  ${s.deals.length ? s.deals.map(card) : html`<p class="empty">No deals</p>`}
</section>`)}</div>
${section("Needs attention", html`<div class="grid-2"><div>
  ${table(["Stale deal", "Company", "Last activity", "Owner"], p.attention.stale.map((d: Row) => html`<tr><td>${dealLink(d.id, d.name)}</td><td>${d.company_name}</td><td>${ago(d.last_activity_at)}</td><td>${d.owner ?? ""}</td></tr>`), `No open deal has gone ${p.stale_days} days without activity.`)}
  ${table(["Overdue next step", "Deal", "Due", "Owner"], p.attention.overdue_next_steps.map((d: Row) => html`<tr><td>${d.next_step}</td><td>${dealLink(d.id, d.name)}</td><td>${day(d.next_step_due)}</td><td>${d.owner ?? ""}</td></tr>`), "No overdue next steps.")}
</div><div>
  ${table(["Waiting for a screen", "Why"], p.attention.screens_pending.map((c: Row) => html`<tr><td>${companyLink(c.id, c.name)}</td><td>${c.screen_note ?? ""}</td></tr>`), "No companies waiting for a screen.")}
</div></div>`)}
${section(`Closed in the last ${p.closed_days} days`, table(["Deal", "Company", "Result", "Value", "Closed"], closed.map((d: Row) => html`<tr><td>${dealLink(d.id, d.name)}</td><td>${d.company_name}</td><td>${d.is_won ? tag("Won", "mint") : tag("Lost", "quiet")}${d.lost_reason ? html` <span class="note">${d.lost_reason}</span>` : ""}</td><td>${money(d.amount, d.currency)}</td><td>${day(d.closed_at)}</td></tr>`), "Nothing closed recently."))}`;
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export function companiesBody(v: View, rows: Row[], f: { q?: string; lifecycle?: string }): Html {
  return html`${heading("Companies")}
<form method="get" action="/crm/companies" class="filters">
  <label><span>Search</span><input name="q" value="${f.q ?? ""}" placeholder="Name, domain or industry"></label>
  <label><span>Lifecycle</span><select name="lifecycle"><option value="">All</option>${LIFECYCLES.map((l) => html`<option value="${l}"${f.lifecycle === l ? html` selected` : ""}>${label(l)}</option>`)}</select></label>
  <button type="submit" class="button button-small">Search</button>
  ${canWrite(v) ? html`<a class="button button-small" href="/crm/companies/new">New company</a>` : ""}
</form>
${table(["Company", "Domain", "Lifecycle", "Owner", "Open deals", "Last activity"], rows.map((c) => html`<tr>
  <td>${companyLink(c.id, c.name)} ${screenTag(c.screen_status)}</td><td>${c.domain ?? ""}</td><td>${lifecycleTag(c.lifecycle)}</td>
  <td>${c.owner ?? ""}</td><td>${c.open_deals}</td><td>${ago(c.last_activity_at)}</td></tr>`), "No companies match.")}`;
}

function companyFields(v: View, c: Row = {}): Html {
  return html`${field("Name", "name", c.name, { required: true })}
${field("Domain", "domain", c.domain, { placeholder: "acme.com" })}
${field("Website", "website", c.website, { type: "url" })}
${field("Industry", "industry", c.industry)}
${select("Employees", "size_band", SIZE_BANDS.map((s) => [s, s]), c.size_band, { blank: "Unknown" })}
${field("Main phone", "phone", c.phone)}
${field("City", "city", c.city)}
${field("State or region", "region", c.region)}
${field("Country", "country", c.country)}
${select("Lifecycle", "lifecycle", LIFECYCLES.map((l) => [l, label(l)]), c.lifecycle ?? "prospect")}
${field("Source", "source", c.source, { placeholder: "referral, website, event, outbound" })}
${select("Owner", "owner", ownerOptions(v), c.owner ?? v.user.handle)}
${field("Tags", "tags", tagsText(c.tags), { help: "Comma separated", full: true })}
${textarea("Notes", "notes", c.notes, { help: "Log conversations as activities instead." })}`;
}

export function companyNewBody(v: View): Html {
  return html`${heading("New company")}<div class="panel">${form("/crm/companies", v.csrf, html`${companyFields(v)}
${checkbox("Needs a screen before we pursue it", "flag_for_screen", false, "For example a possible conflict of interest: a person with approval rights decides before the deal can be scoped.")}
${field("Why it needs a screen", "screen_note", "", { full: true })}`, "Create company")}</div>`;
}

export function companyBody(v: View, c: Row): Html {
  const approver = v.user.can_approve;
  const back = `/crm/companies/${c.id}`;
  return html`${heading(c.name, html`${lifecycleTag(c.lifecycle)} ${screenTag(c.screen_status)} ${c.archived_at ? tag("Archived", "quiet") : ""}`)}
<div class="grid-2"><div>
<div class="panel">${facts([
    ["Domain", c.domain], ["Website", c.website], ["Industry", c.industry], ["Employees", c.size_band], ["Main phone", c.phone],
    ["Location", [c.city, c.region, c.country].filter(Boolean).join(", ")], ["Source", c.source], ["Owner", c.owner],
    ["Tags", tagsText(c.tags)], ["Last activity", ago(c.last_activity_at)], ["Created", `${day(c.created_at)} by ${c.created_by_handle ?? "?"}`],
    ["Updated", `${day(c.updated_at)} by ${c.updated_by_handle ?? "?"} (version ${c.version})`],
  ])}
${c.notes ? html`<p>${c.notes}</p>` : ""}</div>
${c.screen_status === "pending" ? section("Screen", html`<div class="panel"><p>${c.screen_note ?? "Flagged for a screen."}</p>
  ${approver ? html`<form method="post" action="${back}/screen" class="form-grid">
    <input type="hidden" name="_csrf" value="${v.csrf}">
    ${field("Note", "note", "", { full: true })}
    <div class="decision-row full-field"><button class="button button-secondary" name="decision" value="cleared">Clear</button><button class="button button-danger" name="decision" value="declined">Decline</button></div>
  </form>` : html`<p class="note">Waiting for a person with approval rights. Deals can't move past the screened stages until it is cleared.</p>`}</div>`) : ""}
${section("Deals", table(["Deal", "Stage", "Value", "Expected close", "Owner"], c.deals.map((d: Row) => html`<tr><td>${dealLink(d.id, d.name)}</td><td>${d.stage_name}</td><td>${money(d.amount, d.currency)}${d.recurring_monthly ? html` + ${money(d.recurring_monthly, d.currency)}/mo` : ""}</td><td>${day(d.expected_close)}</td><td>${d.owner ?? ""}</td></tr>`), "No deals yet."), canWrite(v) ? html`<a class="button button-small" href="/crm/deals/new?company=${c.id}">New deal</a>` : undefined)}
${section("Contacts", table(["Name", "Title", "Email", "Phone", "Consent"], c.contacts.map((p: Row) => html`<tr><td>${contactLink(p.id, p.full_name)}${p.do_not_contact ? html` ${tag("Do not contact", "danger")}` : ""}</td><td>${p.job_title ?? ""}</td><td>${p.email ?? ""}</td><td>${p.phone ?? ""}</td><td>${label(p.consent)}</td></tr>`), "No contacts yet."), canWrite(v) ? html`<a class="button button-small" href="/crm/contacts/new?company=${c.id}">Add contact</a>` : undefined)}
${c.projects.length ? section("Engagements", table(["Project", "Name", "Status"], c.projects.map((p: Row) => html`<tr><td>${p.id}</td><td>${p.name}</td><td>${label(p.status)}</td></tr>`))) : ""}
${section("Activity and records", timeline(c.records))}
</div><div>
${canWrite(v) ? activityForm(v, { company: c.id }, back) : ""}
${canWrite(v) ? html`<details class="panel block"><summary>Edit company</summary>${form(back, v.csrf, companyFields(v, c), "Save changes", { hidden: { expected_version: c.version } })}</details>` : ""}
${canWrite(v) && c.screen_status !== "pending" && !approver ? html`<details class="panel block"><summary>Flag for a screen</summary>${form(`${back}/flag`, v.csrf, field("Why it needs a screen", "screen_note", "", { required: true, full: true }), "Flag for the owner", { tone: "contact" })}</details>` : ""}
${canWrite(v) ? html`<form method="post" action="${back}" class="block"><input type="hidden" name="_csrf" value="${v.csrf}"><input type="hidden" name="archived" value="${c.archived_at ? "0" : "1"}"><button class="button button-small">${c.archived_at ? "Restore company" : "Archive company"}</button></form>` : ""}
${section("History", historyList(c.history))}
</div></div>`;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export function contactsBody(v: View, rows: Row[], f: { q?: string }): Html {
  return html`${heading("Contacts", "Business contacts only. Candidates belong in restricted hiring records.")}
<form method="get" action="/crm/contacts" class="filters">
  <label><span>Search</span><input name="q" value="${f.q ?? ""}" placeholder="Name, email, title or company"></label>
  <button type="submit" class="button button-small">Search</button>
  ${canWrite(v) ? html`<a class="button button-small" href="/crm/contacts/new">New contact</a>` : ""}
</form>
${table(["Name", "Company", "Title", "Email", "Consent", "Last activity"], rows.map((p) => html`<tr>
  <td>${contactLink(p.id, p.full_name)}${p.do_not_contact ? html` ${tag("Do not contact", "danger")}` : ""}</td><td>${companyLink(p.company_id, p.company_name)}</td>
  <td>${p.job_title ?? ""}</td><td>${p.email ?? ""}</td><td>${label(p.consent)}</td><td>${ago(p.last_activity_at)}</td></tr>`), "No contacts match.")}`;
}

function contactFields(v: View, p: Row = {}): Html {
  return html`${field("Full name", "full_name", p.full_name, { required: true })}
${select("Company", "company", (v.companies ?? []).map((c) => [c.id, c.name]), p.company_id, { blank: "No company" })}
${field("Job title", "job_title", p.job_title)}
${field("Work email", "email", p.email, { type: "email" })}
${field("Work phone", "phone", p.phone)}
${field("LinkedIn", "linkedin_url", p.linkedin_url, { type: "url" })}
${select("Marketing consent", "consent", CONSENT.map((c) => [c, label(c)]), p.consent ?? "unknown", { help: "Never send marketing without opted in." })}
${field("Consent source", "consent_source", p.consent_source, { placeholder: "e.g. webinar sign-up, 2026-11-10" })}
${select("Owner", "owner", ownerOptions(v), p.owner ?? v.user.handle)}
${field("Tags", "tags", tagsText(p.tags), { help: "Comma separated" })}
<input type="hidden" name="has_do_not_contact" value="1">
${checkbox("Do not contact", "do_not_contact", !!p.do_not_contact, "No outreach of any kind.")}
${textarea("Notes", "notes", p.notes)}`;
}

export function contactNewBody(v: View, companyId?: string): Html {
  return html`${heading("New contact")}<div class="panel">${form("/crm/contacts", v.csrf, contactFields(v, { company_id: companyId }), "Create contact")}</div>`;
}

export function contactBody(v: View, p: Row): Html {
  const back = `/crm/contacts/${p.id}`;
  return html`${heading(p.full_name, html`${p.company_id ? companyLink(p.company_id, p.company_name) : ""} ${p.do_not_contact ? tag("Do not contact", "danger") : ""} ${p.archived_at ? tag("Archived", "quiet") : ""}`)}
<div class="grid-2"><div>
<div class="panel">${facts([
    ["Title", p.job_title], ["Email", p.email], ["Phone", p.phone], ["LinkedIn", p.linkedin_url],
    ["Marketing consent", `${label(p.consent)}${p.consent_at ? ` (${day(p.consent_at)}${p.consent_source ? `, ${p.consent_source}` : ""})` : ""}`],
    ["Owner", p.owner], ["Tags", tagsText(p.tags)], ["Last activity", ago(p.last_activity_at)],
    ["Updated", `${day(p.updated_at)} by ${p.updated_by_handle ?? "?"} (version ${p.version})`],
  ])}${p.notes ? html`<p>${p.notes}</p>` : ""}</div>
${section("Deals", table(["Deal", "Company", "Stage", "Value"], p.deals.map((d: Row) => html`<tr><td>${dealLink(d.id, d.name)}</td><td>${d.company_name}</td><td>${d.stage_name}</td><td>${money(d.amount, d.currency)}</td></tr>`), "Not the primary contact on any deal."))}
${section("Activity and records", timeline(p.records))}
</div><div>
${canWrite(v) ? activityForm(v, { contact: p.id }, back) : ""}
${canWrite(v) ? html`<details class="panel block"><summary>Edit contact</summary>${form(back, v.csrf, contactFields(v, p), "Save changes", { hidden: { expected_version: p.version } })}</details>` : ""}
${canWrite(v) ? html`<form method="post" action="${back}" class="block"><input type="hidden" name="_csrf" value="${v.csrf}"><input type="hidden" name="archived" value="${p.archived_at ? "0" : "1"}"><button class="button button-small">${p.archived_at ? "Restore contact" : "Archive contact"}</button></form>` : ""}
${section("History", historyList(p.history))}
</div></div>`;
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------
function stageOptions(v: View, current?: string): [string, string, boolean?][] {
  return v.stages
    .filter((s) => s.active || s.slug === current)
    .map((s) => [s.slug, `${s.name} (${s.probability}%)${s.is_won && !v.user.can_approve ? " · approver only" : ""}`, s.is_won && !v.user.can_approve && s.slug !== current]);
}

function dealFields(v: View, d: Row = {}, contacts: Row[] = []): Html {
  return html`${field("Deal name", "name", d.name, { required: true, full: true })}
${select("Company", "company", (v.companies ?? []).map((c) => [c.id, c.name]), d.company_id, { required: true, blank: "Choose a company" })}
${select("Primary contact", "primary_contact", contacts.map((c) => [c.id, c.full_name]), d.primary_contact_id, { blank: "None" })}
${d.id ? "" : select("Stage", "stage", stageOptions(v), v.stages.find((s) => s.active && !s.is_won && !s.is_lost)?.slug)}
${field("Service line", "service_line", d.service_line)}
${field("One-time value", "amount", d.amount, { type: "number", step: "0.01", min: "0" })}
${field("Monthly recurring", "recurring_monthly", d.recurring_monthly, { type: "number", step: "0.01", min: "0" })}
${field("Probability override (%)", "probability", d.id ? (d.probability_override ?? "") : "", { type: "number", min: "0", max: "100", help: "Leave empty to use the stage's probability." })}
${field("Expected close", "expected_close", day(d.expected_close), { type: "date" })}
${field("Source", "source", d.source)}
${field("Next step", "next_step", d.next_step)}
${field("Next step due", "next_step_due", day(d.next_step_due), { type: "date" })}
${select("Owner", "owner", ownerOptions(v), d.owner ?? v.user.handle)}
${field("Tags", "tags", tagsText(d.tags), { help: "Comma separated" })}
${textarea("Notes", "notes", d.notes)}`;
}

export function dealNewBody(v: View, companyId: string | undefined, contacts: Row[]): Html {
  return html`${heading("New deal")}<div class="panel">${form("/crm/deals", v.csrf, dealFields(v, { company_id: companyId }, contacts), "Create deal")}</div>`;
}

export function dealBody(v: View, d: Row, contacts: Row[]): Html {
  const back = `/crm/deals/${d.id}`;
  return html`${heading(d.name, html`${companyLink(d.company_id, d.company_name)} ${tag(d.stage_name, d.is_won ? "mint" : d.is_lost ? "quiet" : "blue")} ${d.company_screen_status === "pending" ? tag("Screen pending", "peach") : ""} ${d.archived_at ? tag("Archived", "quiet") : ""}`)}
<div class="grid-2"><div>
<div class="panel">${facts([
    ["One-time value", money(d.amount, d.currency)], ["Monthly recurring", d.recurring_monthly ? `${money(d.recurring_monthly, d.currency)}/mo` : ""],
    ["Probability", `${d.probability}%`], ["Expected close", day(d.expected_close)], ["Service line", d.service_line],
    ["Primary contact", contactLink(d.primary_contact_id, d.primary_contact_name)], ["Owner", d.owner], ["Source", d.source],
    ["Next step", d.next_step ? `${d.next_step}${d.next_step_due ? ` (due ${day(d.next_step_due)})` : ""}` : ""],
    ["In stage since", `${day(d.stage_changed_at)} (${daysSince(d.stage_changed_at)} days)`], ["Closed", day(d.closed_at)],
    ["Lost reason", d.lost_reason], ["Engagement", d.project_id], ["Last activity", ago(d.last_activity_at)],
    ["Updated", `${day(d.updated_at)} by ${d.updated_by ?? "?"} (version ${d.version})`],
  ])}${d.notes ? html`<p>${d.notes}</p>` : ""}</div>
${canWrite(v) ? section("Move", form(back, v.csrf, html`${select("Stage", "stage", stageOptions(v, d.stage), d.stage)}
${field("Lost reason", "lost_reason", d.lost_reason, { help: "Required when closing as lost." })}
${field("Comment", "comment", "", { full: true })}`, "Update stage", { hidden: { expected_version: d.version } })) : ""}
${d.is_won && !d.project_id && canWrite(v) ? section("Start the engagement", form(`${back}/engagement`, v.csrf, html`${field("Engagement ID", "project_id", "", { required: true, placeholder: "ACME-01" })}
${field("Project name", "name", d.name)}`, "Create engagement project", { tone: "secondary" })) : ""}
${section("Activity and records", timeline(d.records), html`<span class="note">Proposals, contracts and invoice records link here when created with this deal.</span>`)}
</div><div>
${canWrite(v) ? activityForm(v, { deal: d.id, contact: d.primary_contact_id }, back, true) : ""}
${canWrite(v) ? html`<details class="panel block"><summary>Edit deal</summary>${form(back, v.csrf, dealFields(v, d, contacts), "Save changes", { hidden: { expected_version: d.version } })}</details>` : ""}
${canWrite(v) ? html`<form method="post" action="${back}" class="block"><input type="hidden" name="_csrf" value="${v.csrf}"><input type="hidden" name="archived" value="${d.archived_at ? "0" : "1"}"><button class="button button-small">${d.archived_at ? "Restore deal" : "Archive deal"}</button></form>` : ""}
${section("History", historyList(d.history))}
</div></div>`;
}

// ---------------------------------------------------------------------------
// Activities, timeline, history
// ---------------------------------------------------------------------------
export function activityForm(v: View, links: { company?: string | null; contact?: string | null; deal?: string | null }, returnTo: string, withNextStep = false): Html {
  const id = (n: string) => `act-${n}`;
  return html`<div class="panel"><h2 class="block-title"><span>&gt;_</span> Log activity</h2>${form("/crm/activities", v.csrf, html`
${select("Kind", "kind", ACTIVITY_KINDS.map((k) => [k, label(k)]), "call", { id: id("kind") })}
${select("Direction", "direction", [["outbound", "Outbound"], ["inbound", "Inbound"]], "outbound", { blank: "n/a", id: id("direction") })}
${field("Title", "title", "", { full: true, placeholder: "Optional; defaults to the kind and who", id: id("title") })}
${field("When", "occurred_at", day(new Date()), { type: "date", id: id("occurred_at") })}
${field("Outcome", "outcome", "", { id: id("outcome") })}
${textarea("Summary", "summary", "", { required: true, rows: 5, help: "Who, what was discussed, decisions, next step. A summary, never a full email or client confidential data.", id: id("summary") })}
${withNextStep ? html`${field("Next step", "next_step", "", { id: id("next_step") })}${field("Next step due", "next_step_due", "", { type: "date", id: id("next_step_due") })}` : ""}`, "Log activity", {
    hidden: { company: links.company ?? undefined, contact: links.contact ?? undefined, deal: links.deal ?? undefined, return_to: returnTo },
    tone: "secondary",
  })}</div>`;
}

export function timeline(records: Row[]): Html {
  if (!records.length) return html`<p class="empty">No activities or records yet.</p>`;
  return html`<ol class="timeline">${records.map((r) => {
    const when = r.fields?.occurred_at ?? r.created_at;
    return html`<li>
  <div class="meta"><span>${day(when)}</span><span>${r.record_type === "activity" ? label(r.fields?.kind ?? "activity") : label(r.record_type)}</span>${r.fields?.direction ? html`<span>${r.fields.direction}</span>` : ""}<span>by ${r.created_by ?? "?"}${r.on_behalf_of && r.on_behalf_of !== r.created_by ? ` for ${r.on_behalf_of}` : ""}</span>${r.requires_approval ? html`<span>${tag(`Approval ${r.approval_status}`, r.approval_status === "approved" ? "mint" : r.approval_status === "pending" ? "peach" : "quiet")}</span>` : ""}${r.status && r.record_type !== "activity" ? html`<span>${r.status}</span>` : ""}</div>
  <h3><a href="/records/${r.id}">${r.title ?? label(r.record_type)}</a></h3>
  <p>${r.excerpt}</p>
</li>`;
  })}</ol>`;
}

export function historyList(events: Row[]): Html {
  if (!events.length) return html`<p class="empty">No history.</p>`;
  return html`<ul class="history">${events.map((e) => html`<li>${day(e.created_at)} <b>${e.actor ?? "?"}</b>${e.authenticated_as && e.authenticated_as !== e.actor ? ` (via ${e.authenticated_as})` : ""} ${e.action}${describe(e.changes)}${e.comment ? html`: ${e.comment}` : ""}</li>`)}</ul>`;
}

function describe(changes: Row | null): string {
  if (!changes) return "";
  const keys = Object.keys(changes);
  if (!keys.length) return "";
  const stage = changes.stage;
  if (stage && typeof stage === "object" && "to" in stage) return ` ${stage.from ?? "new"} → ${stage.to}`;
  const screen = changes.screen_status;
  if (screen && typeof screen === "object" && "to" in screen) return ` screen ${screen.from ?? ""} → ${screen.to}`;
  return ` (${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""})`;
}

// ---------------------------------------------------------------------------
// Records and approvals
// ---------------------------------------------------------------------------
export function recordBody(v: View, r: Row): Html {
  return html`${heading(r.title ?? label(r.record_type), html`${tag(label(r.record_type), "lavender")} ${r.status ? tag(r.status, "quiet") : ""} ${r.requires_approval ? tag(`Approval ${r.approval_status}`, r.approval_status === "approved" ? "mint" : "peach") : ""} ${r.visibility === "restricted" ? tag("Restricted", "danger") : ""}`)}
<div class="grid-2"><div>
<div class="panel"><div class="record-body"><p>${r.content}</p></div></div>
${r.requires_approval && r.approval_status !== "approved" && v.user.can_approve ? decisionForm(v, r.id) : ""}
</div><div>
<div class="panel">${facts([
    ["Owner", r.owner], ["Assignee", r.assignee], ["Created by", r.created_by], ["On behalf of", r.on_behalf_of], ["Key used", r.authenticated_as],
    ["Project", r.project_id], ["Area", r.area_slug], ["Process", r.process_id ? `${r.process_id}${r.process_step ? ` step ${r.process_step}` : ""}` : ""],
    ["Company", companyLink(r.crm_company_id, r.crm_company_name)], ["Contact", contactLink(r.crm_contact_id, r.crm_contact_name)], ["Deal", dealLink(r.crm_deal_id, r.crm_deal_name)],
    ["Due", day(r.due_on)], ["Approved by", r.approved_by], ["External ref", r.external_ref], ["Version", r.version],
    ["Created", day(r.created_at)], ["Updated", day(r.updated_at)],
  ])}</div>
${section("Links", table(["Relation", "Record", "Type"], (r.links ?? []).map((l: Row) => html`<tr><td>${l.direction === "incoming" ? `${l.relation} (from)` : l.relation}</td><td><a href="/records/${l.id}">${l.title ?? l.id}</a></td><td>${label(l.record_type)}</td></tr>`), "No links."))}
${section("History", historyList(r.history ?? []))}
</div></div>`;
}

function decisionForm(v: View, id: string): Html {
  return html`<form method="post" action="/approvals/${id}" class="form-grid panel block">
  <input type="hidden" name="_csrf" value="${v.csrf}">
  ${textarea("Comment", "comment", "", { rows: 2, help: "Kept in the record's history." })}
  <div class="decision-row full-field">
    <button class="button button-secondary" name="decision" value="approve">Approve</button>
    <button class="button button-small" name="decision" value="request_changes">Request changes</button>
    <button class="button button-danger" name="decision" value="reject">Reject</button>
  </div>
</form>`;
}

export function approvalsBody(v: View, pending: Row[], changes: Row[]): Html {
  const item = (r: Row) => html`<li>
  <div class="meta"><span>${label(r.record_type)}</span><span>${day(r.created_at)}</span><span>by ${r.created_by ?? "?"}${r.on_behalf_of && r.on_behalf_of !== r.created_by ? ` for ${r.on_behalf_of}` : ""}</span>${r.financial_or_ethical ? html`<span>${tag("Financial or ethical", "peach")}</span>` : ""}${r.project_id ? html`<span>${r.project_id}</span>` : ""}${r.crm_deal_id ? html`<span>${dealLink(r.crm_deal_id, r.crm_deal_name)}</span>` : r.crm_company_id ? html`<span>${companyLink(r.crm_company_id, r.crm_company_name)}</span>` : ""}</div>
  <h3><a href="/records/${r.id}">${r.title ?? label(r.record_type)}</a></h3>
  <p>${r.excerpt}</p>
  ${v.user.can_approve && r.approval_status === "pending" ? decisionForm(v, r.id) : ""}
</li>`;
  return html`${heading("Approvals", v.user.can_approve ? "Decisions waiting for you. Agents never approve; OpsBrain enforces it." : "Decisions waiting for a person with approval rights.")}
${section(`Waiting (${pending.length})`, pending.length ? html`<ol class="timeline">${pending.map(item)}</ol>` : html`<p class="empty">Nothing is waiting for approval.</p>`)}
${section(`Changes requested (${changes.length})`, changes.length ? html`<ol class="timeline">${changes.map(item)}</ol>` : html`<p class="empty">None.</p>`)}`;
}

export function notFoundBody(what: string): Html {
  return html`${heading("Not found")}<p>${what} doesn't exist, or you can't see it.</p><p><a class="button button-small" href="/crm">Back to the pipeline</a></p>`;
}
