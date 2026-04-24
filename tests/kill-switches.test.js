#!/usr/bin/env node
'use strict';

/**
 * F-04 kill-switch integration tests (v2.1.11)
 *
 * Verifies that the pm.md Tier-2 dispatch table instructs the PM model to honour
 * the two prompt-restructuring kill switches introduced in R2 and R3:
 *
 *   Test A — ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1
 *     The dispatch row for tier1-orchestration-rare.md must declare this env var
 *     as an additional OR trigger, so the PM loads the file whenever the var is set.
 *
 *   Test B — ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1
 *     The dispatch row for delegation-templates-detailed.md must declare this env var
 *     as an additional OR trigger, so the PM loads the file whenever the var is set.
 *
 * These are document-structure integration tests: the dispatch table IS the PM's
 * runtime logic (the model reads and obeys it). Verifying the table's declared
 * conditions satisfies R2-AC-06 and R3-AC-06.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PM_MD = path.join(ROOT, 'agents/pm.md');

// ---------------------------------------------------------------------------
// Helper: extract the trigger portion of a dispatch table row by finding the
// markdown table row that references the given file reference string.
// A dispatch table row has the form:  | <trigger> | `<file-ref>` |
// We want the trigger column only (everything before the second pipe that
// contains the file reference), so we can assert the env var appears in the
// trigger rather than elsewhere in the file.
// ---------------------------------------------------------------------------

/**
 * Returns the trigger-column text for the dispatch row whose file-reference
 * column matches `fileRefSubstring`. Returns null if the row is not found.
 *
 * @param {string} content - full pm.md source
 * @param {string} fileRefSubstring - e.g. "tier1-orchestration-rare.md"
 * @returns {string|null}
 */
function extractDispatchTrigger(content, fileRefSubstring) {
  const lines = content.split('\n');
  for (const line of lines) {
    // Match markdown table rows: | ... | `...fileRefSubstring...` |
    if (line.includes(fileRefSubstring) && line.trimStart().startsWith('|')) {
      // Split on pipe — the trigger is between the 1st and 2nd pipe
      const parts = line.split('|');
      // parts[0] = '' (before leading pipe), parts[1] = trigger, parts[2] = file-ref, parts[3] = ''
      if (parts.length >= 3) {
        return parts[1].trim();
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test A — ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1
// ---------------------------------------------------------------------------

describe('F-04 kill switch: ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD (R2-AC-06)', () => {

  test('pm.md exists', () => {
    assert.ok(fs.existsSync(PM_MD), `${PM_MD} must exist`);
  });

  test('dispatch row for tier1-orchestration-rare.md contains ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1', () => {
    const content = fs.readFileSync(PM_MD, 'utf8');
    assert.ok(
      content.includes('ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1'),
      'pm.md must contain the substring ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1'
    );
  });

  test('ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1 appears in the TRIGGER column of the dispatch row (not just the reference table)', () => {
    const content = fs.readFileSync(PM_MD, 'utf8');
    const trigger = extractDispatchTrigger(content, 'tier1-orchestration-rare.md');
    assert.ok(
      trigger !== null,
      'pm.md dispatch table must have a row whose file-ref column contains "tier1-orchestration-rare.md"'
    );
    assert.ok(
      trigger.includes('ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1'),
      `The TRIGGER column of the tier1-orchestration-rare.md dispatch row must contain ` +
      `"ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1". Actual trigger: "${trigger}"`
    );
  });

  test('kill switch is phrased as an OR condition in the trigger', () => {
    const content = fs.readFileSync(PM_MD, 'utf8');
    const trigger = extractDispatchTrigger(content, 'tier1-orchestration-rare.md');
    assert.ok(trigger !== null, 'dispatch row for tier1-orchestration-rare.md must exist');
    // The env var must be introduced with OR so it is an additional load path
    assert.ok(
      /\bOR\b.*ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1/.test(trigger),
      `"ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1" must be preceded by "OR" in the trigger column. Actual trigger: "${trigger}"`
    );
  });

});

// ---------------------------------------------------------------------------
// Test B — ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1
// ---------------------------------------------------------------------------

describe('F-04 kill switch: ORCHESTRAY_DELEGATION_TEMPLATES_MERGE (R3-AC-06)', () => {

  test('pm.md exists', () => {
    assert.ok(fs.existsSync(PM_MD), `${PM_MD} must exist`);
  });

  test('dispatch row for delegation-templates-detailed.md contains ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1', () => {
    const content = fs.readFileSync(PM_MD, 'utf8');
    assert.ok(
      content.includes('ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1'),
      'pm.md must contain the substring ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1'
    );
  });

  test('ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1 appears in the TRIGGER column of the dispatch row (not just the reference table)', () => {
    const content = fs.readFileSync(PM_MD, 'utf8');
    const trigger = extractDispatchTrigger(content, 'delegation-templates-detailed.md');
    assert.ok(
      trigger !== null,
      'pm.md dispatch table must have a row whose file-ref column contains "delegation-templates-detailed.md"'
    );
    assert.ok(
      trigger.includes('ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1'),
      `The TRIGGER column of the delegation-templates-detailed.md dispatch row must contain ` +
      `"ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1". Actual trigger: "${trigger}"`
    );
  });

  test('kill switch is phrased as an OR condition in the trigger', () => {
    const content = fs.readFileSync(PM_MD, 'utf8');
    const trigger = extractDispatchTrigger(content, 'delegation-templates-detailed.md');
    assert.ok(trigger !== null, 'dispatch row for delegation-templates-detailed.md must exist');
    assert.ok(
      /\bOR\b.*ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1/.test(trigger),
      `"ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1" must be preceded by "OR" in the trigger column. Actual trigger: "${trigger}"`
    );
  });

});
