// Fictional demo data for README screenshots. Every company, person and amount here is made up.
// Run it only against an empty scratch database, never a real OpsBrain:
//   OPSBRAIN_DEMO=1 DATABASE_URL=postgres://.../opsbrain_demo deno run -A tools/readme/demo-data.ts
// It prints a sign-in key for the demo owner, which tools/readme/screenshots.js uses.
import { closeDb, db } from "../../server/db.ts";
import { migrate } from "../../db/migrate.ts";
import { main as admin } from "../../admin/opsbrain-admin.ts";
import { newRawKey, principalByHandle, resolveCtx, sha256Hex } from "../../server/auth.ts";
import * as crm from "../../server/crm.ts";
import { createRecord, decideApproval, upsertProject } from "../../server/records.ts";

if (Deno.env.get("OPSBRAIN_DEMO") !== "1") throw new Error("Set OPSBRAIN_DEMO=1 to confirm this is a scratch database");
await migrate(() => {});
const [{ n }] = await db()`SELECT count(*)::int AS n FROM ops_principals`;
if (n > 0) throw new Error("This database already has principals; demo data goes only into an empty scratch database");

const seed = await Deno.makeTempFile({ suffix: ".json" });
await Deno.writeTextFile(seed, JSON.stringify({
  areas: [
    { slug: "sales-and-clients", name: "Sales and clients", sort_order: 1 },
    { slug: "service-delivery", name: "Service delivery", sort_order: 2 },
    { slug: "company-operations", name: "Company operations", sort_order: 3 },
  ],
  principals: [
    { handle: "erich", display_name: "Erich Dautel", kind: "human", role: "owner", can_approve: true, job_title: "Owner" },
    { handle: "maria", display_name: "Maria Lopez", kind: "human", role: "member", job_title: "Operations" },
    { handle: "dio-business-development", display_name: "Business Development", kind: "agent", role: "agent", responsible: "erich" },
    { handle: "dio-client-success-manager", display_name: "Client Success Manager", kind: "agent", role: "agent", responsible: "erich" },
    { handle: "dio-platform-devops-engineer", display_name: "Platform and DevOps Engineer", kind: "agent", role: "agent", responsible: "erich" },
    { handle: "dio-main-session", display_name: "Main session", kind: "service", role: "agent", responsible: "erich" },
  ],
  delegations: [{ principal: "dio-main-session", may_act_as: "all-agents" }],
}));
await admin(["seed", seed]);

const erich = (await principalByHandle("erich"))!;
const session = (await principalByHandle("dio-main-session"))!;
const owner = await resolveCtx(erich, undefined);
const as = (agent: string) => resolveCtx(session, agent);
const bd = await as("dio-business-development");
const cs = await as("dio-client-success-manager");
const days = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

// Companies and contacts
const companies: [string, string, string, string, string][] = [
  ["Acme Dental", "acmedental.example", "Dental practice", "10-49", "Boca Raton"],
  ["Beta Law Group", "betalaw.example", "Law firm", "10-49", "West Palm Beach"],
  ["Coral Bay Property Management", "coralbay.example", "Property management", "50-99", "Delray Beach"],
  ["Harbor CPA Partners", "harborcpa.example", "Accounting", "10-49", "Jupiter"],
  ["Seaside Pediatrics", "seasidepeds.example", "Medical practice", "50-99", "Boynton Beach"],
  ["Northwind Logistics", "northwind.example", "Logistics", "100-249", "Fort Lauderdale"],
  ["Gulfstream Builders", "gulfstream.example", "Construction", "10-49", "Lake Worth"],
];
for (const [name, domain, industry, size, city] of companies) {
  await crm.upsertCompany(bd, { name, domain, industry, size_band: size, city, region: "FL", country: "US", source: "referral" });
}
await crm.upsertCompany(bd, { id: "gulfstream.example", flag_for_screen: true, screen_note: "Conflict-of-interest check before we scope" });
const contacts: [string, string, string, string][] = [
  ["Dana Ortiz", "dana@acmedental.example", "acmedental.example", "Practice manager"],
  ["Sam Patel", "sam@betalaw.example", "betalaw.example", "Managing partner"],
  ["Lena Brooks", "lena@coralbay.example", "coralbay.example", "Director of operations"],
  ["Marcus Hill", "marcus@harborcpa.example", "harborcpa.example", "Partner"],
  ["Priya Shah", "priya@seasidepeds.example", "seasidepeds.example", "Office administrator"],
];
for (const [full_name, email, company, job_title] of contacts) {
  await crm.upsertContact(bd, { full_name, email, company, job_title, consent: "opted_in", consent_source: "Fit call, asked to stay in touch" });
}

