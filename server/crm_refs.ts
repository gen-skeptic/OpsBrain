// Resolve CRM references given by people and agents: a UUID, a company domain, a contact email,
// or an exact (unique) name.
import { db } from "./db.ts";
import { InputError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string) => UUID.test(s.trim());

/** "https://www.Acme.com/about" → "acme.com". Returns null for things that aren't domains. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

async function single(rows: { id: string }[], what: string, ref: string): Promise<string> {
  if (rows.length === 1) return rows[0].id;
  if (!rows.length) throw new InputError(`No ${what} matches "${ref}"`);
  throw new InputError(`"${ref}" matches ${rows.length} ${what}s; use the ID`);
}

export async function resolveCompanyId(ref: string | null | undefined): Promise<string | null> {
  if (!ref?.trim()) return null;
  const r = ref.trim();
  if (isUuid(r)) return await single(await db()`SELECT id FROM crm_companies WHERE id = ${r}`, "company", r);
  const domain = !/\s/.test(r) && r.includes(".") ? normalizeDomain(r) : null;
  if (domain) {
    const rows = await db()`SELECT id FROM crm_companies WHERE domain = ${domain}`;
    if (rows.length) return rows[0].id;
  }
  return await single(
    await db()`SELECT id FROM crm_companies WHERE lower(name) = lower(${r}) AND archived_at IS NULL`,
    "company", r,
  );
}

export async function resolveContactId(ref: string | null | undefined): Promise<string | null> {
  if (!ref?.trim()) return null;
  const r = ref.trim();
  if (isUuid(r)) return await single(await db()`SELECT id FROM crm_contacts WHERE id = ${r}`, "contact", r);
  const email = normalizeEmail(r);
  if (email) return await single(await db()`SELECT id FROM crm_contacts WHERE lower(email) = ${email}`, "contact", r);
  return await single(
    await db()`SELECT id FROM crm_contacts WHERE lower(full_name) = lower(${r}) AND archived_at IS NULL`,
    "contact", r,
  );
}

export async function resolveDealId(ref: string | null | undefined): Promise<string | null> {
  if (!ref?.trim()) return null;
  const r = ref.trim();
  if (isUuid(r)) return await single(await db()`SELECT id FROM crm_deals WHERE id = ${r}`, "deal", r);
  return await single(
    await db()`SELECT id FROM crm_deals WHERE lower(name) = lower(${r}) AND archived_at IS NULL`,
    "deal", r,
  );
}
