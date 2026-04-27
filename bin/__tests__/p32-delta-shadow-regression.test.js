#!/usr/bin/env node
'use strict';

/**
 * P3.2 schema-shadow regression test.
 *
 * Mirrors p21-shadow-regression.test.js. Asserts that the
 * `delegation_delta_emit` event is parseable by SECTION_RE and lands in the
 * regenerated event-schemas.shadow.json as a top-level key.
 *
 * NOTE: this test runs regen-schema-shadow against a temp clone — it does NOT
 * mutate the live shadow file. The PM coordinates the canonical regen after
 * all P3.2 / P3.1 / P3.3 work merges.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const pathMod = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT     = pathMod.resolve(__dirname, '..', '..');
const REGEN_BIN     = pathMod.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js');
const SCHEMAS_PATH  = pathMod.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

const REQUIRED_EVENTS = ['delegation_delta_emit'];

describe('P3.2 schema-shadow contains delegation_delta_emit', () => {
  test('event-schemas.md has level-3 backticked-slug heading for delegation_delta_emit', () => {
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

  test('regen-schema-shadow against a tmp clone picks up delegation_delta_emit', () => {
    const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p32-shadow-regen-'));
    fs.mkdirSync(pathMod.join(tmpDir, 'agents', 'pm-reference'), { recursive: true });
    fs.copyFileSync(
      SCHEMAS_PATH,
      pathMod.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.md')
    );

    const r = spawnSync('node', [REGEN_BIN, '--cwd', tmpDir], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 0, 'regen-schema-shadow failed: ' + r.stderr);

    const tmpShadow = pathMod.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const shadow = JSON.parse(fs.readFileSync(tmpShadow, 'utf8'));
    for (const eventType of REQUIRED_EVENTS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(shadow, eventType),
        eventType + ' must appear as a top-level key in the regenerated shadow JSON. ' +
        'Underlying cause is usually a heading style change in agents/pm-reference/event-schemas.md ' +
        '(must be ``### `<slug>` event`` to be picked up by SECTION_RE).'
      );
    }
  });
});
