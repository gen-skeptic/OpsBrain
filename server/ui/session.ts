// Browser sessions for the web UI. People sign in with their own OpsBrain key, or through a trusted
// reverse proxy (SSO). Only people (kind "human") can use the UI; agents use MCP.
//
// The cookie holds a random session ID; the database stores only its SHA-256 hash, with a CSRF token
// that every form must send back.
import { db } from "../db.ts";
import { authenticate, type Principal, principalById, sha256Hex } from "../auth.ts";
import { config } from "../config.ts";

export type Session = { principal: Principal; csrf: string; hash: string };

const secure = () => config.publicUrl.startsWith("https://");
export const cookieName = () => (secure() ? "__Host-opsbrain" : "opsbrain_session");

function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compare secrets without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function readCookie(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === cookieName()) return v.join("=") || null;
  }
  return null;
}

export function sessionCookie(raw: string): string {
  const maxAge = Math.round(config.uiSessionHours * 3600);
  return `${cookieName()}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure() ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure() ? "; Secure" : ""}`;
}

export async function createSession(p: Principal, userAgent?: string | null): Promise<string> {
  const raw = randomToken();
  await db()`DELETE FROM ops_ui_sessions WHERE expires_at < now()`;
  await db()`
    INSERT INTO ops_ui_sessions (session_hash, principal_id, csrf_token, expires_at, user_agent)
    VALUES (${await sha256Hex(raw)}, ${p.id}, ${randomToken()}, now() + make_interval(hours => ${config.uiSessionHours}),
            ${(userAgent ?? "").slice(0, 300)})`;
  return raw;
}

export async function loadSession(raw: string | null): Promise<Session | null> {
  if (!raw || raw.length < 20 || raw.length > 100) return null;
  const hash = await sha256Hex(raw);
  const [row] = await db()`
    SELECT principal_id, csrf_token, last_seen_at FROM ops_ui_sessions WHERE session_hash = ${hash} AND expires_at > now()`;
  if (!row) return null;
  const p = await principalById(row.principal_id);
  if (!p || !p.active || p.kind !== "human") return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await db()`UPDATE ops_ui_sessions SET last_seen_at = now() WHERE session_hash = ${hash}`;
  }
  return { principal: p, csrf: row.csrf_token, hash };
}

export async function destroySession(raw: string | null) {
  if (raw) await db()`DELETE FROM ops_ui_sessions WHERE session_hash = ${await sha256Hex(raw)}`;
}

/** Sign in with an OpsBrain key. Only active people may use the UI. */
export async function principalFromKey(rawKey: string): Promise<Principal | null> {
  const p = await authenticate(rawKey);
  return p && p.active && p.kind === "human" ? p : null;
}

export const keyLoginEnabled = () => config.uiAuth === "key" || config.uiAuth === "both";
export const headerLoginEnabled = () => (config.uiAuth === "header" || config.uiAuth === "both") && config.uiProxySecret.length >= 16;

/**
 * SSO: a reverse proxy (Authentik, oauth2-proxy, Traefik forward auth...) signs the person in and forwards
 * their username or email in OPSBRAIN_UI_USER_HEADER, plus OPSBRAIN_UI_PROXY_SECRET in
 * X-OpsBrain-Proxy-Secret so a request that bypassed the proxy cannot claim to be someone.
 */
export async function principalFromProxy(req: Request): Promise<Principal | null> {
  if (!headerLoginEnabled()) return null;
  const secret = req.headers.get("x-opsbrain-proxy-secret") ?? "";
  if (!safeEqual(secret, config.uiProxySecret)) return null;
  const user = req.headers.get(config.uiUserHeader)?.trim().toLowerCase();
  if (!user) return null;
  const [row] = await db()`
    SELECT id FROM ops_principals WHERE kind = 'human' AND active AND (handle = ${user} OR lower(email) = ${user})`;
  return row ? await principalById(row.id) : null;
}
