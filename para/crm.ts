// CRM pages for the PARA mirror: a pipeline board, one page per company and per deal, and a contact list,
// all under 2-Areas/<CRM folder>/ (closed and archived ones move to 4-Archive/<CRM folder>/).
// Pure functions, like para.ts. Contact emails and phone numbers are left out unless asked for
// (PARA_CRM_CONTACT_DETAILS=true): the mirror is easier to copy around than the database.
import { MARKER, relLink, ROOTS, safeName } from "./para.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type CrmContext = {
  folder: string;
  now: Date;
  archiveAfterDays: number;
  contactDetails: boolean;
  /** File path of an exported record, if it is in this mirror. */
  recordPath: (id: string) => string | undefined;
};

const day = (d: unknown) => (d ? new Date(String(d instanceof Date ? d.toISOString() : d)).toISOString().slice(0, 10) : "");
const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const money = (v: unknown, currency = "USD") => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? `${currency === "USD" ? "$" : `${currency} `}${Math.round(n).toLocaleString("en-US")}` : "";
};
const yaml = (v: unknown) => (v === null || v === undefined || v === "" ? null : Array.isArray(v) ? `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]` : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v)));
const frontMatter = (pairs: [string, unknown][]) => ["---", ...pairs.map(([k, v]) => [k, yaml(v)]).filter(([, v]) => v !== null && v !== "[]").map(([k, v]) => `${k}: ${v}`), "---", MARKER, ""];
const ageDays = (d: unknown, now: Date) => (d ? (now.getTime() - new Date(String(d instanceof Date ? d.toISOString() : d)).getTime()) / 86_400_000 : 0);

export function companyPath(c: Row, x: CrmContext): string {
  const archived = c.archived_at || c.lifecycle === "disqualified";
  return `${archived ? ROOTS.archive : ROOTS.area}/${safeName(x.folder)}/Companies/${safeName(c.name, 70)} (${String(c.id).slice(0, 8)}).md`;
}

export function dealPath(d: Row, x: CrmContext): string {
  const closedLongAgo = (d.is_won || d.is_lost) && ageDays(d.closed_at, x.now) > x.archiveAfterDays;
  const archived = d.archived_at || closedLongAgo;
  return `${archived ? ROOTS.archive : ROOTS.area}/${safeName(x.folder)}/Deals/${safeName(d.name, 70)} (${String(d.id).slice(0, 8)}).md`;
}

export const pipelinePath = (x: CrmContext) => `${ROOTS.area}/${safeName(x.folder)}/Pipeline.md`;
export const contactsPath = (x: CrmContext) => `${ROOTS.area}/${safeName(x.folder)}/Contacts.md`;

function contactLine(p: Row, x: CrmContext): string {
  const bits = [p.job_title, x.contactDetails ? p.email : p.email ? "email on file" : null, x.contactDetails ? p.phone : null].filter(Boolean);
  const flags = [p.do_not_contact ? "**do not contact**" : null, p.consent === "opted_in" ? "marketing: opted in" : p.consent === "opted_out" ? "marketing: opted out" : null].filter(Boolean);
  return `- **${p.full_name}**${bits.length ? ` · ${bits.join(" · ")}` : ""}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
}

function recordLines(from: string, records: Row[], x: CrmContext): string[] {
  if (!records.length) return ["None in this mirror."];
  return records.map((r) => {
    const target = x.recordPath(r.id);
    const when = day(r.fields?.occurred_at ?? r.created_at);
    const kind = r.record_type === "activity" ? (r.fields?.kind ?? "activity") : r.record_type_name ?? r.record_type;
    const title = cell(r.title ?? kind);
    return `- ${when} · ${kind} · ${target ? `[${title}](${relLink(from, target)})` : title}${r.created_by ? ` · ${r.created_by}` : ""}${r.requires_approval ? ` · approval ${r.approval_status}` : ""}`;
  });
}

export function renderCompany(c: Row, contacts: Row[], deals: Row[], records: Row[], x: CrmContext): string {
  const path = companyPath(c, x);
  const lines = frontMatter([
    ["id", c.id], ["type", "crm_company"], ["name", c.name], ["domain", c.domain], ["lifecycle", c.lifecycle], ["industry", c.industry],
    ["size", c.size_band], ["owner", c.owner], ["screen", c.screen_status === "not_needed" ? null : c.screen_status], ["source", c.source],
    ["tags", c.tags], ["last_activity", day(c.last_activity_at)], ["updated", day(c.updated_at)],
  ]);
  lines.push(`# ${c.name}`, "");
  lines.push([`**${c.lifecycle.replace(/_/g, " ")}**`, c.domain, c.industry, c.size_band ? `${c.size_band} employees` : null, [c.city, c.region].filter(Boolean).join(", ") || null, c.owner ? `owner: ${c.owner}` : null].filter(Boolean).join(" · "), "");
  if (c.screen_status === "pending") lines.push(`> **Screen pending:** ${c.screen_note ?? "waiting for a person with approval rights."}`, "");
  if (c.screen_status === "declined") lines.push(`> **Screen declined** ${c.screen_note ? `: ${c.screen_note}` : ""}`, "");
  if (c.notes) lines.push(c.notes, "");
  lines.push("## Deals", "");
  if (deals.length) {
    lines.push("| Deal | Stage | Value | Monthly | Expected close |", "| --- | --- | --- | --- | --- |");
    for (const d of deals) lines.push(`| [${cell(d.name)}](${relLink(path, dealPath(d, x))}) | ${cell(d.stage_name)} | ${money(d.amount, d.currency)} | ${money(d.recurring_monthly, d.currency)} | ${day(d.expected_close)} |`);
  } else lines.push("None.");
  lines.push("", "## Contacts", "", ...(contacts.length ? contacts.map((p) => contactLine(p, x)) : ["None."]), "");
  lines.push("## Activity and records", "", ...recordLines(path, records, x), "");
  return lines.join("\n");
}

