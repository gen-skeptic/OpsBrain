// OpsBrain administration CLI. Run it on the server (it uses DATABASE_URL directly).
//
//   deno task admin principal add <handle> --name "Name" --kind human|agent|service --role owner|admin|member|agent|auditor
//                                [--email x] [--title x] [--can-approve] [--responsible <handle>]
//   deno task admin principal list | disable <handle> | enable <handle>
//   deno task admin key issue <handle> [--label x] [--expires-days N]     (prints the raw key ONCE)
//   deno task admin key list <handle> | key revoke <hash-prefix>
//   deno task admin delegate <handle> <agent-handle>... | --all-agents      (let a key act as agents)
//   deno task admin undelegate <handle> <agent-handle>
//   deno task admin area add <slug> --name "Name" [--owner <handle>] [--order N]
//   deno task admin project add <id> --name "Name" [--kind client_engagement|internal] [--client x] [--area slug] [--owner handle]
//   deno task admin seed <file.json>                                        (idempotent bulk load)
//   deno task admin reembed [--limit N]                                      (fill missing embeddings)
import { closeDb, db, vectorLiteral } from "../server/db.ts";
import { newRawKey, sha256Hex } from "../server/auth.ts";
import { embed } from "../server/ai.ts";
import { seedStages } from "../server/crm.ts";

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const s = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : null);

async function idOf(handle: string): Promise<string> {
  const r = await db()`SELECT id FROM ops_principals WHERE handle = ${handle.toLowerCase()}`;
  if (!r.length) throw new Error(`No principal "${handle}"`);
  return r[0].id;
}

type Seed = {
  areas?: { slug: string; name: string; description?: string; sort_order?: number; owner?: string }[];
  principals?: { handle: string; display_name: string; kind: string; role: string; job_title?: string; email?: string; can_approve?: boolean; responsible?: string; metadata?: Record<string, unknown> }[];
  processes?: { id: string; name: string; area?: string; owner?: string; metadata?: Record<string, unknown> }[];
  delegations?: { principal: string; may_act_as: string[] | "all-agents" }[];
  projects?: { id: string; name: string; kind?: string; client_name?: string; status?: string; area?: string; owner?: string; description?: string }[];
  /** CRM pipeline stages, in order. Replaces the active set; stages not listed are deactivated, never deleted. */
  pipeline_stages?: { slug: string; name: string; probability?: number; is_won?: boolean; is_lost?: boolean; gate_screen?: boolean; description?: string }[];
};

async function upsertPrincipal(p: NonNullable<Seed["principals"]>[number]) {
  const responsible = p.responsible ? await idOf(p.responsible) : null;
  await db()`
    INSERT INTO ops_principals (handle, display_name, kind, role, job_title, email, can_approve, responsible_human_id, metadata)
    VALUES (${p.handle.toLowerCase()}, ${p.display_name}, ${p.kind}, ${p.role}, ${p.job_title ?? null}, ${p.email ?? null},
            ${p.can_approve ?? false}, ${responsible}, ${db().json((p.metadata ?? {}) as never)})
    ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name, kind = EXCLUDED.kind, role = EXCLUDED.role,
      job_title = EXCLUDED.job_title, email = coalesce(EXCLUDED.email, ops_principals.email),
      can_approve = EXCLUDED.can_approve, responsible_human_id = coalesce(EXCLUDED.responsible_human_id, ops_principals.responsible_human_id),
      metadata = EXCLUDED.metadata`;
}

