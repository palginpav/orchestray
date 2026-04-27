#!/usr/bin/env node
'use strict';

/**
 * P1.3 schema-shadow regression test.
 *
 * Mirror of p21-shadow-regression.test.js / p32-delta-shadow-regression.test.js.
 * Asserts that:
 *   1. event-schemas.md contains the level-3 backticked-slug headings for
 *      `tier2_index_lookup` and `event_schemas_full_load_blocked` (the new
 *      P1.3 events).
 *   2. After running regen-schema-shadow against a tmp clone, BOTH event types
 *      land as top-level keys in event-schemas.shadow.json.
 *   3. After running buildIndex against the same clone, the tier2-index has
 *      events.tier2_index_lookup AND events.event_schemas_full_load_blocked
 *      with non-empty schema.required arrays (cross-link with the shadow).
 *
 * NOTE: this test runs regen against a tmp clone — it does NOT mutate the live
 * shadow/index files. The PM coordinates the canonical regen at merge.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const REGEN_BIN     = path.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js');
const SCHEMAS_PATH  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const { buildIndex } = require(path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js'));

const REQUIRED_EVENTS = ['tier2_index_lookup', 'event_schemas_full_load_blocked'];

function makeTmpClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-shadow-regen-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMAS_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  return dir;
}

describe('P1.3 schema-shadow + tier2-index contain the new event types', () => {
  test('event-schemas.md has level-3 backticked-slug headings for both new events', () => {
    const md = fs.readFileSync(SCHEMAS_PATH, 'utf8');
    for (const eventType of REQUIRED_EVENTS) {
      const heading = '### `' + eventType + '` event';
      assert.ok(
        md.includes(heading),
        'event-schemas.md must contain heading: ' + heading,
      );
    }
  });

  test('regen-schema-shadow against a tmp clone picks up both new events', () => {
    const cwd = makeTmpClone();
    const r = spawnSync('node', [REGEN_BIN, '--cwd', cwd], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 0, 'regen-schema-shadow failed: ' + r.stderr);

    const shadowPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
    for (const eventType of REQUIRED_EVENTS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(shadow, eventType),
        eventType + ' must appear as a top-level key in the regenerated shadow JSON',
      );
      const e = shadow[eventType];
      assert.ok(typeof e.r === 'number' && e.r >= 4,
        eventType + ' must have r (required count) >= 4');
    }
  });

  test('buildIndex picks up both new events with non-empty schema.required arrays', () => {
    const cwd = makeTmpClone();
    const idx = buildIndex({ cwd });
    for (const eventType of REQUIRED_EVENTS) {
      const entry = idx.events[eventType];
      assert.ok(entry, eventType + ' must be present in tier2-index events map');
      assert.ok(Array.isArray(entry.schema.required) && entry.schema.required.length > 0,
        eventType + ' tier2-index entry must have a non-empty schema.required');
      assert.ok(Array.isArray(entry.line_range) && entry.line_range.length === 2,
        eventType + ' tier2-index entry must have a line_range');
    }
  });

  test('shadow and tier2-index agree on slug coverage (parser sharing)', () => {
    const cwd = makeTmpClone();
    const r = spawnSync('node', [REGEN_BIN, '--cwd', cwd], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    const shadow = JSON.parse(fs.readFileSync(
      path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json'), 'utf8',
    ));
    const idx = buildIndex({ cwd });

    const shadowSlugs = Object.keys(shadow).filter(k => k !== '_meta').sort();
    const indexSlugs = Object.keys(idx.events).sort();
    assert.deepEqual(shadowSlugs, indexSlugs,
      'shadow and tier2-index must enumerate the SAME set of slugs (parser sharing invariant)');
  });
});
