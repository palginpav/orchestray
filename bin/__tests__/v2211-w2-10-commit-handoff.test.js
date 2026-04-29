#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-commit-handoff.js — v2.2.11 W2-10.
 *
 * Validator behaviour:
 *   - release-manager: requires commit_hash (short-hash), branch, files_changed[].path
 *   - developer: requires files_changed[].path only
 *   - Only fires when files_changed.length > 0
 *   - Emits one commit_handoff_validation_failed event per missing field
 *   - Kill switch: ORCHESTRAY_COMMIT_HANDOFF_CHECK_DISABLED=1 → 0 emits
 *
 * Runner: node --test bin/__tests__/v2211-w2-10-commit-handoff.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod  = require('../validate-commit-handoff.js');
const HOOK = path.resolve(__dirname, '..', 'validate-commit-handoff.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSrBlock(sr) {
  return '## Structured Result\n```json\n' + JSON.stringify(sr, null, 2) + '\n```\n';
}

function makeEvent(role, sr, extras = {}) {
  return {
    tool_name:  'Agent',
    tool_input: { subagent_type: role },
    tool_response: { output: makeSrBlock(sr) },
    ...extras,
  };
}

function runHook(event, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vch-'));
  try {
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({ ...event, cwd: tmp }),
      cwd: tmp,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ...env },
    });

    const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    let events = [];
    if (fs.existsSync(eventsPath)) {
      events = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(e => e && e.type === 'commit_handoff_validation_failed');
    }

    return { status: res.status, events, stdout: res.stdout, stderr: res.stderr };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Unit: extractStructuredResult
// ---------------------------------------------------------------------------

describe('extractStructuredResult — unit', () => {
  test('extracts from tool_response.output with json fence', () => {
    const sr = { status: 'success', files_changed: [{ path: 'x.js' }] };
    const event = makeEvent('developer', sr);
    const result = mod.extractStructuredResult(event);
    assert.deepEqual(result, sr);
  });

  test('extracts from tool_response.text fallback', () => {
    const sr = { status: 'success', files_changed: [] };
    const event = {
      tool_response: { text: makeSrBlock(sr) },
    };
    const result = mod.extractStructuredResult(event);
    assert.deepEqual(result, sr);
  });

  test('returns null when no response text', () => {
    const result = mod.extractStructuredResult({ tool_input: { subagent_type: 'developer' } });
    assert.equal(result, null);
  });

  test('extracts direct structured_result object', () => {
    const sr = { status: 'success', commit_hash: 'abc1234' };
    const result = mod.extractStructuredResult({ structured_result: sr });
    assert.deepEqual(result, sr);
  });
});

// ---------------------------------------------------------------------------
// Unit: identifyRole
// ---------------------------------------------------------------------------

describe('identifyRole — unit', () => {
  test('reads from tool_input.subagent_type', () => {
    const role = mod.identifyRole({ tool_input: { subagent_type: 'release-manager' } });
    assert.equal(role, 'release-manager');
  });

  test('reads from top-level subagent_type', () => {
    const role = mod.identifyRole({ subagent_type: 'developer' });
    assert.equal(role, 'developer');
  });

  test('returns null when no role found', () => {
    const role = mod.identifyRole({ tool_name: 'Agent' });
    assert.equal(role, null);
  });
});

// ---------------------------------------------------------------------------
// Unit: validateDeveloper
// ---------------------------------------------------------------------------

describe('validateDeveloper — unit', () => {
  test('no violations when all entries have path', () => {
    const missing = mod.validateDeveloper({
      files_changed: [{ path: 'x.js' }, { path: 'y.ts' }],
    });
    assert.deepEqual(missing, []);
  });

  test('flags entry missing path field', () => {
    const missing = mod.validateDeveloper({
      files_changed: [{ path: 'x.js' }, { description: 'x' }],
    });
    assert.deepEqual(missing, ['files_changed[1].path']);
  });

  test('flags entry with empty path string', () => {
    const missing = mod.validateDeveloper({
      files_changed: [{ path: '' }],
    });
    assert.deepEqual(missing, ['files_changed[0].path']);
  });

  test('returns empty when files_changed is empty', () => {
    const missing = mod.validateDeveloper({ files_changed: [] });
    assert.deepEqual(missing, []);
  });
});

