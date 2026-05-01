#!/usr/bin/env node
'use strict';

/**
 * path-containment-shared-helper.test.js — v2.2.21 G3-W2-T4
 *
 * Verifies that the shared `validateTranscriptPath` helper in
 * `bin/_lib/path-containment.js` correctly rejects attacker-supplied paths,
 * and that each consumer hook invokes it — returning '' / null and emitting
 * `transcript_path_containment_failed` — when given a traversal path like
 * `../../../etc/passwd`.
 *
 * Consumers under test:
 *   1. bin/_lib/path-containment.js          — validateTranscriptPath unit tests
 *   2. bin/validate-no-deferral.js           — collectOutput (T4 F3)
 *   3. bin/emit-compression-telemetry.js     — readDelegationPrompt (T4 F4)
 *   4. bin/validate-task-completion.js       — checkArtifactBodySizes (T4 F7)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-t4-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 1. Unit tests for validateTranscriptPath
// ---------------------------------------------------------------------------

describe('validateTranscriptPath — shared helper', () => {
  const { validateTranscriptPath } = require(path.join(REPO_ROOT, 'bin/_lib/path-containment'));

  test('returns "" and calls emitFn for dotdot traversal', () => {
    const dir = makeSandbox();
    try {
      const emitted = [];
      const result = validateTranscriptPath(
        '../../../etc/passwd',
        dir,
        (type, reason) => emitted.push({ type, reason }),
      );
      assert.strictEqual(result, '');
      assert.strictEqual(emitted.length, 1);
      assert.strictEqual(emitted[0].type, 'transcript_path_containment_failed');
    } finally {
      cleanup(dir);
    }
  });

  test('returns "" and calls emitFn for absolute path outside cwd', () => {
    const dir = makeSandbox();
    try {
      const emitted = [];
      const result = validateTranscriptPath(
        '/etc/passwd',
        dir,
        (type, reason) => emitted.push({ type, reason }),
      );
      assert.strictEqual(result, '');
      assert.strictEqual(emitted.length, 1);
      assert.strictEqual(emitted[0].type, 'transcript_path_containment_failed');
    } finally {
      cleanup(dir);
    }
  });

  test('returns "" without calling emitFn for null/empty input', () => {
    const dir = makeSandbox();
    try {
      const emitted = [];
      const emit = (type) => emitted.push(type);
      assert.strictEqual(validateTranscriptPath(null, dir, emit), '');
      assert.strictEqual(validateTranscriptPath('', dir, emit), '');
      assert.strictEqual(emitted.length, 0, 'absent path must not emit a violation event');
    } finally {
      cleanup(dir);
    }
  });

  test('returns resolved path for a legitimate file inside cwd', () => {
    const dir = makeSandbox();
    try {
      const legit = path.join(dir, 'transcript.jsonl');
      fs.writeFileSync(legit, '{"type":"user","message":{"content":"hello"}}\n');
      const emitted = [];
      const result = validateTranscriptPath(legit, dir, (t) => emitted.push(t));
      assert.strictEqual(result, legit);
      assert.strictEqual(emitted.length, 0);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. validate-no-deferral.js — collectOutput must reject traversal path
// ---------------------------------------------------------------------------

describe('validate-no-deferral collectOutput — T4 F3', () => {
  const { collectOutput } = require(path.join(REPO_ROOT, 'bin/validate-no-deferral'));

  // v2.2.21 W4-T20: collectOutput now returns { text, scan_source } per I-SE-2
  // (T25 worktree). Tests updated to extract `text` from the returned object.

  test('returns text:"" for attacker-supplied transcript_path ../../../etc/passwd', () => {
    const dir = makeSandbox();
    try {
      const result = collectOutput({ transcript_path: '../../../etc/passwd' }, dir);
      assert.strictEqual(result.text, '', 'traversal path must be blocked and return empty text');
    } finally {
      cleanup(dir);
    }
  });

  test('emits transcript_path_containment_failed audit event on traversal', () => {
    const dir = makeSandbox();
    try {
      collectOutput({ transcript_path: '../../../etc/passwd' }, dir);
      const events = readEvents(dir);
      const failEvt = events.find((e) => e.type === 'transcript_path_containment_failed');
      assert.ok(failEvt, 'expected transcript_path_containment_failed event in audit log');
    } finally {
      cleanup(dir);
    }
  });

  test('returns content for a legitimate transcript inside cwd', () => {
    const dir = makeSandbox();
    try {
      const legit = path.join(dir, 'transcript.txt');
      fs.writeFileSync(legit, 'all clear');
      const result = collectOutput({ transcript_path: legit }, dir);
      assert.strictEqual(result.text, 'all clear');
      assert.strictEqual(result.scan_source, 'transcript_tail');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. emit-compression-telemetry.js — readDelegationPrompt must reject traversal
// ---------------------------------------------------------------------------

describe('emit-compression-telemetry readDelegationPrompt — T4 F4', () => {
  const { readDelegationPrompt } = require(path.join(REPO_ROOT, 'bin/emit-compression-telemetry'));

  test('returns null for attacker-supplied transcript path ../../../etc/passwd', () => {
    const dir = makeSandbox();
    try {
      const result = readDelegationPrompt('../../../etc/passwd', dir);
      assert.strictEqual(result, null, 'traversal path must be rejected and return null');
    } finally {
      cleanup(dir);
    }
  });

  test('returns null for absolute outside-cwd path /etc/passwd', () => {
    const dir = makeSandbox();
    try {
      const result = readDelegationPrompt('/etc/passwd', dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('emits transcript_path_containment_failed event on traversal', () => {
    const dir = makeSandbox();
    try {
      readDelegationPrompt('../../../etc/passwd', dir);
      const events = readEvents(dir);
      const failEvt = events.find((e) => e.type === 'transcript_path_containment_failed');
      assert.ok(failEvt, 'expected transcript_path_containment_failed event in audit log');
    } finally {
      cleanup(dir);
    }
  });

  test('returns prompt text for a legitimate JSONL transcript inside cwd', () => {
    const dir = makeSandbox();
    try {
      const legit = path.join(dir, 'transcript.jsonl');
      fs.writeFileSync(legit, JSON.stringify({ type: 'user', message: { content: 'hello agent' } }) + '\n');
      const result = readDelegationPrompt(legit, dir);
      assert.strictEqual(result, 'hello agent');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. validate-task-completion.js — checkArtifactBodySizes must reject traversal
// ---------------------------------------------------------------------------

describe('validate-task-completion checkArtifactBodySizes — T4 F7', () => {
  const { checkArtifactBodySizes } = require(path.join(REPO_ROOT, 'bin/validate-task-completion'));

  const enabledCapConfig = {
    enabled: true,
    warn_tokens: 2500,
    block_tokens: 5000,
    hard_block: false,
  };

  // `findings_path` is a real ARTIFACT_PATH_FIELDS entry measured by checkArtifactBodySizes.
  // (`files_changed` is NOT in that list — using the correct field is required for the guard to fire.)

  test('skips silently for attacker-supplied path ../../../etc/passwd (findings_path)', () => {
    const dir = makeSandbox();
    try {
      const result = checkArtifactBodySizes(
        { findings_path: '../../../etc/passwd' },
        dir,
        enabledCapConfig,
      );
      // The traversal path must be silently skipped — result array empty.
      assert.strictEqual(result.length, 0, 'traversal artifact path must be silently skipped');
    } finally {
      cleanup(dir);
    }
  });

  test('skips silently for absolute outside-cwd path /etc/passwd (findings_path)', () => {
    const dir = makeSandbox();
    try {
      const result = checkArtifactBodySizes(
        { findings_path: '/etc/passwd' },
        dir,
        enabledCapConfig,
      );
      assert.strictEqual(result.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  test('measures a legitimate artifact file inside cwd (findings_path)', () => {
    const dir = makeSandbox();
    try {
      const artFile = path.join(dir, 'result.md');
      fs.writeFileSync(artFile, 'small content');
      const result = checkArtifactBodySizes(
        { findings_path: artFile },
        dir,
        enabledCapConfig,
      );
      assert.strictEqual(result.length, 1, 'legitimate file must produce a result entry');
      assert.strictEqual(result[0].action, 'pass');
    } finally {
      cleanup(dir);
    }
  });
});
