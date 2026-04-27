#!/usr/bin/env node
'use strict';

/**
 * Tests for agents/pm.md prefix-stability invariants  (T13 — v2.0.17)
 *
 * Contracts under test:
 *  - agents/pm.md contains ORCHESTRAY_BLOCK_A_END sentinel exactly once
 *  - agents/pm.md contains ORCHESTRAY_BLOCK_B_END sentinel exactly once
 *  - Block A hashes to a known-at-test-time value (UPDATE_BLOCK_A_HASH=1 to regenerate)
 *  - agents/pm.md does NOT contain 'cache_control_marker' (OQ-1 verdict IGNORED)
 *  - agents/pm.md does NOT contain 'When in Doubt, Load' (S2' flip confirmed)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const PM_MD_PATH = path.join(repoRoot, 'agents', 'pm.md');
const BLOCK_A_SENTINEL = '<!-- ORCHESTRAY_BLOCK_A_END -->';
const BLOCK_B_SENTINEL = '<!-- ORCHESTRAY_BLOCK_B_END -->';

/**
 * Compute the same hex16 hash that cache-prefix-lock.js uses.
 * @param {string} text
 * @returns {string} 16-char hex string
 */
function hashHex16(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Extract Block A: everything up to and including the sentinel.
 * Returns null if sentinel is absent.
 */
function extractBlockA(content) {
  const idx = content.indexOf(BLOCK_A_SENTINEL);
  if (idx === -1) return null;
  return content.slice(0, idx + BLOCK_A_SENTINEL.length);
}

// ---------------------------------------------------------------------------
// Read pm.md once for all tests
// ---------------------------------------------------------------------------

let pmContent;
try {
  pmContent = fs.readFileSync(PM_MD_PATH, 'utf8');
} catch (err) {
  // If pm.md cannot be read, all tests will fail meaningfully below
  pmContent = null;
}

// ---------------------------------------------------------------------------
// Sentinel presence
// ---------------------------------------------------------------------------

describe('agents/pm.md sentinel presence', () => {

  test('pm.md is readable', () => {
    assert.ok(pmContent !== null, `agents/pm.md must be readable at ${PM_MD_PATH}`);
    assert.ok(pmContent.length > 0, 'agents/pm.md must not be empty');
  });

  test('contains ORCHESTRAY_BLOCK_A_END sentinel exactly once', () => {
    assert.ok(pmContent !== null, 'pm.md must be readable');

    const occurrences = pmContent.split(BLOCK_A_SENTINEL).length - 1;
    assert.equal(
      occurrences,
      1,
      `agents/pm.md must contain '${BLOCK_A_SENTINEL}' exactly once. ` +
      `Found ${occurrences} occurrences.`
    );
  });

  test('contains ORCHESTRAY_BLOCK_B_END sentinel exactly once', () => {
    assert.ok(pmContent !== null, 'pm.md must be readable');

    const occurrences = pmContent.split(BLOCK_B_SENTINEL).length - 1;
    assert.equal(
      occurrences,
      1,
      `agents/pm.md must contain '${BLOCK_B_SENTINEL}' exactly once. ` +
      `Found ${occurrences} occurrences.`
    );
  });

  test('ORCHESTRAY_BLOCK_A_END appears before ORCHESTRAY_BLOCK_B_END', () => {
    assert.ok(pmContent !== null, 'pm.md must be readable');

    const idxA = pmContent.indexOf(BLOCK_A_SENTINEL);
    const idxB = pmContent.indexOf(BLOCK_B_SENTINEL);
    assert.ok(idxA < idxB,
      `BLOCK_A_END (idx=${idxA}) must appear before BLOCK_B_END (idx=${idxB})`
    );
  });

});

// ---------------------------------------------------------------------------
// Block A hash stability
// ---------------------------------------------------------------------------

describe('agents/pm.md Block A hash stability', () => {

  /**
   * PINNED_BLOCK_A_HASH is the single source of truth for the expected Block A
   * hash. It is pinned inline below.
   *
   * To regenerate after a deliberate Block A change:
   *   UPDATE_BLOCK_A_HASH=1 node --test tests/pm-md-prefix-stability.test.js
   * Then update PINNED_BLOCK_A_HASH below to the value the run prints.
   */

  test('Block A hash matches pinned expected value', () => {
    assert.ok(pmContent !== null, 'pm.md must be readable');

    const blockA = extractBlockA(pmContent);
    assert.ok(
      blockA !== null,
      `Cannot compute Block A hash: '${BLOCK_A_SENTINEL}' not found in agents/pm.md`
    );

    const actualHash = hashHex16(blockA);

    // UPDATE mode: print the current hash; the developer copies it into the
    // PINNED_BLOCK_A_HASH literal below in the same commit.
    if (process.env.UPDATE_BLOCK_A_HASH === '1') {
      console.log(`[pm-md-prefix-stability] Block A hash is now: ${actualHash}`);
      console.log(`[pm-md-prefix-stability] Update PINNED_BLOCK_A_HASH in this test to that value.`);
      return; // pass
    }

    // Normal mode: compare against the inline pinned value.
    // v2.2.0 P1.4 §3.S sentinel-preference instruction insertion (orch-20260426T172424Z).
    // Re-pinned during the same orchestration's W7 fix-pass: §3.S body
    // gained exit-2 documentation (F-007) and apostrophe-quoting guidance
    // (F-009).
    // v2.2.0 P3.2 R-DELEG-DELTA insertion (orch-20260426T193005Z)
    // v2.2.0 P1.2 step 9.7 output-shape inject (orch-20260427T041926Z)
    const PINNED_BLOCK_A_HASH = 'e068ae0dfab5e752';

    assert.equal(
      actualHash,
      PINNED_BLOCK_A_HASH,
      `Block A hash mismatch!\n` +
      `  Expected: ${PINNED_BLOCK_A_HASH}\n` +
      `  Actual:   ${actualHash}\n\n` +
      `This means agents/pm.md Block A content changed unexpectedly.\n` +
      `If this change was intentional (and approved), regenerate the pin with:\n` +
      `  UPDATE_BLOCK_A_HASH=1 node --test tests/pm-md-prefix-stability.test.js\n` +
      `then update PINNED_BLOCK_A_HASH inline in this test.`
    );
  });

});

// ---------------------------------------------------------------------------
// OQ-1 verdict: cache_control_marker must NOT be present
// ---------------------------------------------------------------------------

describe('OQ-1 verdict — no cache_control_marker', () => {

  test('agents/pm.md does NOT contain "cache_control_marker"', () => {
    assert.ok(pmContent !== null, 'pm.md must be readable');

    assert.ok(
      !pmContent.includes('cache_control_marker'),
      'agents/pm.md must NOT contain "cache_control_marker". ' +
      'OQ-1 concluded that caller-side cache_control is ignored by Claude Code. ' +
      'This marker would be misleading and must not be present.'
    );
  });

});

// ---------------------------------------------------------------------------
// S2' flip: "When in Doubt, Load" must NOT be present
// ---------------------------------------------------------------------------

describe('S2-prime flip — no "When in Doubt, Load"', () => {

  test('agents/pm.md does NOT contain "When in Doubt, Load"', () => {
    assert.ok(pmContent !== null, 'pm.md must be readable');

    assert.ok(
      !pmContent.includes('When in Doubt, Load'),
      'agents/pm.md must NOT contain "When in Doubt, Load". ' +
      'T17 replaced this permissive loading rule with the strict "Tier-2 Loading Discipline" gate (S2\' flip). ' +
      'Its presence would indicate a regression.'
    );
  });

});
