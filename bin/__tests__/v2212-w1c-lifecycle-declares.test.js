'use strict';

/**
 * v2212-w1c-lifecycle-declares.test.js
 *
 * Verifies that W1c (lifecycle event-type declares) landed correctly in the
 * schema shadow. Asserts:
 *   1. The 4 declared types are present in the shadow.
 *   2. Each has a non-empty payload schema (v field present, implying a valid
 *      shadow entry — regen-schema-shadow.js only writes entries that parsed
 *      a JSON schema block).
 *   3. The 3 reconciled-away types (agent_spawn, task_started, task_completed)
 *      are NOT in the shadow (they were dropped as redundant / dark).
 *
 * Shadow before W1c: 205 types.
 * Shadow after W1c:  209 types (+4 declared, 0 reconciled-away added).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SHADOW_PATH = path.resolve(__dirname, '../../agents/pm-reference/event-schemas.shadow.json');

let shadow;
try {
  shadow = require(SHADOW_PATH);
} catch (e) {
  throw new Error(`Cannot load shadow JSON at ${SHADOW_PATH}: ${e.message}`);
}

const DECLARED_TYPES = [
  'orchestration_start',
  'orchestration_complete',
  'orchestration_roi',
  'archive_must_copy_validation',
];

const RECONCILED_AWAY = [
  'agent_spawn',
  'task_started',
  // task_completed was reconciled-away in v2.2.12 W1c, then re-declared in
  // v2.2.14 G-06 follow-up because live consumers (audit-on-orch-complete.js,
  // event-quarantine.js) read it. No longer reconciled-away.
];

describe('W1c lifecycle declares — shadow verification', () => {
  test('shadow event_count is at least 209 (205 baseline + 4 W1c declares; W1b adds +1 more)', () => {
    assert.ok(
      shadow._meta.event_count >= 209,
      `Expected >=209 event types, got ${shadow._meta.event_count}`,
    );
  });

  for (const eventType of DECLARED_TYPES) {
    test(`${eventType} is present in shadow`, () => {
      assert.ok(
        eventType in shadow,
        `Expected '${eventType}' to be present in shadow but it was missing`,
      );
    });

    test(`${eventType} has a non-empty payload schema (v field present)`, () => {
      const entry = shadow[eventType];
      assert.ok(
        entry && typeof entry === 'object',
        `Shadow entry for '${eventType}' is not an object: ${JSON.stringify(entry)}`,
      );
      // regen-schema-shadow.js sets v:1 as the base version for all parsed declares
      assert.ok(
        typeof entry.v === 'number',
        `Shadow entry for '${eventType}' missing 'v' field (schema not parsed): ${JSON.stringify(entry)}`,
      );
    });
  }

  for (const eventType of RECONCILED_AWAY) {
    test(`${eventType} is NOT in shadow (reconciled away as redundant/dark)`, () => {
      assert.ok(
        !(eventType in shadow),
        `Expected '${eventType}' to be absent from shadow (reconciled away) but it was present`,
      );
    });
  }
});
