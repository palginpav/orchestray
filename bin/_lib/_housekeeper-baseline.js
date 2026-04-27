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
const BASELINE_AGENT_SHA = 'a8d45e3b4e86d61653b14bd0e23220086da290131f7fcda4b9174fe940df596e';

// Exact line, including the 'tools: ' prefix and the bracket-list. Must be
// byte-identical to the line in the agent file. Newline is NOT included.
const BASELINE_TOOLS_LINE = 'tools: [Read, Glob]';

module.exports = { BASELINE_AGENT_SHA, BASELINE_TOOLS_LINE };