async function seed(path: string) {
  const data = JSON.parse(await Deno.readTextFile(path)) as Seed;
  const sql = db();
  // Humans first, so agents and services can name a responsible person.
  const principals = [...(data.principals ?? [])].sort((a, b) => (a.kind === "human" ? -1 : 0) - (b.kind === "human" ? -1 : 0));
  for (const p of principals) await upsertPrincipal(p);
  for (const a of data.areas ?? []) {
    await sql`
      INSERT INTO ops_areas (slug, name, description, sort_order, owner_id)
      VALUES (${a.slug}, ${a.name}, ${a.description ?? null}, ${a.sort_order ?? 100}, ${a.owner ? await idOf(a.owner) : null})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        sort_order = EXCLUDED.sort_order, owner_id = coalesce(EXCLUDED.owner_id, ops_areas.owner_id)`;
  }
  for (const p of data.processes ?? []) {
    await sql`
      INSERT INTO ops_processes (id, name, area_slug, owner_id, metadata)
      VALUES (${p.id}, ${p.name}, ${p.area ?? null}, ${p.owner ? await idOf(p.owner) : null}, ${sql.json((p.metadata ?? {}) as never)})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, area_slug = EXCLUDED.area_slug,
        owner_id = coalesce(EXCLUDED.owner_id, ops_processes.owner_id), metadata = EXCLUDED.metadata`;
  }
  for (const d of data.delegations ?? []) {
    const from = await idOf(d.principal);
    const targets = d.may_act_as === "all-agents"
      ? (await sql`SELECT id FROM ops_principals WHERE kind = 'agent' AND active`).map((r) => r.id)
      : await Promise.all(d.may_act_as.map(idOf));
    for (const t of targets) {
      if (t !== from) await sql`INSERT INTO ops_delegations (principal_id, may_act_as) VALUES (${from}, ${t}) ON CONFLICT DO NOTHING`;
    }
  }
  for (const p of data.projects ?? []) {
    await sql`
      INSERT INTO ops_projects (id, name, kind, client_name, status, area_slug, owner_id, description)
      VALUES (${p.id}, ${p.name}, ${p.kind ?? "internal"}, ${p.client_name ?? null}, ${p.status ?? "active"}, ${p.area ?? null},
              ${p.owner ? await idOf(p.owner) : null}, ${p.description ?? null})
      ON CONFLICT (id) DO NOTHING`;
  }
  if (data.pipeline_stages?.length) {
    const stages = data.pipeline_stages;
    if (stages.filter((x) => x.is_won).length !== 1 || stages.filter((x) => x.is_lost).length !== 1) {
      throw new Error("pipeline_stages needs exactly one won stage and one lost stage");
    }
    await seedStages(stages);
  }
  console.log(`Seeded ${principals.length} principals, ${data.areas?.length ?? 0} areas, ${data.processes?.length ?? 0} processes, ${data.delegations?.length ?? 0} delegation sets, ${data.projects?.length ?? 0} projects, ${data.pipeline_stages?.length ?? 0} pipeline stages`);
}

// Commands that are one word; the rest are "<group> <verb>" (principal add, key issue, ...).
const ONE_WORD = new Set(["seed", "delegate", "undelegate", "reembed"]);

