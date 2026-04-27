#!/usr/bin/env node
'use strict';

/**
 * p13-l002-hook-canonical-path.test.js — W6 L-002 regression (W7, v2.2.0).
 *
 * Asserts that bin/regen-schema-shadow-hook.js fires ONLY when the edited
 * file path matches the canonical agents/pm-reference/event-schemas.md
 * (absolute or relative). An Edit on `/tmp/foo/attacker-event-schemas.md`
 * MUST NOT trigger regen logic — even though it ends with the basename.
 *
 * We exercise the hook by piping its expected stdin payload and asserting
 * the stderr regen banner is/isn't emitted.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_BIN  = path.join(REPO_ROOT, 'bin', 'regen-schema-shadow-hook.js');

function runHook(payload, cwd) {
  const r = spawnSync('node', [HOOK_BIN], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
  return r;
}

describe('P1.3 L-002 regression — canonical-path hook trigger', () => {
  test('does NOT trigger regen on a non-canonical path ending in event-schemas.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-l002-noop-'));
    try {
      // Spurious basename match: a file that just happens to end with the
      // event-schemas.md basename. Must NOT trigger regen.
      const r = runHook({
        cwd: dir,
        tool_input: { file_path: '/tmp/foo/attacker-event-schemas.md' },
      }, dir);
      assert.equal(r.status, 0, 'hook must always exit 0 (fail-open)');
      const stderr = String(r.stderr || '');
      assert.ok(
        !/auto-regenerated shadow|auto-regenerated tier2-index/.test(stderr),
        'spurious-basename Edit must NOT trigger regen banner; got: ' + stderr,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('triggers regen on canonical relative path', () => {
    // We need a tmp project with a parseable event-schemas.md so the regen
    // actually succeeds. Copy the live source.
    const livePath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-l002-yes-'));
    try {
      fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
      fs.copyFileSync(livePath, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
      const r = runHook({
        cwd: dir,
        tool_input: { file_path: 'agents/pm-reference/event-schemas.md' },
      }, dir);
      assert.equal(r.status, 0);
      const stderr = String(r.stderr || '');
      assert.ok(
        /auto-regenerated shadow|auto-regenerated tier2-index/.test(stderr),
        'canonical Edit must trigger regen banner; got: ' + stderr,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('triggers regen on canonical absolute path', () => {
    const livePath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-l002-abs-'));
    try {
      fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
      fs.copyFileSync(livePath, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
      const absPath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
      const r = runHook({
        cwd: dir,
        tool_input: { file_path: absPath },
      }, dir);
      assert.equal(r.status, 0);
      const stderr = String(r.stderr || '');
      assert.ok(
        /auto-regenerated shadow|auto-regenerated tier2-index/.test(stderr),
        'absolute canonical Edit must trigger regen banner; got: ' + stderr,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
