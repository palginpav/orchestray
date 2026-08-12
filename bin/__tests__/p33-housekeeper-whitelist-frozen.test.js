#!/usr/bin/env node
'use strict';

/**
 * p33-housekeeper-whitelist-frozen.test.js — P3.3 agent-file `tools:` byte-equality.
 *
 * Layer (c) of the three-layer tool-whitelist enforcement (P3.3 Clause 2): a
 * drift-detector test that fails CI on any byte-level mutation of the
 * `agents/orchestray-housekeeper.md` `tools:` line OR a SHA mismatch versus
 * the baseline pinned in `bin/_lib/_housekeeper-baseline.js`.
 *
 * Per `feedback_explore_agent_readonly.md`: drift on a read-only role's tool
 * list MUST be observable. Promotion to a wider whitelist requires a commit
 * tagged `[housekeeper-tools-extension]` updating BOTH this test's pinned
 * baseline AND the agent file in the same commit.
 *
 * Runner: node --test bin/__tests__/p33-housekeeper-whitelist-frozen.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOUSEKEEPER_PATH = path.join(REPO_ROOT, 'agents', 'orchestray-housekeeper.md');
const BASELINE_PATH = path.join(REPO_ROOT, 'bin', '_lib', '_housekeeper-baseline.js');
const VALIDATE_PATH = path.join(REPO_ROOT, 'bin', 'validate-task-completion.js');

// The literal expected `tools:` line. STRICTER than scout (no Grep).
// Editing this constant is a binding contract: it must move in lockstep
// with `BASELINE_TOOLS_LINE` in `_housekeeper-baseline.js` AND the agent
// file frontmatter, in a commit tagged `[housekeeper-tools-extension]`.
//
// Amended 2026-08-09 (v2.3.23 Item 4, R-EVT-ROTATE): Clause 1 grants exactly
// one narrowly-scoped, read-only MCP tool (history_query_events) so op class
// 3 can stop Reading the live events.jsonl. Edit/Write/Bash/Grep remain
// forbidden — Clause 2 (below) is unchanged.
//
// Amended 2026-08-12 (V6, scope-locked v2327): `Glob` removed from the grant.
// It was never used by any op class; this narrows (not promotes) the
// whitelist, so it does not require a [housekeeper-tools-extension] tag.
const EXPECTED_TOOLS_LINE = 'tools: [Read, mcp__orchestray__history_query_events]';
const HOUSEKEEPER_FORBIDDEN_TOOLS = ['Edit', 'Write', 'Bash', 'Grep', 'Glob'];

const PLACEHOLDER_SHA = 'REPLACE_DURING_IMPL_COMMIT_64HEX';

describe('P3.3 — orchestray-housekeeper agent file frozen baseline', () => {

  test('agents/orchestray-housekeeper.md exists', () => {
    assert.ok(fs.existsSync(HOUSEKEEPER_PATH),
      'Expected agents/orchestray-housekeeper.md at ' + HOUSEKEEPER_PATH);
  });

  test('bin/_lib/_housekeeper-baseline.js exists and exports both constants', () => {
    assert.ok(fs.existsSync(BASELINE_PATH),
      'Expected bin/_lib/_housekeeper-baseline.js at ' + BASELINE_PATH);
    const baseline = require(BASELINE_PATH);
    assert.equal(typeof baseline.BASELINE_AGENT_SHA, 'string',
      'BASELINE_AGENT_SHA must be a string');
    assert.equal(typeof baseline.BASELINE_TOOLS_LINE, 'string',
      'BASELINE_TOOLS_LINE must be a string');
  });

  test('BASELINE_AGENT_SHA is not the placeholder', () => {
    const { BASELINE_AGENT_SHA } = require(BASELINE_PATH);
    assert.notEqual(BASELINE_AGENT_SHA, PLACEHOLDER_SHA,
      'BASELINE_AGENT_SHA still holds the placeholder string. The implementer\n' +
      'forgot to fill it in. Compute via:\n' +
      '  node -e "console.log(require(\\"crypto\\").createHash(\\"sha256\\")\n' +
      '    .update(require(\\"fs\\").readFileSync(\\"agents/orchestray-housekeeper.md\\"))\n' +
      '    .digest(\\"hex\\"))"\n' +
      'and replace the placeholder in bin/_lib/_housekeeper-baseline.js.');
    assert.match(BASELINE_AGENT_SHA, /^[0-9a-f]{64}$/,
      'BASELINE_AGENT_SHA must be 64 hex chars (sha256). Actual: ' +
      JSON.stringify(BASELINE_AGENT_SHA));
  });

  test('BASELINE_TOOLS_LINE literally equals "tools: [Read, mcp__orchestray__history_query_events]"', () => {
    const { BASELINE_TOOLS_LINE } = require(BASELINE_PATH);
    assert.equal(BASELINE_TOOLS_LINE, EXPECTED_TOOLS_LINE,
      'BASELINE_TOOLS_LINE drifted from the locked-scope D-5 Clause 1 contract\n' +
      '(as amended by v2.3.23 Item 4, narrowed V6 scope-locked v2327).\n' +
      '  Expected: ' + JSON.stringify(EXPECTED_TOOLS_LINE) + '\n' +
      '  Actual:   ' + JSON.stringify(BASELINE_TOOLS_LINE) + '\n' +
      'Housekeeper tools are FROZEN at [Read, history_query_events] as of\n' +
      'V6 — still STRICTER than the scout (no Grep, no Glob, no other MCP tools).\n' +
      'Further promotion requires an explicit commit tagged\n' +
      '[housekeeper-tools-extension] updating both this constant and the\n' +
      'agent file. See agents/pm-reference/cost-prediction.md §32.');
    // Guard against accidental scout-equality
    assert.notEqual(BASELINE_TOOLS_LINE, 'tools: [Read, Glob, Grep]',
      'BASELINE_TOOLS_LINE matches the SCOUT whitelist (includes Grep). ' +
      'The housekeeper is intentionally stricter; revert this change.');
  });

  test('agent file `tools:` line byte-equals BASELINE_TOOLS_LINE', () => {
    const { BASELINE_TOOLS_LINE } = require(BASELINE_PATH);
    const body = fs.readFileSync(HOUSEKEEPER_PATH, 'utf8');
    const lines = body.split('\n');
    const toolsLine = lines.find(l => l.startsWith('tools:'));
    assert.ok(typeof toolsLine === 'string',
      'no `tools:` line found in agents/orchestray-housekeeper.md');
    assert.equal(toolsLine, BASELINE_TOOLS_LINE,
      'agent file `tools:` line drifted from the frozen baseline.\n' +
      '  Expected: ' + JSON.stringify(BASELINE_TOOLS_LINE) + '\n' +
      '  Actual:   ' + JSON.stringify(toolsLine) + '\n' +
      'Update the agent file AND _housekeeper-baseline.js together in a\n' +
      'commit tagged [housekeeper-tools-extension]. See locked-scope D-5.');
  });

  test('agent file SHA-256 byte-equals BASELINE_AGENT_SHA', () => {
    const { BASELINE_AGENT_SHA } = require(BASELINE_PATH);
    const body = fs.readFileSync(HOUSEKEEPER_PATH);
    const currentSha = crypto.createHash('sha256').update(body).digest('hex');
    assert.equal(currentSha, BASELINE_AGENT_SHA,
      'agent-file SHA-256 drifted from the frozen baseline.\n' +
      '  Expected: ' + BASELINE_AGENT_SHA + '\n' +
      '  Actual:   ' + currentSha + '\n' +
      'Any byte-level edit to agents/orchestray-housekeeper.md must be\n' +
      'matched by an updated SHA in bin/_lib/_housekeeper-baseline.js in\n' +
      'the same commit (tagged [housekeeper-tools-extension]).');
  });

  test('frontmatter shape: tools: [Read, mcp__orchestray__history_query_events] inside YAML block', () => {
    const body = fs.readFileSync(HOUSEKEEPER_PATH, 'utf8');
    const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'agents/orchestray-housekeeper.md must start with YAML frontmatter');
    const fm = fmMatch[1];
    assert.match(fm, /\ntools: \[Read, mcp__orchestray__history_query_events\]\n/,
      'frontmatter must contain the literal line `tools: [Read, ' +
      'mcp__orchestray__history_query_events]`');
  });

  test('runtime READ_ONLY_AGENT_FORBIDDEN_TOOLS map includes orchestray-housekeeper with strict set', () => {
    const validate = require(VALIDATE_PATH);
    const map = validate.READ_ONLY_AGENT_FORBIDDEN_TOOLS;
    assert.ok(map && typeof map === 'object',
      'validate-task-completion must export READ_ONLY_AGENT_FORBIDDEN_TOOLS');
    const housekeeperSet = map['orchestray-housekeeper'];
    assert.ok(housekeeperSet instanceof Set,
      'READ_ONLY_AGENT_FORBIDDEN_TOOLS["orchestray-housekeeper"] must be a Set');
    const actual = Array.from(housekeeperSet).sort();
    assert.deepEqual(actual, HOUSEKEEPER_FORBIDDEN_TOOLS.slice().sort(),
      'housekeeper forbidden set drifted from the locked Clause 2(b) contract.\n' +
      '  Expected: ' + JSON.stringify(HOUSEKEEPER_FORBIDDEN_TOOLS) + '\n' +
      '  Actual:   ' + JSON.stringify(actual) + '\n' +
      'Per Clause 1 of locked-scope D-5, the housekeeper rejects Grep (the scout\n' +
      'permits it). Update both this test and the runtime map in lockstep.');
  });

});
