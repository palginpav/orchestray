// _housekeeper-baseline.js — frozen baseline for the orchestray-housekeeper
// agent. MUTATING THIS FILE REQUIRES A COMMIT TAGGED [housekeeper-tools-extension].
// In the same commit you MUST also update agents/orchestray-housekeeper.md AND
// bin/__tests__/p33-housekeeper-whitelist-frozen.test.js.
//
// Drift detector: bin/audit-housekeeper-drift.js
// Frozen-baseline test: bin/__tests__/p33-housekeeper-whitelist-frozen.test.js
// See agents/pm-reference/haiku-routing.md §23f for the promotion path.

'use strict';

// SHA-256 of agents/orchestray-housekeeper.md at the v2.2.0 first commit.
// Computed by: node -e "console.log(require('crypto').createHash('sha256')
//   .update(require('fs').readFileSync('agents/orchestray-housekeeper.md'))
//   .digest('hex'))"
//
// Regenerated 2026-04-26 in orch-20260426T193005Z-v220-impl-phase3 (W9 fix-pass)
// for F-005 (line 24 prose now lists Grep alongside Edit/Write/Bash) and to add
// `housekeeper_savings_usd` to the Structured Result schema (S-002 telemetry
// extraction). tools: line is UNCHANGED — Clause 1 holds.
//
// Regenerated 2026-08-09 [housekeeper-tools-extension] for v2.3.23 Item 4: op
// class 3 (rollup recompute) must call mcp__orchestray__history_query_events
// instead of Glob+Read on the live events.jsonl (R-EVT-ROTATE). Clause 1 is
// amended, not lifted — the grant is exactly one narrowly-scoped, read-only
// MCP query tool; Edit/Write/Bash/Grep remain forbidden (Clause 2 unchanged).
// This bypasses the v2.2.1+ organic promotion criteria (60 days zero drift,
// 100 clean housekeeper_action events) in agents/pm-reference/haiku-routing.md
// §23f — those criteria govern discovery-driven broadening, not an explicit,
// user-locked scope requirement. Flagged for PM/architect confirmation.
const BASELINE_AGENT_SHA = '09830effc516707f55ac7a5e0fe56f01ce504e765464bc0e03903b8d3821b329';

// Exact line, including the 'tools: ' prefix and the bracket-list. Must be
// byte-identical to the line in the agent file. Newline is NOT included.
const BASELINE_TOOLS_LINE = 'tools: [Read, Glob, mcp__orchestray__history_query_events]';

module.exports = { BASELINE_AGENT_SHA, BASELINE_TOOLS_LINE };
