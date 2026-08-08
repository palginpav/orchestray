'use strict';

/**
 * kb-decision-health.js — doctor probe (P9d) surfacing KB decision staleness.
 *
 * Guards the exact drift that prompted this probe: three decisions sat with
 * `**Status: OPEN**` (one `OPEN, blocking`) and `# OPEN: ...` titles for
 * hours after the underlying work was already fixed. A probe that only
 * reports "0 open" is indistinguishable from "everything is fine" and from
 * "I can't classify most of this corpus" — this suite pins both the count
 * split and the title/status contradiction check that catches stale OPENs.
 *
 * Run: node --require ./tests/helpers/setup.js --test tests/kb-decision-health.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', '_lib', 'kb-decision-health.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-decision-health-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  return dir;
}

/** Write a decision file, optionally back-dating its mtime. */
function writeDecision(dir, name, content, ageHours) {
  const file = path.join(dir, '.orchestray', 'kb', 'decisions', name);
  fs.writeFileSync(file, content);
  if (typeof ageHours === 'number') {
    const past = new Date(Date.now() - ageHours * 3600000);
    fs.utimesSync(file, past, past);
  }
  return file;
}

function runJson(dir) {
  return spawnSync(process.execPath, [SCRIPT, '--json', '--cwd', dir], {
    encoding: 'utf8',
    timeout: 8000,
  });
}

describe('scanDecisions (pure function)', () => {
  test('all zeros when the decisions directory does not exist', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-decision-health-empty-'));
    cleanup.push(dir);
    const result = scanDecisions(dir);
    assert.equal(result.total, 0);
    assert.equal(result.withStatus, 0);
    assert.equal(result.withoutStatus, 0);
    assert.equal(result.openCount, 0);
    assert.deepEqual(result.contradictions, []);
  });

  test('files with no **Status: line are counted, not misclassified', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    writeDecision(dir, 'a.md', '# Some legacy decision\n\nNo status convention here.\n');
    writeDecision(dir, 'b.md', '# Another legacy one\n\nPlain body text.\n');
    const result = scanDecisions(dir);
    assert.equal(result.total, 2);
    assert.equal(result.withStatus, 0);
    assert.equal(result.withoutStatus, 2, 'legacy files must be counted as unclassifiable, not failed');
    assert.equal(result.openCount, 0);
  });

  test('distinguishes "none open" from "most unclassifiable" — the crux this probe exists for', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    // 3 legacy files with no status line at all.
    writeDecision(dir, 'legacy1.md', '# Legacy 1\n\nbody\n');
    writeDecision(dir, 'legacy2.md', '# Legacy 2\n\nbody\n');
    writeDecision(dir, 'legacy3.md', '# Legacy 3\n\nbody\n');
    // 1 file with a resolved status.
    writeDecision(dir, 'resolved.md', '# RESOLVED: fixed thing\n\n**Status: RESOLVED 2026-08-08.** Done.\n');
    const result = scanDecisions(dir);
    assert.equal(result.total, 4);
    assert.equal(result.openCount, 0, 'nothing is actually marked open');
    assert.equal(result.withoutStatus, 3, 'but 3 of 4 remain unclassifiable — must not read as all-clear');
    assert.equal(result.withStatus, 1);
  });

  test('counts an OPEN status and reports its age since last modification', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    writeDecision(dir, 'stale-open.md', '# OPEN: something blocking\n\n**Status: OPEN, blocking.** Needs a fix.\n', 30);
    const result = scanDecisions(dir);
    assert.equal(result.openCount, 1);
    assert.equal(result.openDecisions.length, 1);
    assert.equal(result.openDecisions[0].file, 'stale-open.md');
    assert.ok(result.openDecisions[0].ageHours >= 29, `expected ~30h stale, got ${result.openDecisions[0].ageHours}`);
  });

  test('title/status contradiction: OPEN title with a RESOLVED status fails loudly', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    // This is exactly the drift that happened: the fix landed, status was
    // updated, but the title was never corrected (or vice versa).
    writeDecision(dir, 'drifted.md', '# OPEN: the thing that was actually already fixed\n\n**Status: RESOLVED 2026-08-08.** Fixed by commit abc123.\n');
    const result = scanDecisions(dir);
    assert.equal(result.contradictions.length, 1, 'a title/status disagreement must be flagged');
    assert.equal(result.contradictions[0].file, 'drifted.md');
  });

  test('title/status contradiction: RESOLVED title with an OPEN status also fails loudly', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    writeDecision(dir, 'reverse-drift.md', '# RESOLVED: prematurely closed\n\n**Status: OPEN.** Not actually done.\n');
    const result = scanDecisions(dir);
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.contradictions[0].file, 'reverse-drift.md');
  });

  test('no contradiction when title and status agree', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    writeDecision(dir, 'consistent.md', '# RESOLVED: fixed cleanly\n\n**Status: RESOLVED 2026-08-08 (commit ef9bd9c).** Done.\n');
    writeDecision(dir, 'consistent-open.md', '# OPEN: genuinely still open\n\n**Status: OPEN, blocking.** Needs attention.\n');
    const result = scanDecisions(dir);
    assert.deepEqual(result.contradictions, []);
    assert.equal(result.openCount, 1, 'the genuinely-open one should still count as open');
  });

  test('"not yet fixed" is not misread as a resolved marker (real corpus phrasing)', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    // Real phrasing from this repo's own corpus: still unresolved despite
    // containing the word "fixed". Paired with an OPEN title to prove the
    // negation guard, not just the keyword scan.
    writeDecision(dir, 'diagnosed.md', '# OPEN: undercount not yet root-caused\n\n**Status: diagnosed, not yet fixed.** Still needs a fix.\n');
    const result = scanDecisions(dir);
    assert.deepEqual(result.contradictions, [], '"not yet fixed" must not read as a resolved marker');
  });

  test('a non-bold "Final status:" line does not count toward withStatus (matches the repo convention)', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    writeDecision(dir, 'final-status.md', '# CLOSED: permanent decision\n\n**Final status: CLOSED — permanent.** Will not be revived.\n');
    const result = scanDecisions(dir);
    // "**Final status:" does not match the "**Status:" convention this repo
    // actually uses — it must fall into withoutStatus, not silently misparse.
    assert.equal(result.withStatus, 0);
    assert.equal(result.withoutStatus, 1);
  });

  test('non-.md files in the decisions dir are ignored', () => {
    const { scanDecisions } = require(SCRIPT);
    const dir = makeDir();
    writeDecision(dir, 'real.md', '# Some decision\n\nbody\n');
    fs.writeFileSync(path.join(dir, '.orchestray', 'kb', 'decisions', 'notes.txt'), 'not a decision');
    const result = scanDecisions(dir);
    assert.equal(result.total, 1);
  });
});

describe('kb-decision-health: --json CLI mode', () => {
  test('emits structured JSON on stdout for doctor to parse', () => {
    const dir = makeDir();
    writeDecision(dir, 'open.md', '# OPEN: needs work\n\n**Status: OPEN.** Pending.\n');
    const result = runJson(dir);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.openCount, 1);
  });

  test('--json mode reports zero total gracefully when no decisions dir exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-decision-health-nodir-'));
    cleanup.push(dir);
    const result = runJson(dir);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.total, 0);
  });
});
