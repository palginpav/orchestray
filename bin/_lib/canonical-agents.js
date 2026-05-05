'use strict';

/**
 * canonical-agents.js — single source of truth for canonical agent names.
 *
 * v2.3.1: extracted from three diverging literals in gate-agent-spawn.js,
 * audit-event.js, and ox.js. Drift between these sets was a
 * privilege-escalation risk (an attacker could pick a name "dynamic" relative
 * to one and "canonical" relative to another).
 *
 * Importers: bin/gate-agent-spawn.js, bin/audit-event.js, bin/ox.js,
 *            bin/_lib/custom-agents.js (for reserved-name collision check).
 *
 * Adding a new core agent: add the name here. `npm test` will fail on any
 * fixture that hard-codes a stale list (canonical-agents-parity.test.js).
 *
 * Set members:
 *   - 14 Orchestray core agents (pm … platform-oracle)
 *   - 2 new v2.3.1 additions: project-intent, curate-runner
 *     (already in pm.md's parenthetical; absent from the old literals — gap closed here)
 *   - 4 hook-spawned agents (curator, haiku-scout, orchestray-housekeeper,
 *     pattern-extractor) — present in agents/*.md; spawned by hook scripts, not
 *     directly by pm.md. Gap closed in v2.3.1 fix-pass.
 *   - 4 Claude Code built-in agent types (Explore, Plan, general-purpose, Task)
 *     NOT considered "dynamic"; they are platform primitives.
 */
const CANONICAL_AGENTS = Object.freeze(new Set([
  'pm', 'architect', 'developer', 'refactorer', 'inventor', 'researcher',
  'reviewer', 'debugger', 'tester', 'documenter', 'security-engineer',
  'release-manager', 'ux-critic', 'platform-oracle',
  // v2.3.1 additions — present in pm.md already; now canonical in the gate
  'project-intent', 'curate-runner',
  // v2.3.1 fix-pass: hook-spawned agents absent from old literals; gap closed
  'curator', 'haiku-scout', 'orchestray-housekeeper', 'pattern-extractor',
  // Claude Code built-in platform primitives
  'Explore', 'Plan', 'general-purpose', 'Task',
]));

module.exports = { CANONICAL_AGENTS };
