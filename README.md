# Ticket Triage Agent

This agent triages support tickets using Claude's native tool use. It
classifies each ticket, looks up customer and knowledge-base context
through its own tool calls, and decides whether to draft an auto-reply or
escalate to a human. A confidence gate keeps a human in the loop. The
agent never auto-sends a reply on its own.

It covers a common support problem (intake, classify, route,
escalate-if-uncertain) as a working code artifact. I built it on my own
time and equipment, and it runs on mock data only.

## Architecture

```
CLI (ticket JSON file)
   │
   ▼
Zod schema validation  ──── malformed ticket rejected here, before any API call
   │
   ▼
Claude API (tool-use loop)
   │
   ├── lookup_customer(email)  → local mock CRM (data/customers.json)
   ├── lookup_kb(query)        → local mock knowledge base (data/kb-articles.json)
   └── escalate(ticket_id, reason) → logs escalation, printed to console
   │
   ▼
Structured JSON output (validated against a Zod schema)
   │
   ▼
category / severity / confidence / suggested_action / draft_reply
```

The agent decides which tools to call and in what order for each ticket.
That's what separates an agent from a workflow with an AI step bolted on:
the sequence changes with the input instead of following a fixed branch.

## Why local mock data instead of a real CRM/KB

Local mock data keeps the demo self-contained and free to run
indefinitely. No external service to configure, no API keys beyond
Anthropic's, nothing that can go down or expire before an interview.
`data/customers.json` and `data/kb-articles.json` stay small and readable,
so you can extend them to test new scenarios.

## Setup

Requires Node.js 18+.

```bash
git clone https://github.com/harperbrian/ticket-triage-agent.git
cd ticket-triage-agent
npm install
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
```

## Usage

```bash
npm run triage -- data/sample-tickets/01-clear-password-reset.json
```

The sample tickets in `data/sample-tickets/` cover a range on purpose: a
clear case, an ambiguous one, an unknown customer, a P1, and two built to
break the pipeline. Run each one and compare the results.

## Failure modes (found by deliberately trying to break it)

| # | Trigger | Sample ticket | Observed behavior | Notes |
|---|---------|---------------|--------------------|-------|
| 1 | Malformed/empty ticket | `06-malformed-missing-fields.json` | Rejected at the Zod schema layer with `body: ticket body cannot be empty`. The request never reached the API. Zero cost. | Validation runs before any API call by design. Bad input fails fast and cheap instead of burning a token on a request that was always going to fail. |
| 2 | Ambiguous ticket | `03-ambiguous-vague.json` | Confidence dropped to **0.3** (vs. 0.78 to 0.95 on clear tickets), no KB match found, and it escalated. | Real gap: even at 0.3 confidence, the schema still forces a specific `category` and `severity`. There's no "unknown" option. The confidence score is honest; the fields underneath it aren't. Name this limitation directly in a production-readiness discussion. |
| 3 | Unknown customer | `04-unknown-customer.json` | `lookup_customer` returned `found: false`. The agent cited the missing account info as the reason it couldn't confidently resolve the ticket. Confidence landed at **0.52**. It escalated. | No crash, no invented account details. The model treated missing context as a reason for caution, not something to ignore. |
| 4 | Non-JSON final output | `01-clear-password-reset.json` (first live run) | The model wrapped its JSON answer in a sentence of prose and a markdown code fence, despite an explicit "ONLY JSON, nothing else" instruction. The original `JSON.parse` call failed cleanly. It preserved the raw output and didn't crash. | **Fix shipped:** added a defensive `extractJsonText()` step in `agent.ts` that strips markdown fences and extracts the `{...}` substring before parsing. Prompt compliance alone isn't reliable; models drift from formatting instructions even when told explicitly. |
| 5 | Same-ticket run-to-run non-determinism | `01-clear-password-reset.json` (run twice) | Identical ticket returned **P3 / 0.82 / auto_reply** on one run and **P2 / 0.88 / escalate** on another. | Not a bug. This is a real characteristic of LLM-based agents on borderline-ambiguous input. Identical tickets can get different categorical outcomes between runs. A production deployment needs an answer for that (confidence thresholds, human review sampling) before running unsupervised. See the measurement below: this observation did not reproduce. |
| 6 | Nuanced KB instruction-following | `02-billing-mismatch.json` | The KB article said "do not issue credits directly, flag to Billing team." The agent escalated instead of defaulting to auto_reply just because a KB match existed. | Positive finding, not a failure. The agent reads tool-result content, not just tool-result presence, when deciding how to act. |
| 7 | Clear-cut contrast cases | `05-urgent-p1.json`, `07-api-error-free-tier.json` | P1 outage returned 0.95 confidence and escalated even though a plausible KB fix existed, because severity overrode a tidy KB match. Free-tier 403 error returned 0.78 confidence, correct P3 auto_reply with a grounded draft. | Confirms the confidence score isn't clustering artificially high. It spans a real 0.3 to 0.95 range tied to actual ticket clarity across this test set. |
| 8 | API/transport failure | *(not empirically triggered in this test pass)* | Untested live. Would require deliberately invalidating the API key mid-run. | Handled defensively via try/catch in `agent.ts`, same failure category as the Finnhub connector's 401/429 handling. Flagged as a known gap, not claimed as verified. |

Seven of the eight rows were observed live against the Claude API. Row 8
is a code-level safeguard that was not triggered.

### Row 5 was later measured properly

That row was an anecdote: one observation, noticed by hand. I built a
separate evaluation harness to turn it into a measurement:
**[ticket-triage-eval-harness](https://github.com/harperbrian/ticket-triage-eval-harness)**,
which runs a fixed 18-ticket set through this agent 8 times each and reports
how often the classification actually changes.

What it found, measuring this agent at the commit the harness pins:

- **The T-1001 instability did not reproduce.** Eight identical runs returned
  `account_access / P3 / auto_reply` every time. The behaviour in row 5 is real
  but rarer than 1-in-8.
- **A different ticket flipped the decision instead.** On the unknown-customer
  export ticket, the agent auto-replied on 5 of 8 identical runs and escalated
  on 3, sending tier-dependent advice to a customer whose tier it had no way
  to look up.
- **6 of 17 tickets drifted**, and every run that reached the model returned
  valid, schema-conforming output.

The harness treats this repo as a read-only measurement target, pinned by
commit, and does not modify it.

## Honest framing

This is a real, working artifact built with AI assistance (Claude and
Claude Code). I designed the tool-use flow, the schema validation, and
the confidence-gated routing logic. I debugged and validated seven of the
eight failure modes listed above against the live API. I'm not presenting
this as unaided, from-scratch software engineering, and it doesn't
represent production-grade TypeScript authorship independent of AI
assistance. Same framing applies to my other MCP project:
github.com/harperbrian/finnhub-connector.

## License

MIT
