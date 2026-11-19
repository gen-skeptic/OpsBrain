// MCP tools for the CRM: companies, contacts, deals, activities and the pipeline.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Principal } from "./auth.ts";
import * as crm from "./crm.ts";
import { InputError } from "./errors.ts";
import { actingAs, ok, ro, run, rw } from "./tool_helpers.ts";

const CRM_PRIVACY =
  " Business contact details only (name, role, work email and phone). Never store client confidential data, personal data from client systems, or full email bodies; summarize instead.";

const common = {
  owner: z.string().optional().describe("Handle of the accountable owner (defaults to you on create)"),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional().describe("Short notes; log conversations with crm_log_activity instead"),
  fields: z.record(z.string(), z.unknown()).optional().describe("Extra structured data (merged into existing fields)"),
  archived: z.boolean().optional().describe("Archive (true) or restore (false); nothing is ever deleted"),
  expected_version: z.number().int().optional().describe("Fail instead of overwriting if someone changed it since you read it"),
  comment: z.string().optional().describe("Why the change was made (kept in history)"),
  acting_as: actingAs,
};

export function registerCrmTools(server: McpServer, auth: Principal) {
  server.registerTool("crm_upsert_company", {
    title: "Create or update CRM company",
    description:
      `Create or update a company in the CRM. Matches an existing company by id, then domain, then exact name, so repeating a call updates instead of duplicating. Set flag_for_screen when a prospect needs the owner's screen (for example the employer-boundary screen); deals then cannot pass the screened stages until a person with approval rights clears it.${CRM_PRIVACY}`,
    annotations: { ...rw, idempotentHint: true },
    inputSchema: {
      id: z.string().optional().describe("Company ID, domain or exact name of an existing company"),
      name: z.string().optional().describe("Required for a new company"),
      domain: z.string().optional().describe("Web domain, e.g. acme.com (unique)"),
      website: z.string().optional(), industry: z.string().optional(),
      size_band: z.enum(crm.SIZE_BANDS).optional().describe("Employees"),
      phone: z.string().optional().describe("Main business line"),
      city: z.string().optional(), region: z.string().optional(), country: z.string().optional(),
      lifecycle: z.enum(crm.LIFECYCLES).optional(),
      source: z.string().optional().describe("Where it came from: referral, website, event, outbound, marketplace..."),
      flag_for_screen: z.boolean().optional(), screen_note: z.string().optional().describe("Why it needs a screen"),
      ...common,
    },
  }, run(auth, async (ctx, a: any) => {
    const r = await crm.upsertCompany(ctx, a);
    return ok(r, `${r!.created ? "Created" : r!.changed ? "Updated" : "No change to"} company ${r!.id}`);
  }));

  server.registerTool("crm_screen_company", {
    title: "Decide a company screen",
    description: "Clear or decline a company's screen (for example the employer-boundary screen). Only a person with approval rights, using their own key, can do this; declining also marks the company disqualified.",
    annotations: { ...rw, idempotentHint: true },
    inputSchema: {
      company: z.string().describe("Company ID, domain or exact name"),
      decision: z.enum(["cleared", "declined", "not_needed"]),
      note: z.string().optional(),
    },
  }, run(auth, async (ctx, a: any) => ok(await crm.screenCompany(ctx, a.company, a.decision, a.note))));

  server.registerTool("crm_upsert_contact", {
    title: "Create or update CRM contact",
    description:
      `Create or update a business contact. Matches an existing contact by id, then email. Record marketing consent (opted_in / opted_out, with its source) and do_not_contact; never send marketing to anyone without consent or marked do_not_contact.${CRM_PRIVACY}`,
    annotations: { ...rw, idempotentHint: true },
    inputSchema: {
      id: z.string().optional().describe("Contact ID, email or exact name of an existing contact"),
      full_name: z.string().optional().describe("Required for a new contact"),
      email: z.string().optional().describe("Work email (unique)"),
      company: z.string().optional().describe("Company ID, domain or exact name"),
      job_title: z.string().optional(), phone: z.string().optional().describe("Work phone"),
      linkedin_url: z.string().optional(),
      consent: z.enum(crm.CONSENT).optional().describe("Marketing consent"),
      consent_source: z.string().optional().describe("How consent was given or withdrawn"),
      do_not_contact: z.boolean().optional(),
      ...common,
    },
  }, run(auth, async (ctx, a: any) => {
    const r = await crm.upsertContact(ctx, a);
    return ok(r, `${r!.created ? "Created" : r!.changed ? "Updated" : "No change to"} contact ${r!.id}`);
  }));

  server.registerTool("crm_upsert_deal", {
    title: "Create or update CRM deal",
    description:
      "Create a deal (an opportunity in the pipeline) or update one: stage, amount, expected close, next step. Closing as lost needs a lost_reason. Marking a deal won is a financial decision: only a person with approval rights can do it, with their own key; agents prepare the proposal and contract records for approval instead. Stage changes are kept in the deal's history.",
    annotations: { ...rw, idempotentHint: false },
    inputSchema: {
      id: z.string().optional().describe("Deal ID or exact name of an existing deal; omit to create"),
      name: z.string().optional().describe("Required for a new deal, e.g. 'Acme intake automation'"),
      company: z.string().optional().describe("Company ID, domain or exact name (required for a new deal)"),
      primary_contact: z.string().optional().describe("Contact ID, email or exact name"),
      stage: z.string().optional().describe("Pipeline stage slug (see crm_pipeline); defaults to the first stage"),
      service_line: z.string().optional().describe("What is being sold, e.g. a service line code"),
      amount: z.union([z.number(), z.string()]).optional().describe("One-time value"),
      recurring_monthly: z.union([z.number(), z.string()]).optional().describe("Monthly recurring value (retainers)"),
      currency: z.string().optional().describe("ISO code, default USD"),
      probability: z.number().int().optional().describe("Override the stage's probability (0-100)"),
      expected_close: z.string().optional().describe("YYYY-MM-DD"),
      source: z.string().optional(),
      next_step: z.string().optional(), next_step_due: z.string().optional().describe("YYYY-MM-DD"),
      lost_reason: z.string().optional(),
      project_id: z.string().optional().describe("Engagement project this deal became"),
      ...common,
    },
  }, run(auth, async (ctx, a: any) => {
    const r = await crm.upsertDeal(ctx, a);
    return ok(r, `${r!.created ? "Created" : r!.changed ? "Updated" : "No change to"} deal ${r!.id} (stage ${r!.stage})`);
  }));

  server.registerTool("crm_start_engagement", {
    title: "Start engagement from deal",
    description: "Create the client engagement project for a deal (normally after it is won) and link the two. Records for the engagement then go in that project.",
    annotations: { ...rw, idempotentHint: true },
    inputSchema: {
      deal: z.string().describe("Deal ID or exact name"),
      project_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$/).describe("Engagement ID, e.g. ACME-01"),
      name: z.string().optional(), area: z.string().optional(), owner: z.string().optional(),
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => ok(await crm.startEngagement(ctx, a.deal, a.project_id, a))));

  server.registerTool("crm_log_activity", {
    title: "Log CRM activity",
    description:
      `Log a call, email, meeting, message or note with a company, contact or deal, as a summary (who, what was discussed, decisions, next step), never the full email. Updates the last-activity date used to find stale deals, and optionally the deal's next step.${CRM_PRIVACY}`,
    annotations: { ...rw, idempotentHint: false },
    inputSchema: {
      kind: z.enum(crm.ACTIVITY_KINDS),
      summary: z.string().describe("What happened, in Markdown"),
      title: z.string().optional(),
      occurred_at: z.string().optional().describe("ISO date or time; defaults to now"),
      direction: z.enum(["inbound", "outbound"]).optional(),
      outcome: z.string().optional(),
      company: z.string().optional(), contact: z.string().optional(), deal: z.string().optional(),
      project_id: z.string().optional(),
      next_step: z.string().optional(), next_step_due: z.string().optional().describe("YYYY-MM-DD; sets the deal's next step"),
      visibility: z.enum(["company", "restricted"]).optional(),
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => {
    const r = await crm.logActivity(ctx, a);
    return ok(r, `Logged ${a.kind}: ${r.title}`);
  }));

  server.registerTool("crm_get", {
    title: "Get CRM company, contact or deal",
    description: "Read a company (with contacts, deals, engagements, linked records and history), a contact or a deal. Give exactly one of company, contact or deal.",
    annotations: ro,
    inputSchema: {
      company: z.string().optional().describe("ID, domain or exact name"),
      contact: z.string().optional().describe("ID, email or exact name"),
      deal: z.string().optional().describe("ID or exact name"),
      acting_as: actingAs,
    },
  }, run(auth, async (ctx, a: any) => {
    if (a.company) return ok(await crm.getCompany(ctx, a.company));
    if (a.contact) return ok(await crm.getContact(ctx, a.contact));
    if (a.deal) return ok(await crm.getDeal(ctx, a.deal));
    throw new InputError("Give company, contact or deal");
  }));

  server.registerTool("crm_search", {
    title: "Search CRM",
    description: "Find companies (name, domain, industry), contacts (name, email, title, company) and deals (name, company).",
    annotations: ro,
    inputSchema: {
      query: z.string(), type: z.enum(["company", "contact", "deal"]).optional(),
      include_archived: z.boolean().optional(), acting_as: actingAs,
    },
  }, run(auth, async (_ctx, a: any) => ok(await crm.searchCrm(a.query, a.type, a.include_archived ?? false))));

  server.registerTool("crm_list", {
    title: "List CRM companies, contacts or deals",
    description: "List companies (filter by lifecycle, owner), contacts (by company, owner) or deals (by stage, company, owner, open only).",
    annotations: ro,
    inputSchema: {
      type: z.enum(["company", "contact", "deal"]),
      q: z.string().optional(), lifecycle: z.enum(crm.LIFECYCLES).optional(), owner: z.string().optional(),
      company: z.string().optional(), stage: z.string().optional(), open: z.boolean().optional(),
      include_archived: z.boolean().optional(), limit: z.number().int().optional(), offset: z.number().int().optional(),
      acting_as: actingAs,
    },
  }, run(auth, async (_ctx, a: any) => {
    if (a.type === "company") return ok(await crm.listCompanies(a));
    if (a.type === "contact") return ok(await crm.listContacts(a));
    return ok(await crm.listDeals(a));
  }));

  server.registerTool("crm_pipeline", {
    title: "CRM pipeline",
    description: "The pipeline by stage with counts, amounts and a weighted forecast; deals closed recently; and what needs attention: stale deals with no activity, overdue next steps and companies waiting for a screen. Also lists the stage slugs.",
    annotations: ro,
    inputSchema: {
      owner: z.string().optional(), service_line: z.string().optional(),
      closed_days: z.number().int().optional().describe("Include deals closed in the last N days (default 30)"),
      stale_days: z.number().int().optional().describe("Open deals with no activity for N days are stale (default 14)"),
      acting_as: actingAs,
    },
  }, run(auth, async (_ctx, a: any) => ok(await crm.pipeline(a))));
}
