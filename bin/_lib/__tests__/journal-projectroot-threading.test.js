#!/usr/bin/env node
'use strict';

/**
 * v2.3.24 Item 3 — degraded-journal projectRoot threading.
 *
 * `recordDegradation()` honours `event.projectRoot` and falls back to
 * `process.cwd()` when absent. Three call sites failed to thread the resolved
 * projectRoot into the helper that actually emits, so the journal write
 * silently landed under process.cwd() (the repo root during `npm test`)
 * instead of the caller's supplied root:
 *
 *   - bin/kb-refs-sweep.js         _loadKbSlugs / _loadSlugIgnoreFile
 *   - bin/_lib/pattern-seen-set.js _readRows (recordSeen/isSeenInOrch/clearForOrch)
 *   - bin/_lib/curator-diff.js     _journalCorrupt / _journalHashFailed
 *     (computeDirtySet -> isDirty), including the stray session sentinel file.
 *
 * Every test here runs in a child process with its own chdir'd "repo" stand-in
 * (never this repo's real cwd) so the assertions are race-free against
 * concurrent `npm test` runs elsewhere in the tree, and so a fallback bug
 * cannot leak into the real repository's own journal.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KB_REFS_SWEEP = path.resolve(__dirname, '..', '..', 'kb-refs-sweep.js');
const PATTERN_SEEN_SET = path.resolve(__dirname, '..', 'pattern-seen-set.js');
const CURATOR_DIFF = path.resolve(__dirname, '..', 'curator-diff.js');

/** Run `bodyJs` in a fresh node process with TEST_CWD as process.cwd(). */
function runHarness(bodyJs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-root-'));
  const cwdStandIn = path.join(root, 'cwd-stand-in');   // stands in for process.cwd() / "the repo"
  const otherRoot = path.join(root, 'other-root');       // the explicitly supplied projectRoot
  fs.mkdirSync(cwdStandIn, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });

  const harnessPath = path.join(root, 'harness.js');
  const script = `
'use strict';
const path = require('node:path');
const fs = require('node:fs');
process.chdir(process.env.CWD_STAND_IN);
const CWD_STAND_IN = process.env.CWD_STAND_IN;
const OTHER_ROOT = process.env.OTHER_ROOT;
${bodyJs}
`;
  fs.writeFileSync(harnessPath, script, 'utf8');

  const env = Object.assign({}, process.env, {
    CWD_STAND_IN: cwdStandIn,
    OTHER_ROOT: otherRoot,
  });
  const r = spawnSync('node', [harnessPath], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.status, 0, 'harness failed: ' + r.stderr);

  return { root, cwdStandIn, otherRoot };
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// kb-refs-sweep.js — _loadKbSlugs / _loadSlugIgnoreFile
// ---------------------------------------------------------------------------

