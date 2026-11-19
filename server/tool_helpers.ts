// Shared helpers for MCP tool handlers.
import { z } from "zod";
import { AccessError, type Principal, resolveCtx } from "./auth.ts";
import { InputError } from "./errors.ts";

export const PRIVACY =
  " Never store client confidential data (client systems, customer records, credentials, health or financial data) or client deliverables in OpsBrain; store company records about the work, and link to deliverables in the client's own systems.";

export const actingAs = z.string().optional().describe(
  "Handle of the agent you are acting as (e.g. dio-chief-of-staff). Required when one key is shared by several agents in a session; must be delegated to your key.",
);

export const ro = { readOnlyHint: true };
export const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

export function ok(value: unknown, summary?: string): Result {
  const text = (summary ? summary + "\n\n" : "") + JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): Result {
  const e = err as Error & { code?: string };
  let msg = e.message ?? String(err);
  if (e.code === "23503") msg = `A referenced project, area, process, record type or principal does not exist (${msg})`;
  if (e.code === "23505") msg = `That value must be unique (${msg})`;
  const denied = err instanceof AccessError || e.code === "42501";
  const invalid = err instanceof InputError || e.code === "23514" || e.code === "22P02" || e.code === "22007" || e.code === "22008";
  const kind = denied ? "Not allowed" : invalid ? "Invalid input" : "Error";
  return { content: [{ type: "text", text: `${kind}: ${msg}` }], isError: true };
}

export type ToolCtx = Awaited<ReturnType<typeof resolveCtx>>;

export function run<A extends { acting_as?: string }>(auth: Principal, fn: (ctx: ToolCtx, args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try {
      const ctx = await resolveCtx(auth, args.acting_as);
      return await fn(ctx, args);
    } catch (err) {
      return fail(err);
    }
  };
}