export async function main(argv: string[] = Deno.args) {
  const { pos, flags } = parse(argv);
  const [group, cmd, ...rest] = pos;
  const sql = db();
  switch (ONE_WORD.has(group) ? group : `${group ?? ""} ${cmd ?? ""}`.trim()) {
    case "principal add": {
      const handle = rest[0];
      if (!handle || !s(flags, "name") || !s(flags, "kind")) throw new Error("usage: principal add <handle> --name N --kind K [--role R]");
      await upsertPrincipal({
        handle, display_name: s(flags, "name")!, kind: s(flags, "kind")!, role: s(flags, "role") ?? (s(flags, "kind") === "agent" ? "agent" : "member"),
        email: s(flags, "email") ?? undefined, job_title: s(flags, "title") ?? undefined, can_approve: flags["can-approve"] === true,
        responsible: s(flags, "responsible") ?? undefined,
      });
      console.log(`Principal ${handle} saved`);
      break;
    }
    case "principal list": {
      console.table(await sql`SELECT handle, display_name, kind, role, can_approve, active FROM ops_principals ORDER BY kind, handle`);
      break;
    }
    case "principal disable":
    case "principal enable": {
      await sql`UPDATE ops_principals SET active = ${cmd === "enable"} WHERE handle = ${rest[0]}`;
      console.log(`Principal ${rest[0]} ${cmd}d`);
      break;
    }
    case "key issue": {
      const pid = await idOf(rest[0]);
      const raw = newRawKey();
      const days = s(flags, "expires-days");
      await sql`
        INSERT INTO ops_principal_keys (key_hash, principal_id, label, expires_at)
        VALUES (${await sha256Hex(raw)}, ${pid}, ${s(flags, "label")}, ${days ? new Date(Date.now() + Number(days) * 86400_000) : null})`;
      console.log(`Key for ${rest[0]} (shown once; store it in your password manager or secret store):\n${raw}`);
      break;
    }
    case "key list": {
      console.table(await sql`
        SELECT left(k.key_hash, 12) AS hash_prefix, k.label, k.active, k.created_at, k.expires_at, k.last_used_at
          FROM ops_principal_keys k WHERE k.principal_id = ${await idOf(rest[0])} ORDER BY k.created_at`);
      break;
    }
    case "key revoke": {
      const prefix = rest[0];
      if (!prefix || prefix.length < 8) throw new Error("Give at least 8 characters of the key hash (see key list)");
      const r = await sql`
        UPDATE ops_principal_keys SET active = false, revoked_at = now()
         WHERE key_hash LIKE ${prefix.toLowerCase() + "%"} AND active RETURNING key_hash`;
      console.log(`Revoked ${r.length} key(s)`);
      break;
    }
    case "delegate": {
      const handle = cmd;
      if (!handle || (flags["all-agents"] !== true && !rest.length)) throw new Error("usage: delegate <handle> <agent-handle>... | --all-agents");
      await seed_delegation(handle, flags["all-agents"] === true ? "all-agents" : rest);
      break;
    }
    case "undelegate": {
      if (!cmd || !rest[0]) throw new Error("usage: undelegate <handle> <agent-handle>");
      await sql`DELETE FROM ops_delegations WHERE principal_id = ${await idOf(cmd)} AND may_act_as = ${await idOf(rest[0])}`;
      console.log(`Removed delegation ${cmd} → ${rest[0]}`);
      break;
    }
    case "area add": {
      await sql`
        INSERT INTO ops_areas (slug, name, owner_id, sort_order)
        VALUES (${rest[0]}, ${s(flags, "name") ?? rest[0]}, ${s(flags, "owner") ? await idOf(s(flags, "owner")!) : null}, ${Number(s(flags, "order") ?? 100)})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`;
      console.log(`Area ${rest[0]} saved`);
      break;
    }
    case "project add": {
      await sql`
        INSERT INTO ops_projects (id, name, kind, client_name, area_slug, owner_id)
        VALUES (${rest[0]}, ${s(flags, "name") ?? rest[0]}, ${s(flags, "kind") ?? "internal"}, ${s(flags, "client")},
                ${s(flags, "area")}, ${s(flags, "owner") ? await idOf(s(flags, "owner")!) : null})
        ON CONFLICT (id) DO NOTHING`;
      console.log(`Project ${rest[0]} saved`);
      break;
    }
    case "seed": {
      if (!cmd) throw new Error("usage: seed <file.json>");
      await seed(cmd);
      break;
    }
    case "reembed": {
      const limit = Number(s(flags, "limit") ?? 500);
      const rows = await sql`SELECT id, title, content FROM thoughts WHERE embedding IS NULL ORDER BY created_at LIMIT ${limit}`;
      let n = 0;
      for (const r of rows) {
        const v = await embed(`${r.title ?? ""}\n\n${r.content}`.trim());
        if (!v) { console.error("Embedding provider unavailable; stopping"); break; }
        await sql`UPDATE thoughts SET embedding = ${vectorLiteral(v)}::vector WHERE id = ${r.id}`;
        n++;
      }
      console.log(`Embedded ${n} of ${rows.length} records`);
      break;
    }
    default:
      console.log(new TextDecoder().decode(Deno.readFileSync(new URL(import.meta.url))).split("\n").filter((l) => l.startsWith("//")).join("\n"));
  }
}

async function seed_delegation(handle: string, targets: string[] | "all-agents") {
  const tmp = { delegations: [{ principal: handle, may_act_as: targets }] } as Seed;
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify(tmp));
  await seed(path);
  await Deno.remove(path);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    Deno.exitCode = 1;
  } finally {
    await closeDb();
  }
}

export { seed };
