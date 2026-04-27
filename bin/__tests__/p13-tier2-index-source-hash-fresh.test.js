#!/usr/bin/env node
'use strict';

/**
 * p13-tier2-index-source-hash-fresh.test.js — F-002 regression
 * (v2.2.0 pre-ship cross-phase fix-pass).
 *
 * Asserts that the STAGED sidecar at
 * `agents/pm-reference/event-schemas.tier2-index.json` carries a
 * `_meta.source_hash` that matches the SHA-256 of the STAGED
 * `agents/pm-reference/event-schemas.md`.
 *
 * Why this guard exists:
 *   On a fresh `git clone`, the on-disk sidecar is whatever was staged
 *   at commit time. If the source was edited but the sidecar regen was
 *   not re-staged, the source_hash field disagrees with the source SHA
 *   and `bin/_lib/tier2-index.js::getChunk()` returns
 *   `{found:false, error:'stale_index'}` for every call.
 *   With `event_schemas.full_load_disabled: true` (D-8 default-on in
 *   v2.2.0), the PM has NO fallback — the chunked-only path is dormant
 *   on day-1 of the install until the user makes ANY edit to
 *   `event-schemas.md` and the PostToolUse(Edit) hook fires regen.
 *
 * Origin: pre-ship cross-phase review F-002 — staged sidecar shipped
 *   with `bbdef165…` while the live source was `19cfdfe4…`. This test
 *   catches the "stale at commit time" failure mode every release by
 *   reading both blobs from the git index (NOT the working tree),
 *   which is the literal byte-state a fresh `git clone` will land on.
 *
 * Failure mode this test prevents:
 *   commit lands → fresh clone → tier2-index hash mismatch →
 *   `getChunk()` returns stale_index → PM cannot read any event schema
 *   → orchestrations that need event-schemas.md context degrade silently.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const crypto  = require('node:crypto');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const SIDECAR_REL    = 'agents/pm-reference/event-schemas.tier2-index.json';
const SOURCE_REL     = 'agents/pm-reference/event-schemas.md';

function gitShowBytes(relPath) {
  // `git show :<path>` reads the version of <path> currently in the
  // index (i.e., what would land in the next commit). Returns Buffer.
  const r = spawnSync('git', ['show', ':' + relPath], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    timeout: 10000,
  });
  if (r.status !== 0) {
    const stderr = r.stderr ? r.stderr.toString('utf8') : '';
    throw new Error(
      'git show :' + relPath + ' failed (status=' + r.status + '): ' + stderr,
    );
  }
  return r.stdout;
}

function isPathStaged(relPath) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
  return r.status === 0;
}

describe('P1.3 F-002 regression — staged tier2-index source_hash matches staged source SHA', () => {
  test('staged sidecar exists and parses', () => {
    assert.ok(
      isPathStaged(SIDECAR_REL),
      'sidecar must be staged in git: ' + SIDECAR_REL,
    );
    const buf = gitShowBytes(SIDECAR_REL);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(buf.toString('utf8'));
    }, 'staged sidecar must be valid JSON');
    assert.ok(parsed && parsed._meta, 'staged sidecar must declare _meta');
    assert.equal(
      typeof parsed._meta.source_hash, 'string',
      'staged sidecar must declare _meta.source_hash',
    );
    assert.match(
      parsed._meta.source_hash, /^[a-f0-9]{64}$/,
      'source_hash must be a hex SHA-256 (64 hex chars)',
    );
  });

  test('staged source file is staged in git', () => {
    assert.ok(
      isPathStaged(SOURCE_REL),
      'source must be staged in git: ' + SOURCE_REL,
    );
  });

  test('staged sidecar source_hash equals staged source SHA-256', () => {
    const sourceBuf  = gitShowBytes(SOURCE_REL);
    const sidecarBuf = gitShowBytes(SIDECAR_REL);
    const sidecar    = JSON.parse(sidecarBuf.toString('utf8'));

    const expectedSha = crypto.createHash('sha256').update(sourceBuf).digest('hex');
    const declaredSha = sidecar._meta.source_hash;

    assert.equal(
      declaredSha, expectedSha,
      'STALE STAGED SIDECAR detected.\n' +
      '  staged source SHA-256:           ' + expectedSha + '\n' +
      '  staged sidecar _meta.source_hash: ' + declaredSha + '\n' +
      'On a fresh `git clone` this mismatch causes getChunk() to return\n' +
      '`{found:false, error:"stale_index"}` for EVERY schema_get call,\n' +
      'and with event_schemas.full_load_disabled=true (default in v2.2.0)\n' +
      'the PM has no fallback. Re-stage the sidecar:\n' +
      '  node bin/regen-schema-shadow.js && \\\n' +
      '  node -e "require(\'./bin/_lib/tier2-index\').buildIndex({cwd:process.cwd()})" && \\\n' +
      '  git add ' + SIDECAR_REL,
    );
  });
});
