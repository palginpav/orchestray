'use strict';

/**
 * Tests for W2-7 verification — confirms that gate-agent-spawn.js is registered
 * as a PreToolUse:Agent hook in hooks.json.
 *
 * This is a verify-only test (no new implementation). It asserts the mechanical
 * enforcement of "PM must spawn agents with an explicit model" is already wired.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

// Resolve hooks.json relative to the repo root (two levels up from __tests__).
const HOOKS_JSON_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'hooks.json');

let hooksConfig;

before(() => {
  const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
  hooksConfig = JSON.parse(raw);
});

// ---------------------------------------------------------------------------
// W2-7 gate-agent-spawn.js wiring verification
// ---------------------------------------------------------------------------

describe('W2-7: gate-agent-spawn.js PreToolUse:Agent registration', () => {
  test('hooks.json is parseable and has PreToolUse section', () => {
    assert.ok(hooksConfig, 'hooksConfig should be defined');
    assert.ok(hooksConfig.hooks, 'hooksConfig.hooks should be defined');
    assert.ok(Array.isArray(hooksConfig.hooks.PreToolUse), 'PreToolUse should be an array');
  });

  test('gate-agent-spawn.js is registered in at least one PreToolUse entry', () => {
    const preToolUse = hooksConfig.hooks.PreToolUse;
    const hasGateSpawn = preToolUse.some(entry =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some(h => typeof h.command === 'string' && h.command.includes('gate-agent-spawn.js'))
    );
    assert.equal(hasGateSpawn, true, 'gate-agent-spawn.js must be in PreToolUse hooks');
  });

  test('the gate-agent-spawn.js entry has a matcher that includes Agent', () => {
    const preToolUse = hooksConfig.hooks.PreToolUse;
    const matchingEntry = preToolUse.find(entry =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some(h => typeof h.command === 'string' && h.command.includes('gate-agent-spawn.js'))
    );
    assert.ok(matchingEntry, 'Should find an entry containing gate-agent-spawn.js');
    assert.match(matchingEntry.matcher, /Agent/, 'matcher must reference Agent');
  });

  test('gate-agent-spawn.js hook has a positive timeout configured', () => {
    const preToolUse = hooksConfig.hooks.PreToolUse;
    let found = false;
    for (const entry of preToolUse) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (typeof h.command === 'string' && h.command.includes('gate-agent-spawn.js')) {
          assert.equal(typeof h.timeout, 'number', 'timeout must be a number');
          assert.ok(h.timeout > 0, 'timeout must be positive');
          found = true;
        }
      }
    }
    assert.ok(found, 'gate-agent-spawn.js entry must exist with timeout');
  });
});
