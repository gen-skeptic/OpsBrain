// HTTP layer: health check, per-principal authentication, MCP over Streamable HTTP.
import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { authenticate } from "./auth.ts";
import { buildServer } from "./tools.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, x-opsbrain-key, x-brain-key, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error envelope (HTTP 200) so strict MCP hosts surface the auth
// failure instead of dropping the connection (same approach as Open Brain).
async function unauthorized(req: Request): Promise<Response> {
  let id: string | number | null = null;
  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      if (body && (typeof body.id === "string" || typeof body.id === "number")) id = body.id;
    } catch { /* malformed body */ }
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing, invalid, revoked or expired OpsBrain key." }, id }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function keyFrom(req: Request): string | null {
  const h = req.headers;
  const bearer = h.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = h.get("x-opsbrain-key") ?? h.get("x-brain-key") ?? bearer ?? null;
  if (key) return key;
  return config.allowQueryKey ? new URL(req.url).searchParams.get("key") : null;
}

export function buildApp(): Hono {
  const app = new Hono();

  app.options("*", (c) => c.text("ok", 200, corsHeaders));

  app.get("/healthz", async (c) => {
    try {
      await db()`SELECT 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // OpsBrain runs stateless: no server-initiated SSE stream and no sessions. Per the MCP spec, answer GET
  // and DELETE with 405 so clients use plain POST instead of holding open (or retrying) an empty stream.
  app.on(["GET", "DELETE", "PUT", "PATCH"], "*", (c) => c.text("Method Not Allowed: OpsBrain accepts MCP requests by POST.", 405, { ...corsHeaders, Allow: "POST, OPTIONS" }));

  app.all("*", async (c) => {
    const principal = await authenticate(keyFrom(c.req.raw));
    if (!principal) return await unauthorized(c.req.raw);

    // Some connectors omit the Accept header the transport requires.
    if (!c.req.header("accept")?.includes("text/event-stream")) {
      const headers = new Headers(c.req.raw.headers);
      headers.set("Accept", "application/json, text/event-stream");
      const patched = new Request(c.req.raw.url, {
        method: c.req.raw.method, headers, body: c.req.raw.body,
        // @ts-ignore duplex is required for streaming bodies
        duplex: "half",
      });
      Object.defineProperty(c.req, "raw", { value: patched, writable: true });
    }

    const server = buildServer(principal);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(c);
    if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
    response.headers.delete("mcp-session-id");
    for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
    return response;
  });

  return app;
}
