import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

interface KbArticle {
  topic: string;
  keywords: string[];
  answer_summary: string;
}

interface Customer {
  email: string;
  plan_tier: string;
  account_age_days: number;
}

let kbCache: KbArticle[] | null = null;
let customerCache: Customer[] | null = null;

function loadKb(): KbArticle[] {
  if (!kbCache) {
    kbCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "kb-articles.json"), "utf-8"));
  }
  return kbCache!;
}

function loadCustomers(): Customer[] {
  if (!customerCache) {
    customerCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "customers.json"), "utf-8"));
  }
  return customerCache!;
}

export function lookupKb(query: string): {
  found: boolean;
  topic?: string;
  answer_summary?: string;
} {
  const articles = loadKb();
  const q = query.toLowerCase();
  const match = articles.find((a) => a.keywords.some((k) => q.includes(k.toLowerCase())));
  if (!match) return { found: false };
  return { found: true, topic: match.topic, answer_summary: match.answer_summary };
}

export function lookupCustomer(email: string): {
  found: boolean;
  plan_tier?: string;
  account_age_days?: number;
} {
  const customers = loadCustomers();
  const match = customers.find((c) => c.email.toLowerCase() === email.toLowerCase());
  if (!match) return { found: false };
  return { found: true, plan_tier: match.plan_tier, account_age_days: match.account_age_days };
}

interface EscalationLogEntry {
  ticket_id: string;
  reason: string;
  timestamp: string;
}
const escalationLog: EscalationLogEntry[] = [];

export function escalate(ticket_id: string, reason: string): { logged: boolean } {
  const entry: EscalationLogEntry = { ticket_id, reason, timestamp: new Date().toISOString() };
  escalationLog.push(entry);
  console.log(`  [ESCALATION LOGGED] ${ticket_id}: ${reason}`);
  return { logged: true };
}

export function getEscalationLog(): EscalationLogEntry[] {
  return escalationLog;
}

// Tool definitions passed to the Anthropic API — the descriptions are what the
// model actually reads to decide when and how to call each tool.
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "lookup_kb",
    description:
      "Search the internal knowledge base for a known answer to a customer's issue. Pass a short query describing the problem (e.g. the ticket subject or a key phrase from the body). Returns whether a matching article was found and its summary.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Short description of the customer's issue to search for",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_customer",
    description:
      "Look up a customer's account details (plan tier, account age in days) by email address. Use this to inform severity and escalation decisions — e.g. enterprise or long-tenured accounts may warrant faster escalation. If no customer_email was provided on the ticket, or the lookup returns found: false, proceed using ticket content alone and reflect the missing context in your confidence score.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The customer's email address" },
      },
      required: ["email"],
    },
  },
  {
    name: "escalate",
    description:
      "Log an escalation for a ticket that needs human review. Use for P1/P2 severity, low-confidence classifications, or anything the knowledge base does not resolve.",
    input_schema: {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        reason: { type: "string", description: "Brief reason for the escalation" },
      },
      required: ["ticket_id", "reason"],
    },
  },
];

export function executeTool(name: string, input: any): any {
  switch (name) {
    case "lookup_kb":
      return lookupKb(input.query);
    case "lookup_customer":
      return lookupCustomer(input.email);
    case "escalate":
      return escalate(input.ticket_id, input.reason);
    default:
      // Deliberately surfaced rather than thrown past the caller — this is one
      // of the documented failure modes (see README): the agent should see this
      // as a tool_result error and recover, not crash the process.
      return { error: `Unknown tool requested: ${name}` };
  }
}