// Deals across the pipeline
const deal = async (ctx: typeof bd, d: crm.DealInput) => (await crm.upsertDeal(ctx, d))!.id;
const acme = await deal(bd, { name: "Patient intake automation", company: "acmedental.example", primary_contact: "dana@acmedental.example", service_line: "B", amount: 12500, recurring_monthly: 1500, expected_close: days(21) });
await crm.upsertDeal(bd, { id: acme, stage: "qualified" });
await crm.upsertDeal(bd, { id: acme, stage: "meeting" });
await crm.upsertDeal(bd, { id: acme, stage: "proposal", next_step: "Walk Dana through the proposal", next_step_due: days(3) });
const beta = await deal(bd, { name: "AI readiness assessment", company: "betalaw.example", primary_contact: "sam@betalaw.example", service_line: "A", amount: 4500, expected_close: days(14), next_step: "Send the fit-call summary", next_step_due: days(-2) });
await crm.upsertDeal(bd, { id: beta, stage: "qualified" });
const betaDocs = await deal(bd, { name: "Document workflow build", company: "betalaw.example", service_line: "G", amount: 9000, expected_close: days(60) });
const coral = await deal(bd, { name: "Tenant request triage agent", company: "coralbay.example", primary_contact: "lena@coralbay.example", service_line: "B", amount: 18000, recurring_monthly: 2000, expected_close: days(30), next_step: "Scoping workshop", next_step_due: days(5) });
await crm.upsertDeal(bd, { id: coral, stage: "meeting" });
const harbor = await deal(bd, { name: "Month-end close Kaizen", company: "harborcpa.example", primary_contact: "marcus@harborcpa.example", service_line: "H", amount: 7500, expected_close: days(10), next_step: "Agree on the redlined SOW", next_step_due: days(2) });
for (const stage of ["qualified", "meeting", "proposal", "negotiation"]) await crm.upsertDeal(bd, { id: harbor, stage });
const seaside = await deal(bd, { name: "Managed agent operations", company: "seasidepeds.example", primary_contact: "priya@seasidepeds.example", service_line: "D", amount: 3000, recurring_monthly: 2500, expected_close: days(-3) });
for (const stage of ["qualified", "meeting", "proposal"]) await crm.upsertDeal(bd, { id: seaside, stage });
await crm.upsertDeal(owner, { id: seaside, stage: "won", comment: "SOW signed" });
await crm.startEngagement(cs, seaside, "SEA-01", { area: "service-delivery" });
const north = await deal(bd, { name: "Dispatch automation", company: "northwind.example", service_line: "B", amount: 24000 });
await crm.upsertDeal(bd, { id: north, stage: "lost", lost_reason: "Chose an in-house build" });
await deal(bd, { name: "Field scheduling assistant", company: "gulfstream.example", service_line: "B", amount: 6000 });

// Activities
await crm.logActivity(bd, { kind: "call", deal: acme, contact: "dana@acmedental.example", direction: "outbound", summary: "Discovery call. Front desk spends about 6 hours a week retyping intake forms into the practice system. Dana wants new-patient intake live before March.", outcome: "Interested; wants a proposal" });
await crm.logActivity(bd, { kind: "meeting", deal: acme, contact: "dana@acmedental.example", summary: "Walked through the current intake process with the front desk. Mapped three handoffs and two duplicate entry points to fix before any automation.", outcome: "Process map agreed" });
await crm.logActivity(bd, { kind: "meeting", deal: coral, contact: "lena@coralbay.example", summary: "Reviewed 200 recent tenant requests. About 60% are routine and could be triaged automatically once categories are standardized.", outcome: "Scoping workshop booked" });
await crm.logActivity(cs, { kind: "email", deal: seaside, contact: "priya@seasidepeds.example", direction: "outbound", summary: "Sent the kickoff agenda and the access request checklist.", outcome: "Kickoff confirmed" });
await db()`UPDATE crm_deals SET created_at = now() - interval '24 days' WHERE id = ${betaDocs}`;

// Records that link to the CRM and wait for approval
await createRecord(bd, { record_type: "proposal", title: "Acme Dental: patient intake automation proposal", content: "Scope: fix the intake handoffs, then automate new-patient intake into the practice system, staff training.\nPrice: $12,500 build, then $1,500 a month for managed operations.", deal: acme, financial_or_ethical: true });
await createRecord(bd, { record_type: "decision", title: "Founding-client discount for Harbor CPA", content: "Offer 10% off the Kaizen engagement in exchange for a case study.\nOptions: no discount; 10% for a case study; 15% for a case study and a referral.", deal: harbor, financial_or_ethical: true, fields: { options: ["none", "10% + case study", "15% + case study + referral"] } });
const deploy = await as("dio-platform-devops-engineer");
await createRecord(deploy, { record_type: "change_record", title: "Deploy Seaside intake v1.2 to production", content: "Client accepted v1.2 on staging. Rollback: redeploy v1.1 (tested). Window: Thursday 7 pm.", project_id: "SEA-01", requires_approval: true });
const old = await createRecord(bd, { record_type: "invoice", title: "Seaside Pediatrics deposit invoice", content: "Deposit: $1,500 due on receipt.", deal: seaside, financial_or_ethical: true });
await decideApproval(owner, old.id, "approve", "Send it");
await upsertProject(owner, { id: "INT-OPS", name: "Stand up OpsBrain", kind: "internal", area: "company-operations" });

const key = newRawKey();
await db()`INSERT INTO ops_principal_keys (key_hash, principal_id, label) VALUES (${await sha256Hex(key)}, ${erich.id}, 'readme screenshots')`;
console.log(key);
await closeDb();
