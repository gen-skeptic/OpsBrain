// Export OpsBrain to Markdown files organized with PARA.
//
//   deno task para:export        one export now
//   deno task para:schedule      long-running: exports at PARA_EXPORT_TIMES (default 4 times a day)
//
// Company-visible records go to PARA_OUTPUT_DIR. Restricted records go to
// PARA_RESTRICTED_DIR only when it is set (give that folder tighter file
// permissions); otherwise they are left out of the mirror.
import { closeDb, db } from "../server/db.ts";
import {
  type ExportRecord, type HistoryEntry, type LinkEntry, MARKER, placeRecord, type ProjectInfo, projectFolder,
  recordPath, renderAreaIndex, renderProjectIndex, renderRecord, renderRootIndex, ROOTS, safeName,
} from "./para.ts";
import { companyPath, type CrmContext, dealPath, pipelinePath, contactsPath, renderCompany, renderContacts, renderDeal, renderPipeline } from "./crm.ts";

export type ExportOptions = {
  outputDir: string;
  visibility: "company" | "restricted";
  archiveAfterDays: number;
  title: string;
  now?: Date;
  /** Folder for CRM pages under 2-Areas (default "CRM"). */
  crmFolder?: string;
  /** Include contact emails and phone numbers in the mirror (default false). */
  crmContactDetails?: boolean;
};

export type ExportResult = { written: number; unchanged: number; removed: number; total: number };

async function readIfExists(path: string): Promise<string | null> {
  try { return await Deno.readTextFile(path); } catch { return null; }
}

async function writeAtomic(path: string, content: string) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, path);
}

async function removeEmptyDirs(dir: string, root: string) {
  if (dir === root || !dir.startsWith(root)) return;
  try {
    for await (const _ of Deno.readDir(dir)) return;
    await Deno.remove(dir);
    await removeEmptyDirs(dir.slice(0, dir.lastIndexOf("/")), root);
  } catch { /* already gone */ }
}

