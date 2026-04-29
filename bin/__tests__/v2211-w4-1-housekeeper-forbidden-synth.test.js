#!/usr/bin/env node
'use strict';

/**
 * v2211-w4-1-housekeeper-forbidden-synth.test.js — W4-1 synthetic housekeeper
 * forbidden-tool coverage.
 *
 * Synthetically spawns `bin/validate-task-completion.js` with SubagentStop
 * payloads that simulate an orchestray-housekeeper agent attempting tool calls
 * that are forbidden by its stricter whitelist (Read + Glob only — no Grep,
 * no Edit, no Write, no Bash).
 *
 * Target dark event: `housekeeper_forbidden_tool_blocked`.
 *
 * Tests:
 *   1. Grep → exit 2 + housekeeper_forbidden_tool_blocked.
 *      (Grep is permitted for scout but forbidden for housekeeper.)
 *   2. Edit → exit 2 + housekeeper_forbidden_tool_blocked.
 *   3. Write → exit 2 + housekeeper_forbidden_tool_blocked.
 *   4. Bash  → exit 2 + housekeeper_forbidden_tool_blocked.
 *   5. Clean payload (Read + Glob only) → exit 0, no forbidden-tool event.
 *
 * Each test creates an isolated tmpDir and cleans up on completion.
 *
 * Runner: node --test bin/__tests__/v2211-w4-1-housekeeper-forbidden-synth.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK      = path.join(REPO_ROOT, 'bin', 'validate-task-completion.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Structured Result for a read-only housekeeper. */
const CLEAN_RESULT = {
  status:       'success',
  summary:      'housekeeper verified the artifact bytes',
  files_changed: [],
  files_read:   ['/tmp/.orchestray/kb/artifacts/event-schemas.md'],
  issues:       [],
  assumptions:  [],
};

/** Wrap Structured Result in the expected output block format. */
function wrapResult(result) {
  return '## Structured Result\n```json\n' + JSON.stringify(result) + '\n```\n';
}

/**
 * Invoke validate-task-completion.js as a child process.
 * Returns the spawnSync result with `.tmp` set to the isolated tmpDir.
 */
function runHook(payload) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-hkp-'));
  const res = spawnSync('node', [HOOK], {
    input:    JSON.stringify(payload),
    cwd:      tmp,
    encoding: 'utf8',
    timeout:  10_000,
  });
  return Object.assign({}, res, { tmp });
}

/** Read all audit events from a tmpDir's events.jsonl. */
function readEvents(tmp) {
  const auditPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W4-1 — housekeeper forbidden-tool synthetic coverage', () => {

  // -------------------------------------------------------------------------
  // Tests 1-4: each tool in HOUSEKEEPER_FORBIDDEN_TOOLS fires the event.
  // -------------------------------------------------------------------------

  for (const forbiddenTool of ['Grep', 'Edit', 'Write', 'Bash']) {
    test('orchestray-housekeeper with ' + forbiddenTool + ' → exit 2 + housekeeper_forbidden_tool_blocked', () => {
      const r = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type:   'orchestray-housekeeper',
        tool_calls:      [{ name: forbiddenTool }, { name: 'Read' }],
        output:          wrapResult(CLEAN_RESULT),
      });
      try {
        assert.equal(r.status, 2,
          'Expected exit 2 for orchestray-housekeeper + ' + forbiddenTool +
          '. stderr=' + r.stderr);
        assert.match(r.stderr, /read-only contract violation/,
          'stderr must mention read-only contract violation for ' + forbiddenTool);

        const events = readEvents(r.tmp);
        const hit    = events.find(e => e.type === 'housekeeper_forbidden_tool_blocked');
        assert.ok(hit,
          'Expected housekeeper_forbidden_tool_blocked for ' + forbiddenTool + '. ' +
          'Got event types: ' + JSON.stringify(events.map(e => e.type)));
        assert.deepEqual(hit.forbidden_tools, [forbiddenTool],
          'forbidden_tools must list ' + forbiddenTool +
          '; got: ' + JSON.stringify(hit.forbidden_tools));
        assert.equal(hit.agent_role, 'orchestray-housekeeper',
          'agent_role must be orchestray-housekeeper; got: ' + JSON.stringify(hit.agent_role));

        // Scout event must NOT bleed into housekeeper payloads.
        const scoutHit = events.find(e => e.type === 'scout_forbidden_tool_blocked');
        assert.equal(scoutHit, undefined,
          'scout_forbidden_tool_blocked must NOT fire for orchestray-housekeeper payload');
      } finally {
        fs.rmSync(r.tmp, { recursive: true, force: true });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Test 5: Clean payload (Read + Glob only) passes without any forbidden-tool event.
  // -------------------------------------------------------------------------
  test('orchestray-housekeeper with Read+Glob only → exit 0, no forbidden-tool event', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type:   'orchestray-housekeeper',
      tool_calls:      [{ name: 'Read' }, { name: 'Glob' }],
      output:          wrapResult(CLEAN_RESULT),
    });
    try {
      assert.equal(r.status, 0,
        'Clean housekeeper payload must exit 0. stderr=' + r.stderr);

      const events        = readEvents(r.tmp);
      const forbiddenEvts = events.filter(e =>
        e.type === 'housekeeper_forbidden_tool_blocked' ||
        e.type === 'scout_forbidden_tool_blocked'
      );
      assert.equal(forbiddenEvts.length, 0,
        'No forbidden-tool events must fire for clean housekeeper payload. ' +
        'Got: ' + JSON.stringify(forbiddenEvts.map(e => e.type)));
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: Grep from haiku-scout still routes to the SCOUT event (not housekeeper).
  // Validates per-agent map differentiation — same tool, different agent → different event.
  // -------------------------------------------------------------------------
  test('haiku-scout with Grep → exit 0 (scout permits Grep; only housekeeper forbids it)', () => {
    const scoutCleanResult = Object.assign({}, CLEAN_RESULT, {
      summary: 'scout grepped for context',
    });
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type:   'haiku-scout',
      tool_calls:      [{ name: 'Grep' }, { name: 'Read' }],
      output:          wrapResult(scoutCleanResult),
    });
    try {
      assert.equal(r.status, 0,
        'haiku-scout with Grep must exit 0 (scout permits Grep). stderr=' + r.stderr);

      const events = readEvents(r.tmp);
      const blocked = events.filter(e =>
        e.type === 'housekeeper_forbidden_tool_blocked' ||
        e.type === 'scout_forbidden_tool_blocked'
      );
      assert.equal(blocked.length, 0,
        'No forbidden-tool events must fire for scout+Grep. ' +
        'Got: ' + JSON.stringify(blocked.map(e => e.type)));
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });

});