export function renderDeal(d: Row, company: Row | undefined, records: Row[], x: CrmContext): string {
  const path = dealPath(d, x);
  const lines = frontMatter([
    ["id", d.id], ["type", "crm_deal"], ["name", d.name], ["company", d.company_name], ["stage", d.stage], ["amount", d.amount === null ? null : Number(d.amount)],
    ["recurring_monthly", d.recurring_monthly === null ? null : Number(d.recurring_monthly)], ["currency", d.currency], ["probability", d.probability],
    ["expected_close", day(d.expected_close)], ["owner", d.owner], ["service_line", d.service_line], ["project", d.project_id],
    ["closed", day(d.closed_at)], ["tags", d.tags], ["updated", day(d.updated_at)],
  ]);
  lines.push(`# ${d.name}`, "");
  lines.push([
    `**${d.stage_name}**`, company ? `[${d.company_name}](${relLink(path, companyPath(company, x))})` : d.company_name,
    money(d.amount, d.currency) || null, d.recurring_monthly ? `${money(d.recurring_monthly, d.currency)}/month` : null, `${d.probability}%`,
    d.expected_close ? `closes ${day(d.expected_close)}` : null, d.owner ? `owner: ${d.owner}` : null,
  ].filter(Boolean).join(" · "), "");
  if (d.next_step) lines.push(`**Next step:** ${d.next_step}${d.next_step_due ? ` (due ${day(d.next_step_due)})` : ""}`, "");
  if (d.lost_reason) lines.push(`**Lost because:** ${d.lost_reason}`, "");
  if (d.project_id) lines.push(`**Engagement:** ${d.project_id}`, "");
  if (d.notes) lines.push(d.notes, "");
  lines.push("## Activity and records", "", ...recordLines(path, records, x), "");
  return lines.join("\n");
}

export function renderPipeline(stages: Row[], deals: Row[], companies: Map<string, Row>, x: CrmContext, staleDays = 14): string {
  const path = pipelinePath(x);
  const open = deals.filter((d) => !d.is_won && !d.is_lost && !d.archived_at);
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const weighted = open.reduce((t, d) => t + num(d.amount) * num(d.probability) / 100, 0);
  const lines = frontMatter([["type", "crm_pipeline"]]);
  lines.push("# Pipeline", "");
  lines.push(`${open.length} open deals · ${money(open.reduce((t, d) => t + num(d.amount), 0))} open value · ${money(weighted)} weighted · ${money(open.reduce((t, d) => t + num(d.recurring_monthly), 0))}/month recurring in play`, "");
  for (const s of stages.filter((s) => !s.is_won && !s.is_lost)) {
    const ds = open.filter((d) => d.stage === s.slug);
    lines.push(`## ${s.name} (${ds.length})`, "");
    if (!ds.length) { lines.push("None.", ""); continue; }
    lines.push("| Deal | Company | Value | Expected close | Owner | Last activity | Next step |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const d of ds) {
      const company = companies.get(d.company_id);
      const stale = ageDays(d.last_activity_at ?? d.created_at, x.now) > staleDays ? " (stale)" : "";
      lines.push(`| [${cell(d.name)}](${relLink(path, dealPath(d, x))}) | ${company ? `[${cell(d.company_name)}](${relLink(path, companyPath(company, x))})` : cell(d.company_name)} | ${money(d.amount, d.currency)} | ${day(d.expected_close)} | ${cell(d.owner)} | ${day(d.last_activity_at) || "none"}${stale} | ${cell(d.next_step)}${d.next_step_due ? ` (${day(d.next_step_due)})` : ""} |`);
    }
    lines.push("");
  }
  const closed = deals.filter((d) => (d.is_won || d.is_lost) && ageDays(d.closed_at, x.now) <= x.archiveAfterDays);
  lines.push(`## Closed in the last ${x.archiveAfterDays} days (${closed.length})`, "");
  if (closed.length) {
    lines.push("| Deal | Company | Result | Value | Closed |", "| --- | --- | --- | --- | --- |");
    for (const d of closed) lines.push(`| [${cell(d.name)}](${relLink(path, dealPath(d, x))}) | ${cell(d.company_name)} | ${d.is_won ? "Won" : `Lost${d.lost_reason ? `: ${cell(d.lost_reason)}` : ""}`} | ${money(d.amount, d.currency)} | ${day(d.closed_at)} |`);
  } else lines.push("None.");
  lines.push("");
  return lines.join("\n");
}

export function renderContacts(contacts: Row[], companies: Map<string, Row>, x: CrmContext): string {
  const path = contactsPath(x);
  const lines = frontMatter([["type", "crm_contacts"]]);
  lines.push("# Contacts", "", x.contactDetails ? "" : "Emails and phone numbers are kept in OpsBrain, not in this copy.", "");
  lines.push("| Name | Company | Title | Marketing | Do not contact |", "| --- | --- | --- | --- | --- |");
  for (const p of contacts.filter((c) => !c.archived_at)) {
    const company = p.company_id ? companies.get(p.company_id) : undefined;
    lines.push(`| ${cell(p.full_name)}${x.contactDetails && p.email ? ` (${cell(p.email)})` : ""} | ${company ? `[${cell(company.name)}](${relLink(path, companyPath(company, x))})` : ""} | ${cell(p.job_title)} | ${p.consent.replace(/_/g, " ")} | ${p.do_not_contact ? "yes" : ""} |`);
  }
  lines.push("");
  return lines.join("\n");
}
