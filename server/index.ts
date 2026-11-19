// OpsBrain server entry point: a self-hosted MCP server for company records.
// Run with `deno task start` (applies migrations first) or `deno task serve`.
import { buildApp } from "./app.ts";
import { config } from "./config.ts";

const app = buildApp();
Deno.serve({
  hostname: config.host,
  port: config.port,
  onListen: ({ hostname, port }) => console.log(`OpsBrain listening on http://${hostname}:${port} (MCP at /mcp, health at /healthz)`),
}, app.fetch);
