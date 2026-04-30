#!/usr/bin/env node
'use strict';

/**
 * anti-pattern-mcp-allowlist-parity.test.js — C-02 hard-block parity gate
 * (v2.2.15 P1-02).
 *
 * Mechanises anti-pattern `mcp-tool-pm-allowlist-cross-cut`. Verifies that
 * every MCP tool registered in `bin/mcp-server/server.js` TOOL_TABLE either:
 *   1. appears in `agents/pm.md` frontmatter `tools:` as `mcp__orchestray__<slug>`, OR
 *   2. is justified in `NOT_FOR_PM` (curator-only, internal, etc.).
 *
 * v2.2.15 ships HARD-BLOCK (exit 2 in the calling test harness); the failure
 * mode is a silent regression that only surfaces in production and does not
 * benefit from a telemetry ramp.
 *
 * Stale-entry direction (pm.md has slug not in TOOL_TABLE) is warn-only and
 * matches the `mcp_allowlist_stale_entry_warn` declaration.
 *
 * Kill switch: `ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED=1`.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const path               = require('node:path');

const derive = require('../_lib/mcp-tool-allowlist-derive');

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const SERVER_JS     = path.join(REPO_ROOT, 'bin', 'mcp-server', 'server.js');
const SCHEMAS_JS    = path.join(REPO_ROOT, 'bin', 'mcp-server', 'lib', 'schemas.js');
const PM_MD         = path.join(REPO_ROOT, 'agents', 'pm.md');

// ---------------------------------------------------------------------------
// Real-source parity assertion (HARD-BLOCK)
// ---------------------------------------------------------------------------

describe('mcp-tool-pm-allowlist-parity: real source', () => {
  test('every TOOL_TABLE slug is either in pm.md tools or in NOT_FOR_PM', () => {
    if (derive.isDisabled()) {
      assert.ok(true, 'parity check disabled via ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED');
      return;
    }
    const serverSrc  = fs.readFileSync(SERVER_JS,  'utf8');
    const pmSrc      = fs.readFileSync(PM_MD,      'utf8');

    const tools   = derive.parseToolTable(serverSrc);
    const pmTools = derive.parsePmAllowlist(pmSrc);

    assert.ok(tools.size > 0,    'TOOL_TABLE parse returned at least one slug');
    assert.ok(pmTools.size > 0,  'pm.md tools parse returned at least one slug');

    const { missing } = derive.diffAllowlist({ tools, pmTools });
    assert.deepStrictEqual(
      missing,
      [],
      'TOOL_TABLE slugs missing from pm.md and from NOT_FOR_PM exclusion list: ' +
        JSON.stringify(missing)
    );
  });

  test('stale entries in pm.md surface as a warn list, not a hard fail', () => {
    if (derive.isDisabled()) {
      assert.ok(true, 'parity check disabled');
      return;
    }
    const serverSrc  = fs.readFileSync(SERVER_JS,  'utf8');
    const pmSrc      = fs.readFileSync(PM_MD,      'utf8');

    const tools   = derive.parseToolTable(serverSrc);
    const pmTools = derive.parsePmAllowlist(pmSrc);

    const { stale } = derive.diffAllowlist({ tools, pmTools });
    // Stale is informational; surface for visibility but do not fail.
    if (stale.length > 0) {
      process.stdout.write(
        '[mcp-allowlist-parity] WARN — pm.md lists slugs absent from TOOL_TABLE: ' +
          JSON.stringify(stale) + '\n'
      );
    }
    assert.ok(true);
  });

  test('schemas.js inline tool names are a subset of TOOL_TABLE', () => {
    const serverSrc   = fs.readFileSync(SERVER_JS,  'utf8');
    const schemasSrc  = fs.readFileSync(SCHEMAS_JS, 'utf8');
    const tools       = derive.parseToolTable(serverSrc);
    const inline      = derive.parseSchemasToolNames(schemasSrc);
    for (const name of inline) {
      assert.ok(
        tools.has(name),
        'schemas.js declares name="' + name + '" that is not in TOOL_TABLE'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic fixture tests (negative + edge)
// ---------------------------------------------------------------------------

const SYNTH_SERVER_OK = `
'use strict';
const TOOL_TABLE = Object.freeze({
  ask_user: { definition: ASK, handler: handleAskUser },
  pattern_find: { definition: PF, handler: handlePF },
});
`;

const SYNTH_SERVER_WITH_FAKE = `
'use strict';
const TOOL_TABLE = Object.freeze({
  ask_user: { definition: ASK, handler: handleAskUser },
  pattern_find: { definition: PF, handler: handlePF },
  fake_tool: { definition: FT, handler: handleFT },
});
`;

const SYNTH_PM_OK = `---
name: pm
tools: Agent(architect), Read, mcp__orchestray__ask_user, mcp__orchestray__pattern_find
---

# PM
`;

const SYNTH_PM_RETIRED = `---
name: pm
tools: Read, mcp__orchestray__ask_user, mcp__orchestray__pattern_find, mcp__orchestray__retired_tool
---
`;

describe('mcp-tool-pm-allowlist-parity: synthetic fixtures', () => {
  test('positive: parity holds → no missing, no stale', () => {
    const tools   = derive.parseToolTable(SYNTH_SERVER_OK);
    const pmTools = derive.parsePmAllowlist(SYNTH_PM_OK);
    const { missing, stale } = derive.diffAllowlist({
      tools, pmTools, exclusions: {},
    });
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(stale, []);
  });

  test('negative: TOOL_TABLE has fake_tool, pm.md missing it → reported as missing', () => {
    const tools   = derive.parseToolTable(SYNTH_SERVER_WITH_FAKE);
    const pmTools = derive.parsePmAllowlist(SYNTH_PM_OK);
    const { missing, stale } = derive.diffAllowlist({
      tools, pmTools, exclusions: {},
    });
    assert.deepStrictEqual(missing, ['fake_tool']);
    assert.deepStrictEqual(stale, []);
  });

  test('negative: pm.md has retired_tool not in TOOL_TABLE → warn (stale), not block', () => {
    const tools   = derive.parseToolTable(SYNTH_SERVER_OK);
    const pmTools = derive.parsePmAllowlist(SYNTH_PM_RETIRED);
    const { missing, stale } = derive.diffAllowlist({
      tools, pmTools, exclusions: {},
    });
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(stale, ['retired_tool']);
  });

  test('exclusion list suppresses missing report', () => {
    const tools   = derive.parseToolTable(SYNTH_SERVER_WITH_FAKE);
    const pmTools = derive.parsePmAllowlist(SYNTH_PM_OK);
    const { missing } = derive.diffAllowlist({
      tools, pmTools, exclusions: { fake_tool: 'test-fixture' },
    });
    assert.deepStrictEqual(missing, []);
  });

  test('case sensitivity: MCP__orchestray__pattern_find does NOT match', () => {
    const PM_BAD_CASE = `---
name: pm
tools: Read, MCP__orchestray__pattern_find, mcp__orchestray__ask_user
---
`;
    const pmTools = derive.parsePmAllowlist(PM_BAD_CASE);
    assert.ok(pmTools.has('ask_user'));
    assert.ok(!pmTools.has('pattern_find'),
      'uppercase MCP__ token must NOT count toward the pm.md allowlist');
  });

  test('parser robustness: malformed pm.md returns empty set, never throws', () => {
    assert.deepStrictEqual([...derive.parsePmAllowlist('')], []);
    assert.deepStrictEqual([...derive.parsePmAllowlist('no frontmatter here')], []);
    assert.deepStrictEqual([...derive.parsePmAllowlist(null)], []);
  });

  test('NOT_FOR_PM is frozen (immutable)', () => {
    assert.throws(() => {
      derive.NOT_FOR_PM.brand_new_tool = 'should fail';
    }, /Cannot add property|read only|extensible/);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('mcp-tool-pm-allowlist-parity: kill switch', () => {
  test('isDisabled false by default (default-on)', () => {
    const prev = process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED;
    delete process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED;
    try {
      assert.strictEqual(derive.isDisabled(), false);
    } finally {
      if (prev !== undefined) process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED = prev;
    }
  });

  test('isDisabled true when env var set to 1', () => {
    const prev = process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED;
    process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED = '1';
    try {
      assert.strictEqual(derive.isDisabled(), true);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED;
      else process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED = prev;
    }
  });
});
