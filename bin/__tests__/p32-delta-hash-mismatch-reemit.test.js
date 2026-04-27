#!/usr/bin/env node
'use strict';

/**
 * P3.2 hash-mismatch + post-compact resume re-emit (v2.2.0).
 *
 * Asserts:
 *   - Mid-orch static-portion change → reason='hash_mismatch'; subsequent
 *     spawn with the new static portion returns delta (re-anchoring).
 *   - Post-compact case via dossier auto-detect (last_compact_detected_at >
 *     stateMap entry's cached_at) forces type='full' with
 *     reason='post_compact_resume'.
 *   - Explicit postCompactResume:true flag forces same outcome.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const pathMod = require('node:path');

const REPO_ROOT = pathMod.resolve(__dirname, '..', '..');
const { computeDelta, __resetCache } = require(pathMod.join(REPO_ROOT, 'bin', '_lib', 'spawn-context-delta.js'));

function makeTmpRoot() {
  return fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p32-mismatch-'));
}

function buildPrompt(staticBody, perSpawnBody) {
  return (
    '<!-- delta:static-begin -->\n' +
    staticBody +
    '\n<!-- delta:static-end -->\n' +
    '<!-- delta:per-spawn-begin -->\n' +
    perSpawnBody +
    '\n<!-- delta:per-spawn-end -->'
  );
}

function writeDossier(cwd, lastCompactAt) {
  const dir = pathMod.join(cwd, '.orchestray', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({
    schema_version: 2,
    written_at: new Date().toISOString(),
    orchestration_id: 'orch-C',
    last_compact_detected_at: lastCompactAt,
    compact_trigger: lastCompactAt ? 'manual' : null,
  });
  fs.writeFileSync(pathMod.join(dir, 'resilience-dossier.json'), body, 'utf8');
}

describe('P3.2 hash mismatch + post-compact resume', () => {
  test('static portion change mid-orch → reason=hash_mismatch; next spawn re-anchored to delta', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const S1 = '## Static\nbanner v1\n';
    const S2 = '## Static\nbanner v2 — correction pattern updated\n';

    const r1 = computeDelta(buildPrompt(S1, '## task one'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd });
    assert.equal(r1.type, 'full');
    assert.equal(r1.reason, 'first_spawn');

    const r2 = computeDelta(buildPrompt(S2, '## task two'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd });
    assert.equal(r2.type, 'full', 'static-portion change must force full re-emit');
    assert.equal(r2.reason, 'hash_mismatch');
    assert.notEqual(r2.prefix_hash, r1.prefix_hash, 'new hash differs from cached hash');

    const r3 = computeDelta(buildPrompt(S2, '## task three — same static as r2'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd });
    assert.equal(r3.type, 'delta', 're-anchoring worked: S2 is now cached, third spawn is delta');
    assert.equal(r3.prefix_hash, r2.prefix_hash);
  });

  test('dossier last_compact_detected_at > cached_at auto-detects post-compact (no explicit flag)', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const STATIC = '## Static\ncommon\n';

    // First spawn: caches a prefix. cached_at = now.
    const r1 = computeDelta(buildPrompt(STATIC, '## task one'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd });
    assert.equal(r1.type, 'full');

    // Now simulate a compact that happens AFTER the cached_at timestamp.
    const future = new Date(Date.now() + 60_000).toISOString();
    writeDossier(cwd, future);

    const r2 = computeDelta(buildPrompt(STATIC, '## task two'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd });
    assert.equal(r2.type, 'full', 'dossier-detected post-compact must force full');
    assert.equal(r2.reason, 'post_compact_resume');
  });

  test('explicit postCompactResume:true forces type=full even when delta would otherwise apply', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const STATIC = '## Static\ncommon\n';
    computeDelta(buildPrompt(STATIC, '## task one'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd });
    const r2 = computeDelta(buildPrompt(STATIC, '## task two'),
      { orchestration_id: 'orch-C', agent_type: 'developer', cwd, postCompactResume: true });
    assert.equal(r2.type, 'full');
    assert.equal(r2.reason, 'post_compact_resume');
  });
});
