#!/usr/bin/env node
'use strict';

/**
 * p13-tier2-index-tracked.test.js — F-001 regression (W7, v2.2.0).
 *
 * Asserts that:
 *   1. agents/pm-reference/event-schemas.tier2-index.json is tracked in git.
 *      (Fresh `git clone` must include the sidecar; chunked path is the ONLY
 *      path when event_schemas.full_load_disabled=true is the default.)
 *   2. The tracked sidecar's _meta.event_count matches the count of distinct
 *      slugs the parser extracts from the live event-schemas.md source.
 *      (Catches the failure mode of "sidecar exists but stale".)
 *
 * Origin: W5 review F-001 — sidecar was untracked at v2.2.0 candidate. A
 * stale sidecar is just as broken as a missing one — it would feed the PM
 * line ranges that no longer match the source, returning either bad slices
 * (silent corruption) or {found:false, error:'stale_index'} (visible miss
 * with no fallback because D-8 disables full Read).
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const SIDECAR_REL    = 'agents/pm-reference/event-schemas.tier2-index.json';
const SIDECAR_ABS    = path.join(REPO_ROOT, SIDECAR_REL);
const SCHEMAS_ABS    = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

const { parseEventSchemasWithRanges } = require(
  path.join(REPO_ROOT, 'bin', '_lib', 'event-schemas-parser.js')
);

describe('P1.3 F-001 regression — tier2-index sidecar is tracked + fresh', () => {
  test('event-schemas.tier2-index.json is tracked in git', () => {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', SIDECAR_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(
      r.status, 0,
      'sidecar must be tracked in git so fresh clones have the chunked path on day-1. ' +
      'Run: git add ' + SIDECAR_REL + '\nstderr: ' + r.stderr,
    );
    const stdoutTrimmed = (r.stdout || '').trim();
    assert.equal(
      stdoutTrimmed, SIDECAR_REL,
      'git ls-files should print the sidecar path; got: ' + JSON.stringify(stdoutTrimmed),
    );
  });

  test('sidecar exists on disk', () => {
    assert.ok(
      fs.existsSync(SIDECAR_ABS),
      'sidecar must exist at ' + SIDECAR_ABS,
    );
  });

  test('sidecar _meta.event_count matches slugs parsed from source', () => {
    const sidecar = JSON.parse(fs.readFileSync(SIDECAR_ABS, 'utf8'));
    const source  = fs.readFileSync(SCHEMAS_ABS, 'utf8');
    const parsed  = parseEventSchemasWithRanges(source);

    assert.ok(
      sidecar && sidecar._meta && typeof sidecar._meta.event_count === 'number',
      'sidecar must declare _meta.event_count',
    );
    assert.equal(
      sidecar._meta.event_count, parsed.length,
      'sidecar event_count is stale: declares ' + sidecar._meta.event_count +
      ' but source has ' + parsed.length + ' distinct event slugs. ' +
      'Run: node bin/regen-schema-shadow.js (the hook also regenerates this).',
    );
    assert.equal(
      Object.keys(sidecar.events || {}).length, parsed.length,
      'sidecar events map size must match _meta.event_count and the source slug count',
    );
  });
});
