#!/usr/bin/env node
'use strict';

/**
 * Regression test for W5 F-002 / W6 S-001:
 * the `sentinel_probe` event-schema row MUST land in the schema-shadow JSON,
 * otherwise every probe call in production trips the audit-pipeline 3-strike
 * kill switch within a single day of use.
 *
 * Two assertions:
 *   1. The shadow JSON checked into the repo currently contains a
 *      `sentinel_probe` entry. Catches regressions where someone edits
 *      event-schemas.md and forgets to regen.
 *   2. Re-running `bin/regen-schema-shadow.js` against the live repo still
 *      picks up `sentinel_probe`. Catches regressions where someone changes
 *      the heading style back to a level-2 / capitalized form (the original
 *      bug pattern from F-002).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pathMod = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = pathMod.resolve(__dirname, '..', '..');
const SHADOW_PATH = pathMod.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const REGEN_BIN = pathMod.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js');

// v2.2.0 cleanup: extended to cover routing_outcome / agent_stop /
// task_created — pre-existing systemic gap surfaced during P1.1+P1.4
// close-out and fixed in the same orchestration per the no-deferral rule.
const REQUIRED_EVENTS = [
  'sentinel_probe',
  'routing_outcome',
  'agent_stop',
  'task_created',
];

describe('schema-shadow contains every actively-emitted event type', () => {
  for (const eventType of REQUIRED_EVENTS) {
    test(`checked-in shadow JSON has a ${eventType} entry`, () => {
      assert.ok(fs.existsSync(SHADOW_PATH), `shadow JSON missing at ${SHADOW_PATH}`);
      const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
      const hasKey =
        Object.prototype.hasOwnProperty.call(shadow, eventType) ||
        (shadow && typeof shadow === 'object' &&
         Object.values(shadow).some((v) =>
           v && typeof v === 'object' &&
           Object.prototype.hasOwnProperty.call(v, eventType)
         ));
      assert.ok(
        hasKey,
        `${eventType} must appear as a top-level key in the shadow JSON. ` +
        'If this fails, run `node bin/regen-schema-shadow.js` and commit the result. ' +
        'Underlying cause is usually a heading style change in agents/pm-reference/event-schemas.md ' +
        '(must be ``### `<slug>` event`` or ``### `<slug>``` to be picked up by SECTION_RE).'
      );
    });
  }

  test('regen-schema-shadow run picks up every required event type in fresh output', () => {
    const r = spawnSync('node', [REGEN_BIN], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 0, `regen-schema-shadow failed: ${r.stderr}`);
    const shadowText = fs.readFileSync(SHADOW_PATH, 'utf8');
    for (const eventType of REQUIRED_EVENTS) {
      assert.ok(
        shadowText.includes(eventType),
        `after regen, shadow JSON must contain literal "${eventType}"`
      );
    }
  });
});
