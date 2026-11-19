import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { type ExportRecord, fileName, MARKER, placeRecord, relLink, renderRecord, safeName } from "../para/para.ts";

const now = new Date("2026-11-19T12:00:00Z");

function rec(over: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: "0f3a2b1c-1111-2222-3333-444455556666", record_type: "task_card", record_type_name: "Task card", type_folder: "Task cards",
    para_default: "project", terminal_statuses: ["done", "cancelled"], title: "Sprint 3 tests", content: "Run the tests.",
    status: "ready", external_ref: null, project_id: null, project_name: null, project_kind: null, project_status: null,
    client_name: null, area_slug: "service-delivery", area_name: "Service delivery", process_id: "P09", process_name: "Custom software",
    process_step: 12, para_override: null, resource_topic: null, priority: null, due_on: null, tags: [], fields: {},
    visibility: "company", financial_or_ethical: false, requires_approval: false, approval_status: null, approved_by: null,
    approved_at: null, version: 1, archived_at: null, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-18T10:00:00Z",
    owner: "dio-software-engineering-lead", assignee: "dio-qa-test-automation-engineer", created_by: "dio-software-engineering-lead",
    updated_by: null, authenticated_as: "erich-claude-code", on_behalf_of: "erich", ...over,
  };
}

Deno.test("records in an active project go to 1-Projects", () => {
  const p = placeRecord(rec({ project_id: "ACME-01", project_name: "Acme portal", project_status: "active" }), now, 30);
  assertEquals(p.dir, ["1-Projects", "ACME-01 - Acme portal", "Task cards"]);
});

Deno.test("records of a completed project go to the archive", () => {
  const p = placeRecord(rec({ project_id: "ACME-01", project_name: "Acme portal", project_status: "completed" }), now, 30);
  assertEquals(p.dir, ["4-Archive", "Projects", "ACME-01 - Acme portal", "Task cards"]);
});

Deno.test("records without a project go to their area", () => {
  assertEquals(placeRecord(rec(), now, 30).dir, ["2-Areas", "Service delivery", "Task cards"]);
  assertEquals(placeRecord(rec({ area_name: null }), now, 30).dir, ["2-Areas", "General", "Task cards"]);
});

Deno.test("finished area records are archived only after the grace period", () => {
  assertEquals(placeRecord(rec({ status: "done" }), now, 30).bucket, "area");
  assertEquals(placeRecord(rec({ status: "done", updated_at: "2026-09-01T00:00:00Z" }), now, 30).dir, ["4-Archive", "Areas", "Service delivery", "Task cards"]);
});

Deno.test("resources go to 3-Resources by topic, and overrides win", () => {
  const sop = rec({ record_type: "sop", record_type_name: "SOP", type_folder: "SOPs", para_default: "resource", tags: ["onboarding"] });
  assertEquals(placeRecord(sop, now, 30).dir, ["3-Resources", "onboarding"]);
  assertEquals(placeRecord(rec({ resource_topic: "Kubernetes", para_override: "resource" }), now, 30).dir, ["3-Resources", "Kubernetes"]);
  assertEquals(placeRecord(rec({ archived_at: "2026-11-02T00:00:00Z" }), now, 30).bucket, "archive");
});

Deno.test("file names are safe and stable", () => {
  assertEquals(fileName(rec({ title: 'QA: "sprint" 3 / fail?' })), "2026-11-01 QA sprint 3 fail (0f3a2b1c).md");
  assertEquals(safeName("  ../../etc  "), "etc");
  assertEquals(safeName(""), "Untitled");
});

Deno.test("relative links between generated files", () => {
  assertEquals(relLink("1-Projects/A/Task cards/x.md", "1-Projects/A/QA records/y.md"), "../QA%20records/y.md");
  assertEquals(relLink("README.md", "2-Areas/B/z.md"), "2-Areas/B/z.md");
});

Deno.test("rendered record has front matter, marker, attribution and history", () => {
  const md = renderRecord(rec({ fields: { findings: 2 } }), "2-Areas/x.md", [{ created_at: "2026-11-02T09:00:00Z", actor: "dio-quality-reviewer", action: "comment", comment: "Looks good | mostly" }], [], () => undefined);
  assert(md.startsWith("---\nid: "));
  assertStringIncludes(md, MARKER);
  assertStringIncludes(md, 'on_behalf_of: "erich"');
  assertStringIncludes(md, "| findings | 2 |");
  assertStringIncludes(md, "Looks good \\| mostly");
});
