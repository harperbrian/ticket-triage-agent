import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";
import { TicketInput, TriageResult, TriageResultSchema } from "./types.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_ITERATIONS = 6;
// The model is instructed to return raw JSON only, but in practice it will
// sometimes wrap the answer in a markdown code fence or add a sentence of
// reasoning before it (observed live on the very first real run of this
// project — see README failure-mode table, row 5). Rather than relying
// purely on prompt compliance, extract the JSON defensively: strip a
// ```json ... ``` or ``` ... ``` fence if present, and otherwise fall back
// to grabbing the substring between the first "{" and the last "}".
function extractJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim();
  }

  return raw.trim();
}

const SYSTEM_PROMPT = `You are a support ticket triage agent for a B2B SaaS product.

For each ticket you receive, you must:
1. Classify its category: billing, technical, account_access, feature_request, or other.
2. Assess severity: P1 (critical/production-impacting), P2 (high), P3 (normal), P4 (low).
3. Look up the customer's account (plan tier, account age) using the lookup_customer tool
   whenever a customer_email is present. If no email was provided, or the lookup returns
   found: false, proceed on ticket content alone and lower your confidence accordingly —
   do not guess account details.
4. Search the knowledge base using the lookup_kb tool for a relevant known answer.
5. Decide a suggested_action:
   - "auto_reply" only if you found a confident, relevant KB match AND severity is P3 or P4.
   - "escalate" for anything P1 or P2, anything with no confident KB match, or anything
     genuinely ambiguous. If you escalate, call the escalate tool to log it with a brief reason.
6. If suggested_action is "auto_reply", include a short, courteous draft_reply grounded in
   the KB answer. Omit draft_reply entirely when escalating.

Be honest about confidence: a vague or ambiguous ticket should produce a LOW confidence score,
not a guessed classification presented as certain. Confidence should reflect how sure you
actually are, not just how the tools happened to respond.

When you are done gathering information, respond with ONLY a single JSON object — no prose,
no markdown code fences, nothing before or after it — matching exactly this shape:
{
  "ticket_id": string,
  "category": "billing" | "technical" | "account_access" | "feature_request" | "other",
  "severity": "P1" | "P2" | "P3" | "P4",
  "confidence": number between 0 and 1,
  "suggested_action": "auto_reply" | "escalate",
  "draft_reply": string (omit if escalating),
  "reasoning_summary": string (1-2 sentences on why you decided this)
}`;

export type TriageOutcome =
  | { ok: true; result: TriageResult }
  | { ok: false; error: string; rawOutput?: string };

export async function triageTicket(ticket: TicketInput): Promise<TriageOutcome> {
  const client = new Anthropic();

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Ticket to triage:\n${JSON.stringify(ticket, null, 2)}`,
    },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: toolDefinitions,
        messages,
      });
    } catch (err: any) {
      // Covers auth errors, rate limits, and transport failures — this is the
      // same failure category as the Finnhub 401/429 handling, one layer up.
      return { ok: false, error: `Claude API call failed: ${err?.message ?? String(err)}` };
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          let output: unknown;
          try {
            output = executeTool(block.name, block.input);
          } catch (err: any) {
            output = { error: `Tool execution failed: ${err?.message ?? String(err)}` };
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(output),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const rawText = textBlock?.text.trim() ?? "";
    const candidateJson = extractJsonText(rawText);

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateJson);
    } catch {
      return {
        ok: false,
        error: "Model did not return valid JSON on completion, even after attempting to extract it from markdown/prose.",
        rawOutput: rawText,
      };
    }

    const validated = TriageResultSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: `Model output did not match the expected schema: ${validated.error.message}`,
        rawOutput: rawText,
      };
    }

    return { ok: true, result: validated.data };
  }

  return {
    ok: false,
    error: `Exceeded ${MAX_TOOL_ITERATIONS} tool-use iterations without reaching a final answer.`,
  };
}
