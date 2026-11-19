// Shared Postgres connection (postgres.js). Works with any Postgres that has
// pgvector: Docker, CloudNativePG on Kubernetes, or a self-hosted Supabase.
import postgres from "postgres";
import { config } from "./config.ts";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function db(): Sql {
  if (!client) {
    client = postgres(config.databaseUrl, {
      max: Number(Deno.env.get("DATABASE_POOL_SIZE") ?? "10"),
      idle_timeout: 30,
      onnotice: () => {},
    });
  }
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = null;
  }
}

/** pgvector literal for a numeric array. */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
