#!/usr/bin/env node
'use strict';

/**
 * p12-shadow-regression.test.js — P1.2 schema-shadow regression for
 * `output_shape_applied`.
 *
 * The W1 design (§3.2) explicitly defers `event-schemas.shadow.json`
 * regen to a single PM-coordinated pass at the end of v2.2.0 Phase 1
 * (after P1.2 + P1.3 + P1.4 schema additions all land). Until that
 * regen runs, the shadow does NOT contain `output_shape_applied`, and
 * this test t.skip()'s the shadow assertion.
 *
 * What this test DOES verify (always, no skip):
 *   1. The `output_shape_applied` event is documented in
 *      `agents/pm-reference/event-schemas.md` under a level-3 backticked
 *      heading exactly once (drift detector — multiple appends would
 *      indicate accidental duplicate).
 *
 * What this test SKIPS until the PM regens shadow:
 *   2. `output_shape_applied` is a known event in
 *      `agents/pm-reference/event-schemas.shadow.json`.
 *
 * Once the shadow regen lands as part of the P1.3 / P1.4 closing
 * orchestration, remove the skip block.
 *
 * Runner: node --test bin/__tests__/p12-shadow-regression.test.js
 *
 * Cross-reference: .orchestray/kb/artifacts/v220-impl-p12-design.md §3.2;
 * P1.3 design owns the shadow-regen orchestration step.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMAS_MD       = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const SCHEMAS_SHADOW   = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const HEADING_REGEX    = /^###\s+`output_shape_applied`\s+event\s*$/m;

describe('output_shape_applied — schema-md documentation', () => {
  test('exactly one ### `output_shape_applied` event heading in event-schemas.md', () => {
    const content = fs.readFileSync(SCHEMAS_MD, 'utf8');
    const matches = content.match(/^###\s+`output_shape_applied`\s+event\s*$/gm) || [];
    assert.equal(matches.length, 1,
      `expected exactly one heading, found ${matches.length}`);
  });

  test('output_shape_applied appears after verify_fix_oscillation (P1.2 was first appender)', () => {
    // Per W1 design §3.1: P1.2's row appends right after the previous tail
    // (verify_fix_oscillation). P1.3 / P1.4 then append AFTER P1.2's row.
    const content = fs.readFileSync(SCHEMAS_MD, 'utf8');
    const oscIdx   = content.search(/^###\s+`verify_fix_oscillation`\s+event\s*$/m);
    const ourIdx   = content.search(HEADING_REGEX);
    assert.ok(oscIdx !== -1 && ourIdx !== -1,
      'verify_fix_oscillation and output_shape_applied headings must both exist');
    assert.ok(oscIdx < ourIdx,
      `verify_fix_oscillation (idx=${oscIdx}) must precede output_shape_applied ` +
      `(idx=${ourIdx}) — P1.2 appends to the previous tail, not before it`);
  });
});

describe('output_shape_applied — schema-shadow plumbing', () => {
  test('output_shape_applied present in event-schemas.shadow.json', () => {
    if (!fs.existsSync(SCHEMAS_SHADOW)) {
      assert.fail('event-schemas.shadow.json missing — PM coordinates regen at merge time');
    }
    const shadow = JSON.parse(fs.readFileSync(SCHEMAS_SHADOW, 'utf8'));
    const events = Object.keys(shadow).filter((k) => k !== '_meta');
    assert.ok(events.includes('output_shape_applied'),
      'shadow must list output_shape_applied');
  });
});
