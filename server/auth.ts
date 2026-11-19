// Authentication and delegation.
//
// Every caller presents its own key (never shared). The key identifies a
// principal: a person, an agent, or a runtime service such as a Claude Code
// session. A caller may act as another principal only through delegation,
// and records then carry both identities.
import { db } from "./db.ts";

export type Principal = {
  id: string;
  handle: string;
  display_name: string;
  kind: "human" | "agent" | "service";
  role: "owner" | "admin" | "member" | "agent" | "auditor";
  can_approve: boolean;
  responsible_human_id: string | null;
  active: boolean;
};

export type Ctx = {
  /** The principal whose key authenticated the request. */
  auth: Principal;
  /** The principal doing the work (the auth principal, or a delegated agent). */
  actor: Principal;
  /** The person accountable for the work, when there is one. */
  onBehalfOf: string | null;
};

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newRawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `obk_${b64}`;
}

const PRINCIPAL_COLUMNS = "id, handle, display_name, kind, role, can_approve, responsible_human_id, active";

export async function principalById(id: string): Promise<Principal | null> {
  const rows = await db().unsafe(`SELECT ${PRINCIPAL_COLUMNS} FROM ops_principals WHERE id = $1`, [id]);
  return (rows[0] as unknown as Principal) ?? null;
}

export async function principalByHandle(handle: string): Promise<Principal | null> {
  const rows = await db().unsafe(`SELECT ${PRINCIPAL_COLUMNS} FROM ops_principals WHERE handle = $1`, [handle.trim().toLowerCase()]);
  return (rows[0] as unknown as Principal) ?? null;
}

/** Resolve a raw key to an active principal, or null. */
export async function authenticate(rawKey: string | null | undefined): Promise<Principal | null> {
  if (!rawKey || rawKey.length < 20) return null;
  const hash = await sha256Hex(rawKey.trim());
  const rows = await db()`SELECT principal_id FROM ops_lookup_key(${hash})`;
  if (!rows.length) return null;
  return principalById(rows[0].principal_id as string);
}

export class AccessError extends Error {}

/** Build the request context, applying `acting_as` when it is allowed. */
export async function resolveCtx(auth: Principal, actingAs?: string | null): Promise<Ctx> {
  let actor = auth;
  if (actingAs && actingAs.trim().toLowerCase() !== auth.handle) {
    const target = await principalByHandle(actingAs);
    if (!target || !target.active) throw new AccessError(`Unknown or inactive principal "${actingAs}"`);
    const delegated = await db()`
      SELECT 1 FROM ops_delegations WHERE principal_id = ${auth.id} AND may_act_as = ${target.id}`;
    const ownerActingAsAgent = (auth.role === "owner" || auth.role === "admin") && target.kind === "agent";
    if (!delegated.length && !ownerActingAsAgent) {
      throw new AccessError(`${auth.handle} is not allowed to act as ${target.handle}`);
    }
    actor = target;
  }
  const onBehalfOf = auth.kind === "human" ? auth.id : auth.responsible_human_id;
  return { auth, actor, onBehalfOf };
}
