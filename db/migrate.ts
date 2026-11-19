// Apply db/migrations/*.sql in order, once each. Safe to run on every start.
// Usage: deno task migrate
import { closeDb, db } from "../server/db.ts";
import { config } from "../server/config.ts";

export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS opsbrain_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql`SELECT id FROM opsbrain_migrations`).map((r) => r.id as string));
  const dir = new URL("./migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)].filter((f) => f.isFile && f.name.endsWith(".sql")).map((f) => f.name).sort();
  const dim = config.embeddingDim;
  if (!Number.isInteger(dim) || dim < 2 || dim > 16000) throw new Error(`EMBEDDING_DIM must be an integer, got ${dim}`);

  for (const name of files) {
    if (applied.has(name)) continue;
    const text = Deno.readTextFileSync(new URL(name, dir)).replaceAll("{{EMBEDDING_DIM}}", String(dim));
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO opsbrain_migrations (id) VALUES (${name})`;
    });
    log(`Applied ${name}`);
  }

  // pgvector stores the dimension as the column's type modifier.
  const [col] = await sql`
    SELECT atttypmod AS dim FROM pg_attribute
     WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding'`;
  if (col && col.dim > 0 && col.dim !== dim) {
    throw new Error(
      `thoughts.embedding has ${col.dim} dimensions but EMBEDDING_DIM is ${dim}. ` +
      `Set EMBEDDING_DIM=${col.dim} and use a matching embedding model, or migrate the column deliberately.`,
    );
  }
}

if (import.meta.main) {
  try {
    await migrate();
    console.log("Migrations up to date");
  } finally {
    await closeDb();
  }
}
