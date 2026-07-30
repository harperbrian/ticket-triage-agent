import { z } from "zod";

export const TicketInputSchema = z.object({
  ticket_id: z.string().min(1, "ticket_id is required"),
  customer_email: z.string().email("customer_email must be a valid email").optional(),
  subject: z.string().optional(),
  body: z.string().min(1, "ticket body cannot be empty"),
});
export type TicketInput = z.infer<typeof TicketInputSchema>;

export const TriageResultSchema = z.object({
  ticket_id: z.string(),
  category: z.enum(["billing", "technical", "account_access", "feature_request", "other"]),
  severity: z.enum(["P1", "P2", "P3", "P4"]),
  confidence: z.number().min(0).max(1),
  suggested_action: z.enum(["auto_reply", "escalate"]),
  draft_reply: z.string().optional(),
  reasoning_summary: z.string(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;
