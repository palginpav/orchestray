#!/usr/bin/env node
'use strict';

/**
 * Rename smoke test for bin/mcp-server/elicit/ask_user.js
 *
 * Per v2011c-stage2-plan.md §2 "Module layout decision": Stage 2 moves
 *   bin/mcp-server/handlers/ask_user.js -> bin/mcp-server/elicit/ask_user.js
 * via a single git mv. No behavior change.
 *
 * This test documents the Stage 2 rename. It currently FAILS because the
 * new file doesn't exist yet — G3 performs the rename and this test turns
 * green automatically.
 *
 * The existing Stage 1 test file tests/mcp-server/ask_user.test.js
 * continues to live under the old require path until G3 lands the rename
 * (and the developer updates that existing file at the same time).
 * This file is intentionally a thin loader-level smoke test only — it
 * does NOT re-test behavior already covered by the Stage 1 file.
 *
 * RED PHASE: require() throws MODULE_NOT_FOUND until G3 creates
 * bin/mcp-server/elicit/ask_user.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('elicit/ask_user module', () => {

  test('loads from bin/mcp-server/elicit/ask_user and exports handleAskUser', () => {
    // Dynamic require so the test framework attributes the failure to
    // this test case, not to module-load time for the whole file.
    let mod;
    assert.doesNotThrow(() => {
      mod = require('../../../bin/mcp-server/elicit/ask_user.js');
    }, 'bin/mcp-server/elicit/ask_user.js should exist after the Stage 2 rename');
    assert.equal(typeof mod.handleAskUser, 'function',
      'module must export handleAskUser as a function');
  });

});
