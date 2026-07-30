import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { TicketInputSchema } from "./types.js";
import { triageTicket } from "./agent.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run triage -- data/sample-tickets/01-clear-password-reset.json");
    process.exit(1);
    return;
  }

  const resolved = path.resolve(filePath);
  let raw = "";
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch (err: any) {
    console.error(`Could not read ticket file at ${resolved}: ${err?.message ?? err}`);
    process.exit(1);
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err: any) {
    console.error(`Ticket file is not valid JSON: ${err?.message ?? err}`);
    process.exit(1);
    return;
  }

  // Validation happens BEFORE any API call — a malformed ticket fails fast and
  // cheap here rather than burning a Claude call and failing downstream.
  const parsed = TicketInputSchema.safeParse(json);
  if (!parsed.success) {
    console.error("Ticket failed validation before ever reaching the agent:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
    return;
  }

  console.log(`Triaging ${parsed.data.ticket_id}...\n`);
  const outcome = await triageTicket(parsed.data);

  if (!outcome.ok) {
    console.error(`Triage failed: ${outcome.error}`);
    if (outcome.rawOutput) {
      console.error(`\nRaw model output:\n${outcome.rawOutput}`);
    }
    process.exit(1);
    return;
  }

  console.log(JSON.stringify(outcome.result, null, 2));
}

main();