export async function exportPara(o: ExportOptions): Promise<ExportResult> {
  const sql = db();
  const now = o.now ?? new Date();
  const root = o.outputDir.replace(/\/$/, "");
  const records = (await sql`SELECT * FROM ops_records WHERE visibility = ${o.visibility} ORDER BY created_at`) as unknown as ExportRecord[];
  const crmFolder = o.crmFolder ?? "CRM";
  // Records about CRM companies (activities, proposals...) without a project or area live with the CRM.
  for (const r of records as unknown as Record<string, unknown>[]) {
    if (!r.area_name && !r.project_id && r.crm_company_id) r.area_name = crmFolder;
  }
  const projects = (await sql`
    SELECT p.*, o.handle AS owner FROM ops_projects p LEFT JOIN ops_principals o ON o.id = p.owner_id ORDER BY p.id`) as unknown as ProjectInfo[];
  const ids = records.map((r) => r.id);
  const history = ids.length ? await sql`
    SELECT record_id, created_at, actor, action, comment FROM (
      SELECT e.record_id, e.created_at, a.handle AS actor, e.action, e.comment,
             row_number() OVER (PARTITION BY e.record_id ORDER BY e.created_at DESC, e.id DESC) AS n
        FROM ops_record_events e LEFT JOIN ops_principals a ON a.id = e.actor_id
       WHERE e.record_id = ANY(${ids}::uuid[])) h
     WHERE n <= 15 ORDER BY created_at DESC` : [];
  const links = ids.length ? await sql`
    SELECT l.from_id, l.to_id, l.relation, f.title AS from_title, t.title AS to_title
      FROM ops_record_links l JOIN thoughts f ON f.id = l.from_id JOIN thoughts t ON t.id = l.to_id
     WHERE l.from_id = ANY(${ids}::uuid[]) OR l.to_id = ANY(${ids}::uuid[])` : [];

  const histBy = new Map<string, HistoryEntry[]>();
  for (const h of history) {
    const arr = histBy.get(h.record_id) ?? [];
    arr.push(h as unknown as HistoryEntry);
    histBy.set(h.record_id, arr);
  }
  const linksBy = new Map<string, LinkEntry[]>();
  for (const l of links) {
    (linksBy.get(l.from_id) ?? linksBy.set(l.from_id, []).get(l.from_id)!).push({ relation: l.relation, direction: "outgoing", id: l.to_id, title: l.to_title });
    (linksBy.get(l.to_id) ?? linksBy.set(l.to_id, []).get(l.to_id)!).push({ relation: l.relation, direction: "incoming", id: l.from_id, title: l.from_title });
  }

  const pathOf = new Map<string, string>();
  for (const r of records) pathOf.set(r.id, recordPath(r, now, o.archiveAfterDays));

  const files = new Map<string, string>();
  const byProject = new Map<string, { path: string; r: ExportRecord }[]>();
  const byArea = new Map<string, { path: string; r: ExportRecord }[]>();
  for (const r of records) {
    const path = pathOf.get(r.id)!;
    files.set(path, renderRecord(r, path, histBy.get(r.id) ?? [], linksBy.get(r.id) ?? [], (id) => pathOf.get(id)));
    const place = placeRecord(r, now, o.archiveAfterDays);
    if (place.bucket === "project" && r.project_id) (byProject.get(r.project_id) ?? byProject.set(r.project_id, []).get(r.project_id)!).push({ path, r });
    if (place.bucket === "area") {
      const a = safeName(r.area_name ?? "General");
      (byArea.get(a) ?? byArea.set(a, []).get(a)!).push({ path, r });
    }
  }

  // Index notes for every project (active or archived) and every area with records.
  const projectEntries: { folder: string; p: ProjectInfo; count: number }[] = [];
  for (const p of projects) {
    const folder = projectFolder(p.id, p.name);
    const closed = p.status === "completed" || p.status === "cancelled";
    const recs = byProject.get(p.id) ?? [];
    const all = records.filter((r) => r.project_id === p.id).map((r) => ({ path: pathOf.get(r.id)!, r }));
    if (o.visibility === "restricted" && !all.length) continue;
    const indexPath = closed ? `${ROOTS.archive}/Projects/${folder}/_index.md` : `${ROOTS.project}/${folder}/_index.md`;
    files.set(indexPath, renderProjectIndex(p, closed ? all : recs, indexPath));
    projectEntries.push({ folder, p, count: all.length });
  }
  const areaEntries = [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, recs]) => {
    const indexPath = `${ROOTS.area}/${folder}/_index.md`;
    files.set(indexPath, renderAreaIndex(folder, recs, indexPath));
    return { folder, count: recs.length };
  });
  // CRM pages (company mirror only; CRM entries are company-visible).
  let crm: { pipeline: string; openDeals: number } | undefined;
  if (o.visibility === "company") {
    const companies = await sql`SELECT c.*, o.handle AS owner FROM crm_companies c LEFT JOIN ops_principals o ON o.id = c.owner_id ORDER BY lower(c.name)`;
    if (companies.length) {
      const contacts = await sql`SELECT * FROM crm_contacts ORDER BY lower(full_name)`;
      const deals = await sql`SELECT * FROM crm_deals_view ORDER BY stage_order, updated_at DESC`;
      const stages = await sql`
        SELECT * FROM crm_pipeline_stages s
         WHERE active OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.stage = s.slug AND d.archived_at IS NULL)
         ORDER BY sort_order`;
      const x: CrmContext = { folder: crmFolder, now, archiveAfterDays: o.archiveAfterDays, contactDetails: o.crmContactDetails ?? false, recordPath: (id) => pathOf.get(id) };
      const byId = new Map(companies.map((c) => [c.id as string, c]));
      const linked = (key: string, id: string) =>
        (records as unknown as Record<string, unknown>[]).filter((r) => r[key] === id)
          .sort((a, b) => +new Date(String((b.fields as Record<string, unknown>)?.occurred_at ?? b.created_at)) - +new Date(String((a.fields as Record<string, unknown>)?.occurred_at ?? a.created_at)));
      for (const c of companies) {
        files.set(companyPath(c, x), renderCompany(c, contacts.filter((p) => p.company_id === c.id), deals.filter((d) => d.company_id === c.id), linked("crm_company_id", c.id), x));
      }
      for (const d of deals) files.set(dealPath(d, x), renderDeal(d, byId.get(d.company_id), linked("crm_deal_id", d.id), x));
      files.set(pipelinePath(x), renderPipeline(stages, deals, byId, x));
      files.set(contactsPath(x), renderContacts(contacts, byId, x));
      crm = { pipeline: pipelinePath(x), openDeals: deals.filter((d) => !d.is_won && !d.is_lost && !d.archived_at).length };
    }
  }

  const pending = records.filter((r) => r.requires_approval && r.approval_status === "pending").map((r) => ({ path: pathOf.get(r.id)!, r }));
  const recent = [...records].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)).slice(0, 25).map((r) => ({ path: pathOf.get(r.id)!, r }));
  files.set("README.md", renderRootIndex({ title: o.title, exportedAt: now, projects: projectEntries, areas: areaEntries, pending, recent, total: records.length, crm }));

  // Write only what changed; remove files this exporter generated before but no longer produces.
  await Deno.mkdir(`${root}/.opsbrain`, { recursive: true });
  const manifestPath = `${root}/.opsbrain/manifest.json`;
  const previous: string[] = JSON.parse((await readIfExists(manifestPath)) ?? "[]");
  let written = 0, unchanged = 0, removed = 0;
  for (const [rel, content] of files) {
    const full = `${root}/${rel}`;
    if ((await readIfExists(full)) === content) { unchanged++; continue; }
    await writeAtomic(full, content);
    written++;
  }
  for (const rel of previous) {
    if (files.has(rel)) continue;
    const full = `${root}/${rel}`;
    const existing = await readIfExists(full);
    if (existing !== null && existing.includes(MARKER)) {
      await Deno.remove(full);
      removed++;
      await removeEmptyDirs(full.slice(0, full.lastIndexOf("/")), root);
    }
  }
  await writeAtomic(manifestPath, JSON.stringify([...files.keys()].sort(), null, 1));
  return { written, unchanged, removed, total: records.length };
}

