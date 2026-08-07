'use strict';

/**
 * v2.3.18 W1c / D9 — KB index auto-repair.
 *
 * Coverage:
 *   A — repair() unit tests: mis-bucketed entry, duplicate id (timestamp
 *       and exact-match tie-breaks), ambiguous cases refuse without writing
 *   B — hook-level: a repairable index no longer blocks the write; an
 *       ambiguous one still does, with a specific reason
 *   C — --repair CLI path
 */

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'validate-kb-index.js');
const { validate, repair } = require('../_lib/kb-index-validator');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-repair-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'kb'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  return root;
}

function writeIndex(root, obj) {
  fs.writeFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), JSON.stringify(obj, null, 2));
}

function readIndex(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), 'utf8'));
}

function runHook(cwd, payload) {
  try {
    return execFileSync('node', [HOOK], {
      cwd,
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
  } catch (err) {
    return err;
  }
}

function eventsOfType(root, type) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// A. repair() unit tests
// ---------------------------------------------------------------------------

describe('A. repair() unit tests', () => {

  test('mis-bucketed entry (D9 case 1: bucket_facts_path_mismatch) moves to the correct bucket', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      facts: [
        { id: 'stray-artifact', path: 'artifacts/stray.md', author: 'pm', topic: 'x' },
      ],
      artifacts: [],
    });

    assert.equal(validate(root).valid, false, 'seed index must start invalid');

    const result = repair(root);
    assert.equal(result.repaired, true, JSON.stringify(result));
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].type, 'rebucket');
    assert.equal(result.changes[0].from, 'facts');
    assert.equal(result.changes[0].to, 'artifacts');

    const idx = readIndex(root);
    assert.equal(idx.facts.length, 0, 'entry must be removed from facts');
    assert.ok(idx.artifacts.find((e) => e.id === 'stray-artifact'), 'entry must land in artifacts');
    assert.equal(validate(root).valid, true, 'index must validate clean after repair');
  });

  test('duplicate id (D9 case 2) dedupes keeping the newest by updated_at', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      artifacts: [
        { id: 'v2318-quality-prior-art', path: 'artifacts/old.md', author: 'a', topic: 'x', created_at: '2026-01-01T00:00:00Z' },
        { id: 'v2318-quality-prior-art', path: 'artifacts/new.md', author: 'b', topic: 'y', created_at: '2026-06-01T00:00:00Z' },
      ],
    });

    const result = repair(root);
    assert.equal(result.repaired, true, JSON.stringify(result));
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].type, 'dedupe_by_timestamp');

    const idx = readIndex(root);
    const matches = idx.artifacts.filter((e) => e.id === 'v2318-quality-prior-art');
    assert.equal(matches.length, 1, 'must keep exactly one');
    assert.equal(matches[0].path, 'artifacts/new.md', 'must keep the newer entry');
  });

  test('duplicate id falls back to updated_at over created_at when both present', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      artifacts: [
        { id: 'dup', path: 'artifacts/a.md', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' },
        { id: 'dup', path: 'artifacts/b.md', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      ],
    });
    const result = repair(root);
    assert.equal(result.repaired, true);
    const idx = readIndex(root);
    assert.equal(idx.artifacts.length, 1);
    assert.equal(idx.artifacts[0].path, 'artifacts/b.md', 'newer updated_at must win even with older created_at');
  });

  test('duplicate id with no timestamp on either side, byte-identical entries, dedupes to one', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      artifacts: [
        { id: 'twin', path: 'artifacts/twin.md', author: 'pm', topic: 'x' },
        { id: 'twin', path: 'artifacts/twin.md', author: 'pm', topic: 'x' },
      ],
    });
    const result = repair(root);
    assert.equal(result.repaired, true, JSON.stringify(result));
    assert.equal(result.changes[0].type, 'dedupe_exact');
    assert.equal(readIndex(root).artifacts.length, 1);
  });

  test('ambiguous: duplicate id, no timestamps, entries differ — refuses and does not write', () => {
    const root = makeSandbox();
    const before = {
      version: '1.0',
      artifacts: [
        { id: 'dup', path: 'artifacts/a.md', author: 'pm', topic: 'x' },
        { id: 'dup', path: 'artifacts/b.md', author: 'other', topic: 'y' },
      ],
    };
    writeIndex(root, before);
    const beforeRaw = fs.readFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), 'utf8');

    const result = repair(root);
    assert.equal(result.repaired, false);
    assert.match(result.reason, /duplicate_id_artifacts_dup_no_timestamp_to_break_tie/);

    const afterRaw = fs.readFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), 'utf8');
    assert.equal(afterRaw, beforeRaw, 'index.json must be untouched on an ambiguous refusal');
  });

  test('ambiguous: entry path matches no known bucket — refuses, names the entry', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      artifacts: [
        { id: 'orphan', path: 'somewhere-else/orphan.md', author: 'pm', topic: 'x' },
      ],
    });
    const result = repair(root);
    assert.equal(result.repaired, false);
    assert.match(result.reason, /bucket_artifacts_path_mismatch_at_0_somewhere-else\/orphan\.md_matches_no_known_bucket/);
  });

  test('unrepairable: parse error is reported, not guessed at', () => {
    const root = makeSandbox();
    fs.writeFileSync(path.join(root, '.orchestray', 'kb', 'index.json'), 'not json{{');
    const result = repair(root);
    assert.equal(result.repaired, false);
    assert.equal(result.reason, 'parse_error');
  });

  test('already-valid index: repair() is a no-op (nothing to fix)', () => {
    const root = makeSandbox();
    writeIndex(root, { version: '1.0', artifacts: [{ id: 'fine', path: 'artifacts/fine.md' }] });
    const result = repair(root);
    assert.equal(result.repaired, false);
    assert.equal(result.reason, 'no_fixable_issues_found');
  });

});

