#!/usr/bin/env node
'use strict';

/**
 * Regression test: v2.2.3 G2 — team-tier enum label refresh.
 *
 * Bucket-G disposition: the `team` enum reservation comment in
 * event-schemas.md was labeled `v2.2+` from v2.1.0 onward but the v2.2.x
 * line shipped without the 3-tier wire-in. Per W6 disposition + user
 * feedback `feedback_no_scope_narrowing.md`, labels age silently and must
 * be refreshed when the gate slides.
 *
 * v2.2.3 G5 ships the doc-only refresh: `v2.2+` → `v2.4+` (R-FED-SYNC
 * flagship slot). This test pins the refresh and prevents regression.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMAS_FILE = path.resolve(
  __dirname, '../../agents/pm-reference/event-schemas.md'
);

describe('v2.2.3 G2 — team enum label refresh', () => {
  let content;

  test('event-schemas.md is readable', () => {
    content = fs.readFileSync(SCHEMAS_FILE, 'utf8');
    assert.ok(content.length > 0);
  });

  test('no `v2.2+` enum label remains for the team tier', () => {
    // The label was at lines ~2483 (winning_tier note) and ~2534 (source enum
    // value). Both must now reference v2.4+.
    assert.ok(
      !/v2\.2\+/.test(content),
      'event-schemas.md must NOT contain `v2.2+` references after G2 refresh'
    );
  });

  test('team tier reservation now cites v2.4+ wire-in', () => {
    assert.ok(
      content.includes('v2.4+ 3-tier wire-in'),
      'event-schemas.md must reference `v2.4+ 3-tier wire-in` for the team tier'
    );
  });

  test('R-FED-SYNC flagship is named as the v2.4+ trigger', () => {
    // The refresh ties the deferred enum to the federation-sync flagship so
    // future readers know which release brings the wire-in.
    assert.ok(
      content.includes('R-FED-SYNC'),
      'event-schemas.md must cite R-FED-SYNC as the team-tier wire-in flagship'
    );
  });

  test('source enum still lists local / team / shared', () => {
    // Refresh must not silently drop the team value from the documented enum.
    assert.match(
      content,
      /`"local"`[\s\S]{0,400}`"team"`[\s\S]{0,400}`"shared"`/,
      'event-schemas.md must still document local/team/shared in source enum'
    );
  });
});
