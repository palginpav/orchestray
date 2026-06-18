'use strict';

/**
 * v2.3.12 W16 (C1) — mechanical MCP allowlist-drift detector.
 *
 * Asserts the four allowlist surfaces stay in agreement so the half-shipped
 * allowlist class of bug (audit F1) cannot silently recur:
 *   1. Every registered tool (server.js TOOL_TABLE) is either PM-intended OR in
 *      DOCUMENTED_EXCLUSIONS.
 *   2. Every PM-intended tool is present in pm.md `tools:` AND in
 *      DEFAULT_MCP_ENFORCEMENT (config-schema.js).
 *
 * Parses server.js / pm.md as TEXT (not require) so the MCP server is not booted.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { DEFAULT_MCP_ENFORCEMENT } = require('../../bin/_lib/config-schema');

function readServerToolNames() {
  const src = fs.readFileSync(path.join(ROOT, 'bin/mcp-server/server.js'), 'utf8');
  // Extract the TOOL_TABLE = Object.freeze({ ... }); block.
  const m = src.match(/const TOOL_TABLE = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(m, 'TOOL_TABLE block found');
  // Top-level keys are `  <name>: {`.
  const names = [];
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s{2}([a-z_]+):\s*\{/);
    if (km) names.push(km[1]);
  }
  return names;
}

function readDocumentedExclusions() {
  const src = fs.readFileSync(path.join(ROOT, 'bin/mcp-server/server.js'), 'utf8');
  const m = src.match(/const DOCUMENTED_EXCLUSIONS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'DOCUMENTED_EXCLUSIONS block found');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

function readPmToolNames() {
  const src = fs.readFileSync(path.join(ROOT, 'agents/pm.md'), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('tools:'));
  assert.ok(line, 'pm.md tools: line found');
  return [...line.matchAll(/mcp__orchestray__([a-z_]+)/g)].map(x => x[1]);
}

// Tools that are PM-callable (in pm.md) but intentionally absent from
// DEFAULT_MCP_ENFORCEMENT: ask_user is budget-gated in elicit/ (not enable-gated),
// and the per-tool enforcement map is advisory — read-only tools that simply
// aren't listed fall through to unknown_tool_policy, which only gates
// agent-dispatch tools, not mcp__orchestray__* calls (per the v2.3.12 MCP audit).
const ENFORCEMENT_EXEMPT = new Set(['ask_user', 'history_query_events']);

test('every registered tool is reachable in pm.md or a documented exclusion', () => {
  const registered = readServerToolNames();
  const exclusions = new Set(readDocumentedExclusions());
  const pmTools = new Set(readPmToolNames());

  for (const tool of registered) {
    if (exclusions.has(tool)) continue;
    assert.ok(
      pmTools.has(tool),
      `registered tool "${tool}" is unreachable: missing from pm.md tools: (add it, or to DOCUMENTED_EXCLUSIONS in server.js)`
    );
  }
});

test('JIT verbs pattern_read + schema_get are PM-callable AND enforcement-registered', () => {
  const pmTools = new Set(readPmToolNames());
  const enforcement = new Set(Object.keys(DEFAULT_MCP_ENFORCEMENT));
  for (const verb of ['pattern_read', 'schema_get']) {
    assert.ok(pmTools.has(verb), `${verb} in pm.md tools:`);
    assert.ok(enforcement.has(verb), `${verb} in DEFAULT_MCP_ENFORCEMENT`);
  }
  assert.ok(!ENFORCEMENT_EXEMPT.has('pattern_read')); // guard: JIT verbs are not exempt
});

test('documented exclusions are NOT in pm.md (genuinely excluded)', () => {
  const exclusions = readDocumentedExclusions();
  const pmTools = new Set(readPmToolNames());
  for (const x of exclusions) {
    assert.ok(!pmTools.has(x), `excluded tool "${x}" should not be in pm.md tools:`);
  }
});
