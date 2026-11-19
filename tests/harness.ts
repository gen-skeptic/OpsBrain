// Shared setup for end-to-end tests: a scratch database, seeded principals with keys, and an MCP caller.
// Tests using it are skipped unless OPSBRAIN_TEST_ADMIN_URL points at a Postgres server (with pgvector)
// where they may create and drop databases.

export const ADMIN_URL = Deno.env.get("OPSBRAIN_TEST_ADMIN_URL");

export type CallResult = { text: string; isError: boolean; data: any; error?: { code: number; message: string } };

export type Harness = {
  keys: Record<string, string>;
  call: (key: string | null, name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  fetch: (req: Request) => Promise<Response>;
  sql: any;
  seedFile: (data: unknown) => Promise<string>;
};

export const PEOPLE = [
  { handle: "erich", display_name: "Erich", kind: "human", role: "owner", can_approve: true },
  { handle: "sam", display_name: "Sam", kind: "human", role: "member" },
  { handle: "ava", display_name: "Ava Auditor", kind: "human", role: "auditor" },
  { handle: "dio-a", display_name: "Agent A", kind: "agent", role: "agent", responsible: "erich" },
  { handle: "dio-b", display_name: "Agent B", kind: "agent", role: "agent", responsible: "erich" },
  { handle: "session", display_name: "Session", kind: "service", role: "agent", responsible: "erich" },
];

export async function withScratchDb(env: Record<string, string>, fn: (h: Harness) => Promise<void>) {
  const postgres = (await import("postgres")).default;
  const dbName = `opsbrain_test_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(ADMIN_URL!, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  const settings: Record<string, string> = { DATABASE_URL: url.toString(), EMBEDDING_PROVIDER: "fake", EMBEDDING_DIM: "64", ...env };
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(settings)) { previous[k] = Deno.env.get(k); Deno.env.set(k, v); }

  const { migrate } = await import("../db/migrate.ts");
  const { db, closeDb } = await import("../server/db.ts");
  const { newRawKey, sha256Hex } = await import("../server/auth.ts");
  const { main: adminCli } = await import("../admin/opsbrain-admin.ts");
  const { buildApp } = await import("../server/app.ts");
  try {
    await migrate(() => {});
    const seedFile = async (data: unknown) => {
      const f = await Deno.makeTempFile({ suffix: ".json" });
      await Deno.writeTextFile(f, JSON.stringify(data));
      return f;
    };
    await adminCli(["seed", await seedFile({ principals: PEOPLE, delegations: [{ principal: "session", may_act_as: "all-agents" }] })]);
    const keys: Record<string, string> = {};
    for (const p of PEOPLE) {
      keys[p.handle] = newRawKey();
      await db()`INSERT INTO ops_principal_keys (key_hash, principal_id) SELECT ${await sha256Hex(keys[p.handle])}, id FROM ops_principals WHERE handle = ${p.handle}`;
    }
    const app = buildApp();
    let rpcId = 0;
    const call = async (key: string | null, name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (key) headers["x-opsbrain-key"] = key;
      const res = await app.fetch(new Request("http://test/mcp", {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      }));
      const text = await res.text();
      const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
      if (json.error) return { error: json.error, text: "", isError: true, data: null };
      const body = json.result.content[0].text as string;
      let data: any = null;
      for (const candidate of [body, body.slice(body.indexOf("\n\n") + 2)]) {
        try { data = JSON.parse(candidate); break; } catch { /* next form */ }
      }
      return { text: body, isError: !!json.result.isError, data };
    };
    await fn({ keys, call, fetch: (req) => Promise.resolve(app.fetch(req)), sql: db(), seedFile });
  } finally {
    await closeDb();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    for (const [k, v] of Object.entries(previous)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}