// ---------------------------------------------------------------------------
// Unit: validateReleaseManager
// ---------------------------------------------------------------------------

describe('validateReleaseManager — unit', () => {
  test('no violations on valid release-manager result', () => {
    const missing = mod.validateReleaseManager({
      commit_hash:   'abc1234',
      branch:        'master',
      files_changed: [{ path: 'x.js' }],
    });
    assert.deepEqual(missing, []);
  });

  test('flags missing commit_hash', () => {
    const missing = mod.validateReleaseManager({
      branch:        'master',
      files_changed: [{ path: 'x.js' }],
    });
    assert.ok(missing.includes('commit_hash'), 'should flag commit_hash');
    assert.equal(missing.length, 1);
  });

  test('flags missing branch', () => {
    const missing = mod.validateReleaseManager({
      commit_hash:   'abc1234',
      files_changed: [{ path: 'x.js' }],
    });
    assert.ok(missing.includes('branch'), 'should flag branch');
    assert.equal(missing.length, 1);
  });

  test('flags both commit_hash and branch when both absent', () => {
    const missing = mod.validateReleaseManager({
      files_changed: [{ path: 'x.js' }],
    });
    assert.ok(missing.includes('commit_hash'), 'should flag commit_hash');
    assert.ok(missing.includes('branch'), 'should flag branch');
    assert.equal(missing.length, 2);
  });

  test('rejects commit_hash that does not match short-hash pattern', () => {
    const missing = mod.validateReleaseManager({
      commit_hash:   'not-a-hash',
      branch:        'master',
      files_changed: [{ path: 'x.js' }],
    });
    assert.ok(missing.includes('commit_hash'), 'non-hex commit_hash should be flagged');
  });

  test('accepts 7-char short hash', () => {
    assert.ok(mod.COMMIT_HASH_RE.test('abc1234'));
  });

  test('accepts 12-char short hash', () => {
    assert.ok(mod.COMMIT_HASH_RE.test('abc123456789'));
  });

  test('rejects 6-char hash (too short)', () => {
    assert.ok(!mod.COMMIT_HASH_RE.test('abc123'));
  });

  test('rejects 13-char hash (too long)', () => {
    assert.ok(!mod.COMMIT_HASH_RE.test('abc1234567890a'));
  });
});

// ---------------------------------------------------------------------------
// WATCHED_ROLES membership
// ---------------------------------------------------------------------------

describe('WATCHED_ROLES — membership', () => {
  test('includes release-manager', () => {
    assert.ok(mod.WATCHED_ROLES.has('release-manager'));
  });

  test('includes developer', () => {
    assert.ok(mod.WATCHED_ROLES.has('developer'));
  });

  test('excludes reviewer', () => {
    assert.ok(!mod.WATCHED_ROLES.has('reviewer'));
  });
});

// ---------------------------------------------------------------------------
// Integration: end-to-end via spawnSync
// ---------------------------------------------------------------------------

