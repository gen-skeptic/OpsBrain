// Escaping HTML templates and display formatting for the web UI. Everything interpolated into
// `html` is escaped unless it is itself an Html value, so user data can never inject markup.

export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (s: string) => new Html(s);

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new Html(out);
}

export function money(v: unknown, currency = "USD"): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString("en-US")}`;
  }
}

export function day(v: unknown): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function daysSince(v: unknown, now = Date.now()): number | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : Math.floor((now - d.getTime()) / 86_400_000);
}

export function ago(v: unknown): string {
  const n = daysSince(v);
  if (n === null) return "never";
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  return `${n} days ago`;
}

/** "former_client" → "Former client" */
export function label(slug: unknown): string {
  const s = String(slug ?? "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
