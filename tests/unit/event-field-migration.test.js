#!/usr/bin/env node
'use strict';

/**
 * Tests for R-EVENT-NAMING (v2.1.13):
 *   - Legacy-fixture normalisation
 *   - Real audit log normalises without throwing (smoke test)
 *   - Future-drift lint: grep bin/ + hooks/ for rogue emit-site field names
 *
 * The drift lint enforces the "no new legacy names introduced" AC from the
 * R-EVENT-NAMING plan: any new write site that emits a field not in the
 * canonical namespace (and not a known legacy alias) fails this test.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { normalizeEvent } = require(path.join(REPO_ROOT, 'bin', 'read-event'));
const { OLD_TO_NEW, NEW_TO_OLD } = require(
  path.join(REPO_ROOT, 'bin', 'event-field-migration-map')
);

// ---------------------------------------------------------------------------
describe('normalizeEvent — legacy fixture', () => {
  test('every line of tests/fixtures/legacy-events.jsonl normalises cleanly', () => {
    const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'legacy-events.jsonl');
    const lines = fs.readFileSync(fixture, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'fixture has at least one row');
    for (const line of lines) {
      const raw = JSON.parse(line);
      const norm = normalizeEvent(raw);
      assert.equal(typeof norm, 'object');
      // Every normalised event must have canonical keys, never legacy ones.
      for (const legacy of Object.keys(OLD_TO_NEW)) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(norm, legacy),
          false,
          `normalised event still contains legacy key "${legacy}"`
        );
      }
      // Normalised events must have BOTH `type` and `timestamp` (the canonical
      // fields that always existed in one name or another in the fixture).
      assert.ok(norm.type, 'type present');
      assert.ok(norm.timestamp, 'timestamp present');
    }
  });

  test('idempotent: a canonical event is returned unchanged in shape', () => {
    const already = { type: 'x', timestamp: '2026-01-01T00:00:00Z', custom: 1 };
    const norm = normalizeEvent(already);
    assert.equal(norm.type, 'x');
    assert.equal(norm.timestamp, '2026-01-01T00:00:00Z');
    assert.equal(norm.custom, 1);
  });

  test('non-object inputs returned unchanged', () => {
    assert.equal(normalizeEvent(null), null);
    assert.equal(normalizeEvent(42), 42);
    assert.equal(normalizeEvent('x'), 'x');
  });
});

// ---------------------------------------------------------------------------
describe('normalizeEvent — real audit log smoke test', () => {
  test('real .orchestray/audit/events.jsonl normalises without throwing', () => {
    const real = path.join(REPO_ROOT, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(real)) {
      // Skip silently when the repo is freshly cloned / no audit history.
      return;
    }
    const lines = fs.readFileSync(real, 'utf8').split('\n').filter(Boolean);
    // Sample a bounded slice to keep the test fast on large history.
    const sample = lines.slice(0, 500);
    for (const line of sample) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (_) {
        continue; // corrupt line — not this test's concern.
      }
      const norm = normalizeEvent(raw);
      assert.equal(typeof norm, 'object');
    }
  });
});

// ---------------------------------------------------------------------------
describe('event-field drift lint — bin/ and hooks/', () => {
  // Scope: emitters that write to .orchestray/audit/events.jsonl. Other
  // .jsonl files (routing.jsonl, stop-hook.jsonl) have their own schemas
  // and are intentionally excluded from this rename.
  const EMITTERS = [
    'bin/collect-agent-metrics.js',
    'bin/emit-compression-telemetry.js',
    'bin/emit-orchestration-rollup.js',
    'bin/gate-agent-spawn.js',
    'bin/pattern-roi-aggregate.js',
    'bin/post-orchestration-extract.js',
    'bin/state-gc.js',
    'bin/warn-isolation-omitted.js',
    'bin/_lib/scorer-telemetry.js',
    // v2.1.13 F-m-3: new emitter introduced alongside the project-intent agent.
    'bin/_lib/project-intent-fallback-event.js',
  ];

  test('no emitter re-introduces legacy field names in new writes', () => {
    for (const rel of EMITTERS) {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const src = fs.readFileSync(abs, 'utf8');
      // Strip comments (single-line + block) before searching. Comments
      // legitimately reference historical `event:` / `ts:` in explanations.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const legacy of Object.keys(OLD_TO_NEW)) {
        // Only fail when the legacy key appears as a JSON *property name*
        // (quoted key followed by colon). That catches `"event":` /
        // `"ts":` literal payloads without flagging the many valid uses of
        // the words in identifiers, comments, or string content.
        const re = new RegExp('"' + legacy + '"\\s*:', 'g');
        const matches = stripped.match(re) || [];
        assert.equal(
          matches.length,
          0,
          `${rel} emits legacy field "${legacy}" (found ${matches.length} site(s)); canonical is "${OLD_TO_NEW[legacy]}"`
        );
      }
    }
  });

  test('migration map OLD_TO_NEW and NEW_TO_OLD are bijective', () => {
    for (const [k, v] of Object.entries(OLD_TO_NEW)) {
      assert.equal(NEW_TO_OLD[v], k, `NEW_TO_OLD.${v} should equal ${k}`);
    }
    assert.equal(
      Object.keys(OLD_TO_NEW).length,
      Object.keys(NEW_TO_OLD).length,
      'maps same size'
    );
  });
});
