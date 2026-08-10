'use strict';

/**
 * v2.3.12 W9 (B1) — cross-process persistent dedup.
 *
 * Simulates two process invocations by clearing the in-process _seen Set via a
 * fresh module load (require cache bust). The persistent on-disk index must
 * suppress a repeat `info` record of a dedup-eligible kind, while error/warn and
 * non-eligible kinds always append.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dj-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

function freshJournal() {
  delete require.cache[require.resolve('../bin/_lib/degraded-journal')];
  return require('../bin/_lib/degraded-journal');
}

function countLines(root) {
  const jp = path.join(root, '.orchestray', 'state', 'degraded.jsonl');
  if (!fs.existsSync(jp)) return 0;
  return fs.readFileSync(jp, 'utf8').trim().split('\n').filter(Boolean).length;
}

test('info dedup-kind suppressed across process invocations', () => {
  const root = mkProject();
  const ev = {
    kind: 'kb_refs_sweep_malformed_frontmatter',
    severity: 'info',
    detail: { file: '/x/2012-foo.md', dedup_key: 'malformed|/x/2012-foo.md' },
    projectRoot: root,
  };
  // process 1
  let dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true);
  // process 2 (fresh module → empty _seen, but persistent index suppresses)
  dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, false);
  assert.strictEqual(countLines(root), 1, 'only one line across two invocations');
  fs.rmSync(root, { recursive: true, force: true });
});

test('warn severity always appends across invocations', () => {
  const root = mkProject();
  const ev = {
    kind: 'kb_refs_sweep_file_oversize',
    severity: 'warn',
    detail: { file: '/x/big.md', dedup_key: 'oversize|/x/big.md' },
    projectRoot: root,
  };
  let dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true);
  dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true, 'warn not suppressed');
  assert.strictEqual(countLines(root), 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('non-eligible info kind appends across invocations', () => {
  const root = mkProject();
  const ev = {
    kind: 'fts5_fallback',
    severity: 'info',
    detail: { reason: 'x' },
    projectRoot: root,
  };
  let dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true);
  dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true, 'non-eligible kind not persist-deduped');
  fs.rmSync(root, { recursive: true, force: true });
});

test('kill switch disables persistent dedup', () => {
  const root = mkProject();
  // v2.3.24: 'agent_registry_stale' is no longer PERSISTENT_DEDUP_KINDS-eligible
  // (it is emitted at 'warn', which the dedup gate never covers) — use an
  // eligible kind so this test actually exercises the kill switch.
  const ev = {
    kind: 'kb_refs_sweep_file_oversize',
    severity: 'info',
    detail: { n: 1 },
    projectRoot: root,
  };
  const prev = process.env.ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED;
  process.env.ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED = '1';
  let dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true);
  dj = freshJournal();
  assert.strictEqual(dj.recordDegradation(ev).appended, true, 'kill switch → no suppression');
  if (prev === undefined) delete process.env.ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED;
  else process.env.ORCHESTRAY_JOURNAL_PERSIST_DEDUP_DISABLED = prev;
  fs.rmSync(root, { recursive: true, force: true });
});