// ---------------------------------------------------------------------------
// B. Hook-level: repairable index no longer blocks; ambiguous still does
// ---------------------------------------------------------------------------

describe('B. hook auto-repair', () => {

  test('hook auto-repairs a mis-bucketed index and lets the write proceed', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      facts: [{ id: 'stray', path: 'artifacts/stray.md', author: 'pm', topic: 'x' }],
      artifacts: [],
    });

    const result = runHook(root, {
      cwd: root,
      tool_name: 'mcp__orchestray__kb_write',
      tool_input: {},
    });
    assert.notEqual(result && result.status, 2, 'must not block once auto-repaired');

    const repaired = eventsOfType(root, 'kb_index_repaired');
    assert.equal(repaired.length, 1, 'kb_index_repaired must be emitted');
    assert.equal(repaired[0].change_count, 1);

    assert.equal(validate(root).valid, true, 'index must be valid on disk after the hook runs');
  });

  test('hook still blocks an ambiguous corruption, naming the specific entry', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      artifacts: [
        { id: 'dup', path: 'artifacts/a.md' },
        { id: 'dup', path: 'artifacts/b.md' },
      ],
    });

    const result = runHook(root, {
      cwd: root,
      tool_name: 'mcp__orchestray__kb_write',
      tool_input: {},
    });
    assert.equal(result && result.status, 2, 'must still block ambiguous corruption');

    const invalid = eventsOfType(root, 'kb_index_invalid');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].repair_attempted, true);
    assert.match(invalid[0].repair_reason, /duplicate_id_artifacts_dup_no_timestamp_to_break_tie/);

    const stderr = result.stderr ? result.stderr.toString() : '';
    assert.match(stderr, /duplicate_id_artifacts_dup_no_timestamp_to_break_tie/);
  });

});

// ---------------------------------------------------------------------------
// C. --repair CLI path
// ---------------------------------------------------------------------------

describe('C. --repair CLI', () => {

  test('CLI --repair fixes a recoverable index and exits 0', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      facts: [{ id: 'stray', path: 'artifacts/stray.md', author: 'pm', topic: 'x' }],
      artifacts: [],
    });

    let stdout;
    try {
      stdout = execFileSync('node', [HOOK, '--repair', root]).toString();
    } catch (err) {
      assert.fail('CLI --repair should exit 0 on a recoverable index: ' + (err.stderr && err.stderr.toString()));
    }
    assert.match(stdout, /kb index repaired: 1 change/);
    assert.equal(validate(root).valid, true);

    const repaired = eventsOfType(root, 'kb_index_repaired');
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0].trigger_reason, 'manual_cli');
  });

  test('CLI --repair exits 1 with a specific reason on an ambiguous index', () => {
    const root = makeSandbox();
    writeIndex(root, {
      version: '1.0',
      artifacts: [
        { id: 'dup', path: 'artifacts/a.md' },
        { id: 'dup', path: 'artifacts/b.md' },
      ],
    });

    let threw = null;
    try {
      execFileSync('node', [HOOK, '--repair', root]);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'must exit non-zero');
    assert.equal(threw.status, 1);
    assert.match(threw.stderr.toString(), /duplicate_id_artifacts_dup_no_timestamp_to_break_tie/);
  });

});
