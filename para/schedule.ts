// Long-running PARA export scheduler for Docker Compose and single servers.
// Exports at each time in PARA_EXPORT_TIMES (local time, set TZ), default four
// times a day: 00:00, 06:00, 12:00 and 18:00. On Kubernetes, use the CronJob in
// deploy/k8s instead of this loop.
import { runConfiguredExport } from "./export.ts";

const times = (Deno.env.get("PARA_EXPORT_TIMES") || "00:00,06:00,12:00,18:00")
  .split(",").map((t) => t.trim()).filter((t) => /^\d{2}:\d{2}$/.test(t));
if (!times.length) throw new Error("PARA_EXPORT_TIMES must list times like 00:00,06:00,12:00,18:00");

let lastSlot = "";
let running = false;

async function tick() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const slot = `${now.toDateString()} ${hhmm}`;
  if (!times.includes(hhmm) || slot === lastSlot || running) return;
  lastSlot = slot;
  running = true;
  try {
    await runConfiguredExport();
  } catch (err) {
    console.error(`PARA export failed: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

console.log(`PARA export scheduled at ${times.join(", ")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
if (["1", "true", "yes"].includes((Deno.env.get("PARA_EXPORT_ON_START") ?? "true").toLowerCase())) {
  try { await runConfiguredExport(); } catch (err) { console.error(`PARA export failed: ${(err as Error).message}`); }
}
setInterval(tick, 20_000);
