#!/usr/bin/env node
'use strict';

/**
 * v2214-G06-events-declared.test.js
 *
 * Verifies G-06 requirements:
 *   1. `pattern_read` and `scout_decision` are declared in
 *      agents/pm-reference/event-schemas.shadow.json.
 *   2. regen-schema-shadow.js deletes the .schema-shadow-disabled sentinel
 *      when it is present (re-arms the safety net).
 *   3. regen-schema-shadow.js does NOT error when the sentinel is absent
 *      (idempotent unlink).
 *
 * task_completed is intentionally NOT asserted here — no current emitter
 * was found in bin/ (audit-team-event.js only emits task_created; historical
 * events in events.jsonl pre-date the current hook wiring).
 *
 * Runner:
 *   node --require ./tests/helpers/setup.js --test \
 *     bin/__tests__/v2214-G06-events-declared.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SHADOW_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const REGEN_BIN   = path.join(REPO_ROOT, 'bin', 'regen-schema-shadow.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-G06-'));
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });

  const realSchemas = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
  fs.copyFileSync(realSchemas, path.join(pmRefDir, 'event-schemas.md'));

  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  return { dir, stateDir, pmRefDir };
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

function callRegen(cwd) {
  execFileSync(
    process.execPath,
    [REGEN_BIN, '--cwd', cwd],
    { encoding: 'utf8', env: { ...process.env } }
  );
}

function sentinelPath(stateDir) {
  return path.join(stateDir, '.schema-shadow-disabled');
}

// ---------------------------------------------------------------------------
// Tests — shadow content
// ---------------------------------------------------------------------------

describe('G-06: pattern_read + scout_decision declared in shadow', () => {
  test('shadow.json exists on disk', () => {
    assert.ok(fs.existsSync(SHADOW_PATH),
      'agents/pm-reference/event-schemas.shadow.json must exist');
  });

  test('shadow contains pattern_read entry', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    assert.ok('pattern_read' in shadow,
      'pattern_read must be declared in event-schemas.shadow.json');
  });

  test('shadow contains scout_decision entry', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    assert.ok('scout_decision' in shadow,
      'scout_decision must be declared in event-schemas.shadow.json');
  });

  test('pattern_read entry has expected required-field count (timestamp, tool, slug, orchestration_id)', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    const entry = shadow['pattern_read'];
    // version + timestamp + tool + slug = 4 required fields
    assert.ok(entry.r >= 4,
      `pattern_read.r=${entry.r}: expected >= 4 required fields`);
  });

  test('scout_decision entry has expected required-field count (timestamp, file_path, file_bytes, scout_min_bytes, decision, caller_role)', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    const entry = shadow['scout_decision'];
    // version + timestamp + file_path + file_bytes + scout_min_bytes + decision + caller_role = 7+
    assert.ok(entry.r >= 7,
      `scout_decision.r=${entry.r}: expected >= 7 required fields`);
  });
});

// ---------------------------------------------------------------------------
// Tests — sentinel auto-delete
// ---------------------------------------------------------------------------

describe('G-06: regen-schema-shadow deletes .schema-shadow-disabled sentinel', () => {
  test('sentinel is deleted after successful regen when present', () => {
    const { dir, stateDir } = makeTmpRepo();
    try {
      const sp = sentinelPath(stateDir);
      // Create the sentinel before running regen
      fs.writeFileSync(sp, JSON.stringify({ tripped_at: new Date().toISOString() }), 'utf8');
      assert.ok(fs.existsSync(sp), 'sentinel must exist before regen');

      callRegen(dir);

      assert.ok(!fs.existsSync(sp),
        '.schema-shadow-disabled sentinel must be deleted after successful regen');
    } finally {
      cleanupDir(dir);
    }
  });

  test('regen succeeds (exit 0) when sentinel is absent — idempotent unlink', () => {
    const { dir, stateDir } = makeTmpRepo();
    try {
      const sp = sentinelPath(stateDir);
      assert.ok(!fs.existsSync(sp), 'sentinel must not exist before this test');

      // Must not throw
      assert.doesNotThrow(() => callRegen(dir),
        'regen must not error when sentinel is absent');
    } finally {
      cleanupDir(dir);
    }
  });

  test('shadow produced by regen contains both new event types', () => {
    const { dir, pmRefDir } = makeTmpRepo();
    try {
      callRegen(dir);
      const outPath = path.join(pmRefDir, 'event-schemas.shadow.json');
      const shadow = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.ok('pattern_read' in shadow, 'regen output must include pattern_read');
      assert.ok('scout_decision' in shadow, 'regen output must include scout_decision');
    } finally {
      cleanupDir(dir);
    }
  });
});
