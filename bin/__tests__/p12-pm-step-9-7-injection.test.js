#!/usr/bin/env node
'use strict';

/**
 * p12-pm-step-9-7-injection.test.js — P1.2 PM Block-A injection contract.
 *
 * Verifies the `agents/pm.md` step 9.7 (output-shape) edit landed inside
 * Block A (before line 1347 sentinel position contract; the sentinel
 * itself moves as content is added/removed, but step 9.7 must always
 * appear BEFORE it). Also asserts the injected text references the
 * decision module + the structured-JSON exemption clause that mitigates
 * Risk #1.
 *
 * Verifies:
 *   1. agents/pm.md contains exactly one "9.7." numbered step under
 *      "## 3. Agent Spawning Instructions".
 *   2. The 9.7 block references bin/_lib/output-shape.js / decideShape.
 *   3. The 9.7 block contains the JSON-exemption clause
 *      ("structured JSON block is exempt from this cap").
 *   4. The 9.7 block sits BEFORE the ORCHESTRAY_BLOCK_A_END sentinel.
 *   5. The 9.7 block sits AFTER the existing 9.6 block (insertion order
 *      preserved).
 *   6. The 9.7 block declares output_shape_applied event emission so
 *      the schema-shadow plumbing test can find a referrer in pm.md.
 *
 * Runner: node --test bin/__tests__/p12-pm-step-9-7-injection.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PM_MD     = path.join(REPO_ROOT, 'agents', 'pm.md');
const SENTINEL  = '<!-- ORCHESTRAY_BLOCK_A_END -->';

describe('agents/pm.md — step 9.7 output-shape injection', () => {
  const content = fs.readFileSync(PM_MD, 'utf8');

  test('contains exactly one numbered step "9.7." under section 3', () => {
    const matches = content.match(/^9\.7\.\s+/gm) || [];
    assert.equal(matches.length, 1,
      `expected exactly one "9.7." step, found ${matches.length}`);
  });

  test('step 9.7 references bin/_lib/output-shape and decideShape', () => {
    const idx = content.search(/^9\.7\.\s+/m);
    assert.ok(idx !== -1, 'step 9.7 must exist');
    // Take the next ~30 lines after the header.
    const window = content.slice(idx, idx + 2000);
    assert.match(window, /output-shape/, 'must reference output-shape module');
    assert.match(window, /decideShape/, 'must reference decideShape() function');
  });

  test('step 9.7 contains the JSON-exemption clause (Risk #1 mitigation)', () => {
    const idx = content.search(/^9\.7\.\s+/m);
    const window = content.slice(idx, idx + 2000);
    assert.match(window, /structured\s+JSON\s+block\s+is\s+exempt\s+from\s+this\s+cap/i,
      'must declare the JSON-block exemption from the length cap');
  });

  test('step 9.7 mentions output_shape_applied event emission', () => {
    const idx = content.search(/^9\.7\.\s+/m);
    const window = content.slice(idx, idx + 2000);
    assert.match(window, /output_shape_applied/,
      'step 9.7 must declare output_shape_applied event emission');
  });

  test('step 9.7 lands BEFORE the ORCHESTRAY_BLOCK_A_END sentinel', () => {
    const stepIdx = content.search(/^9\.7\.\s+/m);
    const sentinelIdx = content.indexOf(SENTINEL);
    assert.ok(stepIdx !== -1 && sentinelIdx !== -1);
    assert.ok(stepIdx < sentinelIdx,
      `step 9.7 (idx=${stepIdx}) must precede BLOCK_A_END (idx=${sentinelIdx}) ` +
      'so prefix-cache covers the new injection logic');
  });

  test('step 9.7 lands AFTER the existing step 9.6', () => {
    const step96Idx = content.search(/^9\.6\.\s+/m);
    const step97Idx = content.search(/^9\.7\.\s+/m);
    assert.ok(step96Idx !== -1 && step97Idx !== -1);
    assert.ok(step96Idx < step97Idx,
      'step ordering must be 9.6 then 9.7');
  });

  test('step 9.7 lands BEFORE the Handoff Contract subsection', () => {
    const stepIdx = content.search(/^9\.7\.\s+/m);
    const handoffIdx = content.indexOf('### Handoff Contract and Rubric in Every Delegation');
    assert.ok(stepIdx !== -1 && handoffIdx !== -1);
    assert.ok(stepIdx < handoffIdx,
      'step 9.7 must precede the Handoff Contract subsection');
  });
});
