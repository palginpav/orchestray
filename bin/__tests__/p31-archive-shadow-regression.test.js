#!/usr/bin/env node
'use strict';

/**
 * P3.1 schema-shadow regression test (mirror of p21-shadow-regression.test.js).
 *
 * Two assertions:
 *   1. event-schemas.md contains level-3 backticked-slug headings for both
 *      `audit_round_closed` and `audit_round_archived` (the SECTION_RE pattern
 *      that drives regen-schema-shadow.js).
 *   2. Running bin/regen-schema-shadow.js against a temp copy of the repo
 *      yields a shadow JSON containing both event types as top-level keys.
 *      Catches regressions where someone changes the heading style back to a
 *      level-2 / capitalized form (the original F-002 bug pattern).
 *
 * NOTE: this test runs regen against a tmp clone — it does NOT mutate the
 * live agents/pm-reference/event-schemas.shadow.json. The PM coordinates
 * a single canonical regen post-merge.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const REGEN_BIN     = path.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js');
const SCHEMAS_PATH  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

const REQUIRED_EVENTS = ['audit_round_closed', 'audit_round_archived'];

describe('P3.1 schema-shadow contains audit_round_closed and audit_round_archived', () => {
  test('event-schemas.md has level-3 backticked-slug headings for both events', () => {
    const md = fs.readFileSync(SCHEMAS_PATH, 'utf8');
    for (const eventType of REQUIRED_EVENTS) {
      const heading = '### `' + eventType + '` event';
      assert.ok(
        md.includes(heading),
        'event-schemas.md must contain heading: ' + heading + '. ' +
        'If this fails, the heading style was changed and SECTION_RE will not pick it up. ' +
        'Re-add the heading using the format ``### `<slug>` event``.'
      );
    }
  });

  test('regen-schema-shadow against a tmp clone picks up both event types', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-shadow-regen-'));
    fs.mkdirSync(path.join(tmpDir, 'agents', 'pm-reference'), { recursive: true });
    fs.copyFileSync(
      SCHEMAS_PATH,
      path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.md')
    );

    const r = spawnSync('node', [REGEN_BIN, '--cwd', tmpDir], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 0, 'regen-schema-shadow failed: ' + r.stderr);

    const tmpShadow = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const shadow = JSON.parse(fs.readFileSync(tmpShadow, 'utf8'));
    for (const eventType of REQUIRED_EVENTS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(shadow, eventType),
        eventType + ' must appear as a top-level key in the regenerated shadow JSON. ' +
        'Underlying cause is usually a heading style change in agents/pm-reference/event-schemas.md ' +
        '(must be ``### `<slug>` event`` or ``### `<slug>``` to be picked up by SECTION_RE).'
      );
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
  });
});