describe('kb-refs-sweep — degraded journal follows the supplied projectRoot', () => {
  test('_loadKbSlugs: missing index.json emits file_read_failed under projectRoot, not cwd', () => {
    const { root, cwdStandIn, otherRoot } = runHarness(`
      const sweep = require(${JSON.stringify(KB_REFS_SWEEP)});
      const kbDir = path.join(OTHER_ROOT, '.orchestray', 'kb');
      fs.mkdirSync(kbDir, { recursive: true }); // dir exists, index.json does not (ENOENT)
      const result = sweep._loadKbSlugs(kbDir, OTHER_ROOT);
      if (result !== null) throw new Error('expected null for missing index.json');
    `);

    const otherJournal = readJsonl(path.join(otherRoot, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      otherJournal.some(e => e.kind === 'file_read_failed'),
      'file_read_failed recorded under supplied projectRoot'
    );

    const cwdJournal = path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(!fs.existsSync(cwdJournal), 'cwd journal must not be created — projectRoot was honoured');
    cleanup(root);
  });

  test('_loadSlugIgnoreFile: oversize file emits file_too_large under projectRoot, not cwd', () => {
    const { root, cwdStandIn, otherRoot } = runHarness(`
      const sweep = require(${JSON.stringify(KB_REFS_SWEEP)});
      const kbDir = path.join(OTHER_ROOT, '.orchestray', 'kb');
      fs.mkdirSync(kbDir, { recursive: true });
      fs.writeFileSync(path.join(kbDir, 'slug-ignore.txt'), 'x'.repeat(1024 * 1024 + 1), 'utf8');
      const result = sweep._loadSlugIgnoreFile(kbDir, OTHER_ROOT);
      if (!Array.isArray(result) || result.length !== 0) throw new Error('expected [] fail-open');
    `);

    const otherJournal = readJsonl(path.join(otherRoot, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      otherJournal.some(e => e.kind === 'file_too_large'),
      'file_too_large recorded under supplied projectRoot'
    );

    const cwdJournal = path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(!fs.existsSync(cwdJournal), 'cwd journal must not be created — projectRoot was honoured');
    cleanup(root);
  });

  test('_loadKbSlugs: absent projectRoot preserves legacy fallback to process.cwd()', () => {
    const { root, cwdStandIn } = runHarness(`
      const sweep = require(${JSON.stringify(KB_REFS_SWEEP)});
      const kbDir = path.join(CWD_STAND_IN, '.orchestray', 'kb');
      fs.mkdirSync(kbDir, { recursive: true });
      const result = sweep._loadKbSlugs(kbDir); // no projectRoot arg — legacy call shape
      if (result !== null) throw new Error('expected null for missing index.json');
    `);

    const cwdJournal = readJsonl(path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      cwdJournal.some(e => e.kind === 'file_read_failed'),
      'legacy no-projectRoot call still falls back to process.cwd()'
    );
    cleanup(root);
  });
});

// ---------------------------------------------------------------------------
// pattern-seen-set.js — _readRows via isSeenInOrch/recordSeen/clearForOrch
// ---------------------------------------------------------------------------

describe('pattern-seen-set — degraded journal follows the supplied projectRoot', () => {
  test('isSeenInOrch: malformed JSONL lines emit pattern_seen_set_recovered under projectRoot, not cwd', () => {
    const { root, cwdStandIn, otherRoot } = runHarness(`
      const pss = require(${JSON.stringify(PATTERN_SEEN_SET)});
      const stateDir = path.join(OTHER_ROOT, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'pattern-seen-set.jsonl'),
        'NOT JSON\\n{"orch_id":"o1","slug":"s1","first_agent":"x","body_hash":"h","ts":"t"}\\nALSO BAD\\n',
        'utf8'
      );
      const result = pss.isSeenInOrch('o1', 's1', OTHER_ROOT);
      if (result.seen !== true) throw new Error('expected the one valid row to be salvaged');
    `);

    const otherJournal = readJsonl(path.join(otherRoot, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      otherJournal.some(e => e.kind === 'pattern_seen_set_recovered'),
      'pattern_seen_set_recovered recorded under supplied projectRoot'
    );

    const cwdJournal = path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(!fs.existsSync(cwdJournal), 'cwd journal must not be created — projectRoot was honoured');
    cleanup(root);
  });

  test('_readRows: unreadable dir (non-ENOENT stat error) emits pattern_seen_set_corrupt under projectRoot, not cwd', () => {
    if (process.getuid && process.getuid() === 0) {
      // chmod 000 is a no-op for root — skip in containers running as root.
      return;
    }
    const { root, cwdStandIn, otherRoot } = runHarness(`
      const pss = require(${JSON.stringify(PATTERN_SEEN_SET)});
      // Deliberately OUTSIDE .orchestray/state so blocking it does not also
      // block degraded.jsonl's own write target under OTHER_ROOT.
      const blockedDir = path.join(OTHER_ROOT, 'blocked');
      fs.mkdirSync(blockedDir, { recursive: true });
      const file = path.join(blockedDir, 'pattern-seen-set.jsonl');
      fs.writeFileSync(file, '{"orch_id":"o1","slug":"s1"}\\n', 'utf8');
      // Restrict the containing dir (not the file) so fs.statSync() itself throws
      // EACCES — that is the _readRows branch that emits pattern_seen_set_corrupt.
      fs.chmodSync(blockedDir, 0o000);
      try {
        pss._readRows(file, OTHER_ROOT);
      } finally {
        fs.chmodSync(blockedDir, 0o755); // restore so cleanup can rmSync the tree
      }
    `);

    const otherJournal = readJsonl(path.join(otherRoot, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      otherJournal.some(e => e.kind === 'pattern_seen_set_corrupt'),
      'pattern_seen_set_corrupt recorded under supplied projectRoot'
    );

    const cwdJournal = path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(!fs.existsSync(cwdJournal), 'cwd journal must not be created — projectRoot was honoured');
    cleanup(root);
  });

  test('isSeenInOrch: absent projectRoot preserves legacy fallback to process.cwd()', () => {
    const { root, cwdStandIn } = runHarness(`
      const pss = require(${JSON.stringify(PATTERN_SEEN_SET)});
      const stateDir = path.join(CWD_STAND_IN, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'pattern-seen-set.jsonl'), 'NOT JSON\\n', 'utf8');
      pss.isSeenInOrch('o1', 's1'); // no projectRoot arg — legacy call shape
    `);

    const cwdJournal = readJsonl(path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      cwdJournal.some(e => e.kind === 'pattern_seen_set_recovered'),
      'legacy no-projectRoot call still falls back to process.cwd()'
    );
    cleanup(root);
  });
});

// ---------------------------------------------------------------------------
// curator-diff.js — computeDirtySet -> isDirty -> _journalCorrupt (+ sentinel)
// ---------------------------------------------------------------------------

// A stamp with an action_id but no `at`/`body_sha256` forces isDirty into the
// _journalCorrupt branch (same fixture shape as curator-cursor-reset.test.js).
const CORRUPT_PATTERN = [
  '---',
  'recently_curated_action_id: action-123',
  '---',
  '# corrupt pattern',
  'body text here',
  '',
].join('\\n');

describe('curator-diff — degraded journal + sentinel follow the supplied projectRoot', () => {
  test('computeDirtySet: corrupt stamp emits curator_cursor_reset/curator_diff_cursor_corrupt under projectRoot, not cwd', () => {
    const { root, cwdStandIn, otherRoot } = runHarness(`
      const diff = require(${JSON.stringify(CURATOR_DIFF)});
      const patternsDir = path.join(OTHER_ROOT, '.orchestray', 'patterns');
      fs.mkdirSync(patternsDir, { recursive: true });
      fs.writeFileSync(path.join(patternsDir, 'a.md'), '${CORRUPT_PATTERN}', 'utf8');

      diff.computeDirtySet({
        patternsDir,
        cutoffDays: 30,
        runCounterPath: path.join(OTHER_ROOT, 'run-counter.json'),
        activeTombstonesPath: path.join(OTHER_ROOT, 'tombstones.jsonl'),
        projectRoot: OTHER_ROOT,
      });
    `);

    const otherJournal = readJsonl(path.join(otherRoot, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      otherJournal.some(e => e.kind === 'curator_cursor_reset'),
      'curator_cursor_reset recorded under supplied projectRoot'
    );
    assert.ok(
      otherJournal.some(e => e.kind === 'curator_diff_cursor_corrupt'),
      'curator_diff_cursor_corrupt recorded under supplied projectRoot'
    );

    // Stray session sentinel must land under the supplied root too.
    const otherSentinels = fs.readdirSync(path.join(otherRoot, '.orchestray', 'state'))
      .filter(n => n.startsWith('.curator-cursor-reset-'));
    assert.equal(otherSentinels.length, 1, 'sentinel written under projectRoot');

    const cwdStateDir = path.join(cwdStandIn, '.orchestray', 'state');
    assert.ok(!fs.existsSync(cwdStateDir), 'cwd .orchestray/state must not be created — projectRoot was honoured');
    cleanup(root);
  });

  test('computeDirtySet: absent projectRoot preserves legacy fallback to process.cwd()', () => {
    const { root, cwdStandIn } = runHarness(`
      const diff = require(${JSON.stringify(CURATOR_DIFF)});
      const patternsDir = path.join(CWD_STAND_IN, '.orchestray', 'patterns');
      fs.mkdirSync(patternsDir, { recursive: true });
      fs.writeFileSync(path.join(patternsDir, 'a.md'), '${CORRUPT_PATTERN}', 'utf8');

      diff.computeDirtySet({
        patternsDir,
        cutoffDays: 30,
        runCounterPath: path.join(CWD_STAND_IN, 'run-counter.json'),
        activeTombstonesPath: path.join(CWD_STAND_IN, 'tombstones.jsonl'),
        // no projectRoot — legacy call shape
      });
    `);

    const cwdJournal = readJsonl(path.join(cwdStandIn, '.orchestray', 'state', 'degraded.jsonl'));
    assert.ok(
      cwdJournal.some(e => e.kind === 'curator_cursor_reset'),
      'legacy no-projectRoot call still falls back to process.cwd() for the journal'
    );
    const cwdSentinels = fs.readdirSync(path.join(cwdStandIn, '.orchestray', 'state'))
      .filter(n => n.startsWith('.curator-cursor-reset-'));
    assert.equal(cwdSentinels.length, 1, 'legacy no-projectRoot call still falls back to process.cwd() for the sentinel');
    cleanup(root);
  });
});
