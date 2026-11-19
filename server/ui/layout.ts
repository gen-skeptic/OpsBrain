// Page shell and form components, built on the Dautel Design System (server/ui/assets/dautel.css).
import type { Principal } from "../auth.ts";
import { config } from "../config.ts";
import { type Html, html, label } from "./html.ts";

const THEMES = ["dautel", "mocha", "macchiato", "frappe", "latte"];

export type PageOpts = {
  title: string;
  body: Html;
  user?: Principal;
  csrf?: string;
  active?: "pipeline" | "companies" | "contacts" | "approvals";
  flash?: { ok?: string | null; err?: string | null };
  pending?: number;
};

export function page(o: PageOpts): Html {
  const theme = THEMES.includes(config.uiTheme) ? config.uiTheme : "dautel";
  const nav = (key: PageOpts["active"], href: string, text: string, extra?: Html | string) =>
    html`<a href="${href}" class="${o.active === key ? "is-active" : ""}"${o.active === key ? html` aria-current="page"` : ""}>${text}${extra ?? ""}</a>`;
  return html`<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${o.title} · ${config.uiTitle}</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/dautel.css">
<link rel="stylesheet" href="/assets/ui.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="container topbar-inner">
    <a class="brand" href="/crm"><img src="/assets/dautel-intelligent-operations-mark.svg" alt="Dautel Intelligent Operations" width="28" height="28"><span>${config.uiTitle}</span></a>
    ${o.user ? html`<nav class="nav" aria-label="Main">
      ${nav("pipeline", "/crm", "Pipeline")}
      ${nav("companies", "/crm/companies", "Companies")}
      ${nav("contacts", "/crm/contacts", "Contacts")}
      ${nav("approvals", "/approvals", "Approvals", o.pending ? html` <span class="count">${o.pending}</span>` : "")}
    </nav>
    <div class="who micro">
      <span>${o.user.handle}${o.user.can_approve ? " · approver" : ""}</span>
      <form method="post" action="/logout">${csrfField(o.csrf)}<button type="submit" class="link-button">Sign out</button></form>
    </div>` : ""}
  </div>
</header>
<main id="main" class="container page">
${o.flash?.ok ? html`<p class="flash flash-ok" role="status">${o.flash.ok}</p>` : ""}
${o.flash?.err ? html`<p class="flash flash-err" role="alert"><strong>Error:</strong> ${o.flash.err}</p>` : ""}
${o.body}
</main>
</body>
</html>`;
}

export const csrfField = (csrf?: string) => (csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : "");

export const heading = (text: string, sub?: Html | string) =>
  html`<div class="page-heading"><h1 class="page-title"><span>&gt;_</span> ${text}</h1>${sub ? html`<p class="lead-sm">${sub}</p>` : ""}</div>`;

export const section = (text: string, body: Html, actions?: Html) =>
  html`<section class="block"><div class="block-head"><h2 class="block-title"><span>&gt;_</span> ${text}</h2>${actions ?? ""}</div>${body}</section>`;

export type Tone = "blue" | "mint" | "lavender" | "peach" | "danger" | "quiet";

export const tag = (text: string, tone: Tone = "quiet") => html`<span class="tag tag-${tone}">${text}</span>`;

const LIFECYCLE_TONE: Record<string, Tone> = {
  prospect: "quiet", lead: "blue", opportunity: "lavender", client: "mint", former_client: "quiet", partner: "blue", vendor: "quiet", disqualified: "danger",
};
export const lifecycleTag = (v: string) => tag(label(v), LIFECYCLE_TONE[v] ?? "quiet");

export function screenTag(v: string): Html | string {
  if (v === "pending") return tag("Screen pending", "peach");
  if (v === "declined") return tag("Screen declined", "danger");
  if (v === "cleared") return tag("Screen cleared", "mint");
  return "";
}

type FieldOpts = { type?: string; required?: boolean; placeholder?: string; help?: string; full?: boolean; step?: string; min?: string; max?: string; autocomplete?: string; id?: string };

export function field(text: string, name: string, value: unknown, o: FieldOpts = {}): Html {
  const id = o.id ?? `f-${name}`;
  return html`<label class="${o.full ? "full-field" : ""}" for="${id}"><span>${text}${o.required ? " *" : ""}</span>
<input id="${id}" name="${name}" type="${o.type ?? "text"}" value="${value ?? ""}"${o.required ? html` required` : ""}${o.placeholder ? html` placeholder="${o.placeholder}"` : ""}${o.step ? html` step="${o.step}"` : ""}${o.min !== undefined ? html` min="${o.min}"` : ""}${o.max !== undefined ? html` max="${o.max}"` : ""}${o.autocomplete ? html` autocomplete="${o.autocomplete}"` : ""}>
${o.help ? html`<small>${o.help}</small>` : ""}</label>`;
}

export function textarea(text: string, name: string, value: unknown, o: { rows?: number; required?: boolean; help?: string; full?: boolean; id?: string } = {}): Html {
  const id = o.id ?? `f-${name}`;
  return html`<label class="${o.full === false ? "" : "full-field"}" for="${id}"><span>${text}${o.required ? " *" : ""}</span>
<textarea id="${id}" name="${name}" rows="${o.rows ?? 4}"${o.required ? html` required` : ""}>${value ?? ""}</textarea>
${o.help ? html`<small>${o.help}</small>` : ""}</label>`;
}

export function select(text: string, name: string, options: [string, string, boolean?][], selected: unknown, o: { blank?: string; required?: boolean; full?: boolean; help?: string; id?: string } = {}): Html {
  const id = o.id ?? `f-${name}`;
  const cur = selected === null || selected === undefined ? "" : String(selected);
  return html`<label class="${o.full ? "full-field" : ""}" for="${id}"><span>${text}${o.required ? " *" : ""}</span>
<select id="${id}" name="${name}"${o.required ? html` required` : ""}>
${o.blank !== undefined ? html`<option value="">${o.blank}</option>` : ""}
${options.map(([v, t, disabled]) => html`<option value="${v}"${v === cur ? html` selected` : ""}${disabled ? html` disabled` : ""}>${t}</option>`)}
</select>${o.help ? html`<small>${o.help}</small>` : ""}</label>`;
}

export function checkbox(text: string, name: string, checked: boolean, help?: string): Html {
  return html`<label class="check full-field"><input type="checkbox" name="${name}" value="on"${checked ? html` checked` : ""}> <span>${text}</span>${help ? html`<small>${help}</small>` : ""}</label>`;
}

export function form(action: string, csrf: string | undefined, fields: Html, submit: string, o: { hidden?: Record<string, unknown>; tone?: "primary" | "secondary" | "contact"; cls?: string } = {}): Html {
  return html`<form method="post" action="${action}" class="form-grid ${o.cls ?? ""}">
${csrfField(csrf)}
${Object.entries(o.hidden ?? {}).map(([k, v]) => v === undefined || v === null ? "" : html`<input type="hidden" name="${k}" value="${v}">`)}
${fields}
<div class="form-actions full-field"><button type="submit" class="button button-${o.tone ?? "primary"}">${submit}</button></div>
</form>`;
}

export function facts(rows: [string, unknown][]): Html {
  return html`<dl class="facts">${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

export function table(headers: string[], rows: Html[], empty = "Nothing here yet."): Html {
  if (!rows.length) return html`<p class="empty">${empty}</p>`;
  return html`<div class="table-wrap"><table><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