async function gitCommit(dir: string, push: boolean) {
  const run = async (...args: string[]) => {
    // Identity for export commits; override with PARA_GIT_AUTHOR_NAME / PARA_GIT_AUTHOR_EMAIL.
    const name = Deno.env.get("PARA_GIT_AUTHOR_NAME") || "OpsBrain export";
    const email = Deno.env.get("PARA_GIT_AUTHOR_EMAIL") || "opsbrain@localhost";
    const out = await new Deno.Command("git", {
      args: ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-C", dir, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { ok: out.success, text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
  };
  if (!(await run("rev-parse", "--is-inside-work-tree")).ok) return;
  await run("add", "-A");
  if ((await run("diff", "--cached", "--quiet")).ok) return; // nothing changed
  const c = await run("commit", "-m", `OpsBrain export ${new Date().toISOString().slice(0, 16)}`);
  if (!c.ok) console.error(`git commit failed: ${c.text}`);
  else if (push) {
    const p = await run("push");
    if (!p.ok) console.error(`git push failed: ${p.text}`);
  }
}

export async function runConfiguredExport(): Promise<void> {
  const env = (k: string, d: string) => Deno.env.get(k) || d;
  const archiveAfterDays = Number(env("PARA_ARCHIVE_AFTER_DAYS", "30"));
  const title = env("PARA_TITLE", "OpsBrain");
  const out = env("PARA_OUTPUT_DIR", "./para-output");
  const started = Date.now();
  const crmFolder = env("PARA_CRM_FOLDER", "CRM");
  const crmContactDetails = ["1", "true", "yes"].includes(env("PARA_CRM_CONTACT_DETAILS", "false").toLowerCase());
  const main = await exportPara({ outputDir: out, visibility: "company", archiveAfterDays, title, crmFolder, crmContactDetails });
  console.log(`PARA export to ${out}: ${main.total} records, ${main.written} written, ${main.unchanged} unchanged, ${main.removed} removed (${Date.now() - started} ms)`);
  const restricted = Deno.env.get("PARA_RESTRICTED_DIR");
  if (restricted) {
    const r = await exportPara({ outputDir: restricted, visibility: "restricted", archiveAfterDays, title: `${title} (restricted)`, crmFolder });
    console.log(`Restricted export to ${restricted}: ${r.total} records, ${r.written} written, ${r.removed} removed`);
  }
  const commit = ["1", "true", "yes"].includes((Deno.env.get("PARA_GIT_COMMIT") ?? "").toLowerCase());
  const push = ["1", "true", "yes"].includes((Deno.env.get("PARA_GIT_PUSH") ?? "").toLowerCase());
  if (commit) {
    await gitCommit(out, push);
    if (restricted) await gitCommit(restricted, push);
  }
}

if (import.meta.main) {
  try {
    await runConfiguredExport();
  } finally {
    await closeDb();
  }
}