describe('integration — release-manager full pass', () => {
  // Test 1: all fields present → 0 emits
  test('release-manager with commit_hash, branch, files_changed[].path → 0 emits', () => {
    const { status, events } = runHook(makeEvent('release-manager', {
      status:        'success',
      summary:       'Released v2.2.11',
      commit_hash:   'abc1234',
      branch:        'master',
      files_changed: [{ path: 'x.js' }],
      files_read:    [],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 0, 'expected 0 events on valid release-manager result');
  });
});

describe('integration — release-manager missing commit_hash', () => {
  // Test 2: missing commit_hash → 1 emit
  test('release-manager missing commit_hash → 1 emit with missing_field: "commit_hash"', () => {
    const { status, events } = runHook(makeEvent('release-manager', {
      status:        'success',
      summary:       'Released',
      branch:        'master',
      files_changed: [{ path: 'x.js' }],
      files_read:    [],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 1, 'expected 1 emit for missing commit_hash');
    assert.equal(events[0].missing_field, 'commit_hash');
    assert.equal(events[0].type, 'commit_handoff_validation_failed');
  });
});

describe('integration — release-manager missing both commit_hash and branch', () => {
  // Test 3: missing both → 2 emits
  test('release-manager missing commit_hash AND branch → 2 emits', () => {
    const { status, events } = runHook(makeEvent('release-manager', {
      status:        'success',
      summary:       'Released',
      files_changed: [{ path: 'x.js' }],
      files_read:    [],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 2, 'expected 2 emits, one per missing field');
    const fields = events.map(e => e.missing_field).sort();
    assert.deepEqual(fields, ['branch', 'commit_hash']);
  });
});

describe('integration — developer missing commit_hash (developer only needs path)', () => {
  // Test 4: developer with files_changed but missing path → 1 emit
  // (developer does NOT require commit_hash; it only requires files_changed[].path)
  test('developer with files_changed[{path}] but all paths valid → 0 emits', () => {
    const { status, events } = runHook(makeEvent('developer', {
      status:        'success',
      summary:       'Implemented feature',
      files_changed: [{ path: 'x.js' }],
      files_read:    ['y.js'],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 0, 'developer with valid path should emit 0 events');
  });
});

describe('integration — developer files_changed entry missing path', () => {
  // Test 5: developer with second entry missing path → 1 emit
  test('developer files_changed: [{path}, {description}] → 1 emit for second entry', () => {
    const { status, events } = runHook(makeEvent('developer', {
      status:        'success',
      summary:       'Implemented',
      files_changed: [{ path: 'x.js' }, { description: 'x' }],
      files_read:    ['y.js'],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 1, 'expected 1 emit for entry missing path');
    assert.equal(events[0].missing_field, 'files_changed[1].path');
  });
});

describe('integration — release-manager with empty files_changed', () => {
  // Test 6: release-manager files_changed: [] → 0 emits (validator only fires when non-empty)
  test('release-manager files_changed: [] → 0 emits', () => {
    const { status, events } = runHook(makeEvent('release-manager', {
      status:        'success',
      summary:       'Released',
      files_changed: [],
      files_read:    [],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 0, 'no validation when files_changed is empty');
  });
});

describe('integration — non-watched role (reviewer)', () => {
  // Test 7: reviewer → 0 emits regardless
  test('reviewer agent → 0 emits regardless of fields', () => {
    const { status, events } = runHook(makeEvent('reviewer', {
      status:        'success',
      summary:       'Reviewed',
      files_changed: [{ path: 'x.js' }],
      files_read:    ['x.js'],
      issues:        [],
    }));
    assert.equal(status, 0);
    assert.equal(events.length, 0, 'reviewer is not a watched role');
  });
});

describe('integration — kill switch', () => {
  // Test 8: kill switch → 0 emits even for release-manager missing commit_hash
  test('ORCHESTRAY_COMMIT_HANDOFF_CHECK_DISABLED=1 → 0 emits', () => {
    const { status, events } = runHook(
      makeEvent('release-manager', {
        status:        'success',
        summary:       'Released',
        files_changed: [{ path: 'x.js' }],
        files_read:    [],
        issues:        [],
      }),
      { ORCHESTRAY_COMMIT_HANDOFF_CHECK_DISABLED: '1' }
    );
    assert.equal(status, 0);
    assert.equal(events.length, 0, 'kill switch must suppress all validation');
  });
});

describe('integration — event schema fields', () => {
  test('emitted event has version, release_id, missing_field, schema_version', () => {
    const { events } = runHook(makeEvent('release-manager', {
      status:        'success',
      summary:       'Released',
      branch:        'master',
      files_changed: [{ path: 'x.js' }],
      files_read:    [],
      issues:        [],
    }));
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type,           'commit_handoff_validation_failed');
    assert.equal(e.version,        1);
    assert.equal(e.schema_version, 1);
    assert.ok(typeof e.release_id === 'string' && e.release_id.length > 0, 'release_id must be a non-empty string');
    assert.ok(typeof e.missing_field === 'string' && e.missing_field.length > 0, 'missing_field must be a non-empty string');
  });
});
