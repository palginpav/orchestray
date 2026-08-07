#!/usr/bin/env node
'use strict';

/**
 * commit-pattern-applications.test.js — Phase 3 orch-close committer tests.
 *
 * Verifies:
 *   1. End-to-end: offer + ack ledger rows → frontmatter delta, journal rows,
 *      pattern_application_recorded event with accurate before/after.
 *   2. An ambient-not-promoted offer increments times_offered but not
 *      times_applied, and emits pattern_application_withheld{reason:
 *      "ambient_not_promoted"} (§5.4).
 *   3. Kill switch ORCHESTRAY_PATTERN_EVIDENCE_DISABLED=1 — no-op.
 *   4. ORCHESTRAY_PATTERN_EVIDENCE_COMMIT_DISABLED=1 — events emitted, no
 *      frontmatter mutation, no journal rows (observe-only, §10.1).
 *   5. Idempotency — re-running for the same orchestration_id does not
 *      double-increment (§5.2 belt-and-braces).
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/commit-pattern-applications.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'commit-pattern-applications.js');
const ledger = require('../_lib/pattern-evidence-ledger');
const { parse: parseFm } = require('../mcp-server/lib/frontmatter');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-commit-pattern-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'patterns'), { recursive: true });
  // Fixture shared tier — keeps the machine's real federation corpus out of
  // every run now that the committer resolves all three tiers.
  fs.mkdirSync(path.join(tmpDir, 'shared', 'patterns'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-1' })
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writePatternFile(slug, extra) {
  const fm = Object.assign({
    name: slug, category: 'pattern', confidence: 0.8,
    times_applied: 0, times_offered: 0, times_contradicted: 0, last_applied: null,
  }, extra || {});
  const lines = Object.entries(fm).map(([k, v]) => k + ': ' + (v === null ? 'null' : v));
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'),
    '---\n' + lines.join('\n') + '\n---\n# ' + slug + '\n'
  );
}

function readPatternFm(slug) {
  const content = fs.readFileSync(path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'), 'utf8');
  return parseFm(content).frontmatter;
}

function scriptEnv(extraEnv) {
  return Object.assign(
    {}, process.env,
    { ORCHESTRAY_TEST_SHARED_DIR: path.join(tmpDir, 'shared') },
    extraEnv || {}
  );
}

function runScript(extraEnv) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd: tmpDir }),
    encoding: 'utf8',
    env: scriptEnv(extraEnv),
  });
  if (result.error) throw result.error;
  return result;
}

/** Same invocation, launched without waiting — for the concurrency test. */
function startScript() {
  const child = spawn(process.execPath, [SCRIPT], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: scriptEnv(),
  });
  child.stdin.end(JSON.stringify({ cwd: tmpDir }));
  return new Promise((resolve) => child.on('close', resolve));
}

function writeTierPatternFile(dir, slug) {
  fs.mkdirSync(dir, { recursive: true });
  const fm = { name: slug, category: 'pattern', confidence: 0.8, times_applied: 0, times_offered: 0 };
  const lines = Object.entries(fm).map(([k, v]) => k + ': ' + v);
  fs.writeFileSync(path.join(dir, slug + '.md'), '---\n' + lines.join('\n') + '\n---\n# ' + slug + '\n');
}

function readFmAt(file) {
  return parseFm(fs.readFileSync(file, 'utf8')).frontmatter;
}

function offerAndAck(slug, orchId) {
  ledger.appendOffer(tmpDir, {
    orchestration_id: orchId, spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    offers: [{ slug, offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: orchId, spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W1',
    source: 'structured_result', used: [{ slug, how_len: 50 }], rejected: [], agent_status: 'success',
  });
}

function readJsonl(relPath) {
  const p = path.join(tmpDir, relPath);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readEvents() { return readJsonl(path.join('.orchestray', 'audit', 'events.jsonl')); }
function readJournal() { return readJsonl(path.join('.orchestray', 'state', 'pattern-counter-journal.jsonl')); }

// ---------------------------------------------------------------------------
// End-to-end credited flow
// ---------------------------------------------------------------------------

test('credited slug: frontmatter delta, journal rows, and pattern_application_recorded event', () => {
  writePatternFile('foo-bar');
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W3',
    offers: [{ slug: 'foo-bar', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W3',
    source: 'structured_result', used: [{ slug: 'foo-bar', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  const result = runScript();
  assert.equal(result.status, 0);

  const fm = readPatternFm('foo-bar');
  assert.equal(fm.times_applied, 1);
  assert.equal(fm.times_offered, 1);
  assert.notEqual(fm.last_applied, null);

  const journal = readJournal();
  assert.ok(journal.some((r) => r.slug === 'foo-bar' && r.field === 'times_applied' && r.before === 0 && r.after === 1));
  assert.ok(journal.some((r) => r.slug === 'foo-bar' && r.field === 'times_offered' && r.after === 1));

  const events = readEvents();
  const recorded = events.find((e) => e.type === 'pattern_application_recorded' && e.slug === 'foo-bar');
  assert.ok(recorded, 'pattern_application_recorded emitted');
  assert.equal(recorded.times_applied_before, 0);
  assert.equal(recorded.times_applied_after, 1);
  assert.equal(recorded.evidence_grade, 'observed');
});

// ---------------------------------------------------------------------------
// Ambient not promoted — offered but not credited
// ---------------------------------------------------------------------------

test('ambient offer below promotion threshold: times_offered increments, times_applied does not', () => {
  writePatternFile('ambient-slug');
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W3',
    offers: [{ slug: 'ambient-slug', offer_kind: 'ambient', confidence: 0.6 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', agent_role: 'developer', task_id: 'W3',
    source: 'structured_result', used: [{ slug: 'ambient-slug', how_len: 12 }], rejected: [], agent_status: 'success',
  });

  runScript();

  const fm = readPatternFm('ambient-slug');
  assert.equal(fm.times_applied, 0);
  assert.equal(fm.times_offered, 1);

  const withheld = readEvents().find((e) => e.type === 'pattern_application_withheld' && e.slug === 'ambient-slug');
  assert.ok(withheld);
  assert.equal(withheld.reason, 'ambient_not_promoted');
});

// ---------------------------------------------------------------------------
// times_offered semantics (schemas/pattern.schema.js: "distinct
// orchestrations", matching times_applied and the migration's Set(orch_id)
// backfill — NOT a per-spawn count within one orchestration)
// ---------------------------------------------------------------------------

test('two spawns offering the same slug in one orchestration increment times_offered by 1, not 2', () => {
  writePatternFile('multi-spawn-slug');
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a',
    offers: [{ slug: 'multi-spawn-slug', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-b',
    offers: [{ slug: 'multi-spawn-slug', offer_kind: 'curated', confidence: 0.9 }],
  });

  runScript();

  assert.equal(readPatternFm('multi-spawn-slug').times_offered, 1);
});

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------

test('ORCHESTRAY_PATTERN_EVIDENCE_DISABLED=1 is a full no-op', () => {
  writePatternFile('foo-bar');
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', offers: [{ slug: 'foo-bar', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', source: 'structured_result',
    used: [{ slug: 'foo-bar', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  runScript({ ORCHESTRAY_PATTERN_EVIDENCE_DISABLED: '1' });

  assert.equal(readPatternFm('foo-bar').times_applied, 0);
  assert.deepEqual(readJournal(), []);
  assert.deepEqual(readEvents(), []);
});

test('ORCHESTRAY_PATTERN_EVIDENCE_COMMIT_DISABLED=1 emits events but writes no frontmatter', () => {
  writePatternFile('foo-bar');
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', offers: [{ slug: 'foo-bar', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', source: 'structured_result',
    used: [{ slug: 'foo-bar', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  runScript({ ORCHESTRAY_PATTERN_EVIDENCE_COMMIT_DISABLED: '1' });

  assert.equal(readPatternFm('foo-bar').times_applied, 0, 'no frontmatter mutation in observe-only mode');
  assert.deepEqual(readJournal(), [], 'no journal rows in observe-only mode');
  const recorded = readEvents().find((e) => e.type === 'pattern_application_recorded');
  assert.ok(recorded, 'event still emitted in observe-only mode');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('re-running for the same orchestration does not double-increment', () => {
  writePatternFile('foo-bar');
  ledger.appendOffer(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', offers: [{ slug: 'foo-bar', offer_kind: 'curated', confidence: 0.9 }],
  });
  ledger.appendAck(tmpDir, {
    orchestration_id: 'orch-test-1', spawn_id: 'spawn-a', source: 'structured_result',
    used: [{ slug: 'foo-bar', how_len: 50 }], rejected: [], agent_status: 'success',
  });

  runScript();
  runScript(); // second fire for the same orchestration_id

  assert.equal(readPatternFm('foo-bar').times_applied, 1);
  const journal = readJournal().filter((r) => r.slug === 'foo-bar' && r.field === 'times_applied');
  assert.equal(journal.length, 1);
});

// ---------------------------------------------------------------------------
// RV-1 E1 — two committers closing the SAME orchestration concurrently.
// The reviewer reproduced times_applied 0 -> 2 by launching a second process
// while the first was still reading a large event slice: the journal row that
// blocks the re-run was written only after the frontmatter write, so both
// passed the unlocked alreadyCommitted() check. The claim row closes that
// window because it is appended under the journal's lock, first.
// ---------------------------------------------------------------------------

test('two concurrent committers for one orchestration increment exactly once', async () => {
  writePatternFile('race-slug');
  offerAndAck('race-slug', 'orch-test-1');

  // A large archived slice widens the read-then-write window the way the
  // reviewer's reproduction did; the claim path exits before this is read.
  const histDir = path.join(tmpDir, '.orchestray', 'history', 'orch-test-1');
  fs.mkdirSync(histDir, { recursive: true });
  const filler = [];
  for (let i = 0; i < 60000; i++) {
    filler.push(JSON.stringify({
      type: 'agent_stop', orchestration_id: 'orch-test-1', task_id: 'W' + i,
      note: 'padding to widen the commit window '.repeat(2), i,
    }));
  }
  fs.writeFileSync(path.join(histDir, 'events.jsonl'), filler.join('\n') + '\n');

  await Promise.all([startScript(), startScript()]);

  assert.equal(readPatternFm('race-slug').times_applied, 1, 'concurrent close must not double-credit');
  assert.equal(readPatternFm('race-slug').times_offered, 1);

  const journal = readJournal();
  assert.equal(journal.filter((r) => r.slug === 'race-slug' && r.field === 'times_applied').length, 1);
  assert.equal(journal.filter((r) => r.kind === 'claim').length, 1, 'exactly one committer claimed the orchestration');
});

// ---------------------------------------------------------------------------
// RV-1 E6 — team/shared-tier patterns are offer-eligible, so they must also
// be counter-writable. Local-only resolution emitted a phantom
// pattern_application_recorded{before:0, after:0} and never moved the counter.
// ---------------------------------------------------------------------------

test('a shared-tier pattern is credited in place, not skipped as not found', () => {
  const sharedFile = path.join(tmpDir, 'shared', 'patterns', 'shared-slug.md');
  writeTierPatternFile(path.dirname(sharedFile), 'shared-slug');
  offerAndAck('shared-slug', 'orch-test-1');

  const result = runScript();
  assert.equal(result.status, 0);
  assert.ok(!/pattern file not found/.test(result.stderr || ''), 'no "not found" warning: ' + result.stderr);

  const fm = readFmAt(sharedFile);
  assert.equal(fm.times_applied, 1);
  assert.equal(fm.times_offered, 1);

  const recorded = readEvents().find((e) => e.type === 'pattern_application_recorded' && e.slug === 'shared-slug');
  assert.ok(recorded);
  assert.equal(recorded.times_applied_after, 1, 'event must not claim a credit the counter never took');

  const journalRow = readJournal().find((r) => r.slug === 'shared-slug' && r.field === 'times_applied');
  assert.equal(journalRow.tier, 'shared', 'journal records the tier so revert finds the same file');
});

test('a team-tier pattern is credited, and a local file of the same slug wins', () => {
  const teamDir = path.join(tmpDir, '.orchestray', 'team-patterns');
  writeTierPatternFile(teamDir, 'team-slug');
  writeTierPatternFile(teamDir, 'both-tiers');
  writePatternFile('both-tiers');
  offerAndAck('team-slug', 'orch-test-1');
  offerAndAck('both-tiers', 'orch-test-1');

  runScript();

  assert.equal(readFmAt(path.join(teamDir, 'team-slug.md')).times_applied, 1);
  assert.equal(readPatternFm('both-tiers').times_applied, 1, 'local tier wins');
  assert.equal(readFmAt(path.join(teamDir, 'both-tiers.md')).times_applied, 0, 'team copy untouched');
});
