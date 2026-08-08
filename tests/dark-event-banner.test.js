'use strict';

/**
 * dark-event-banner.js — SessionStart advisory + doctor --json surface for
 * declared event types that have never fired.
 *
 * Why this exists: bin/audit-promised-events.js already computes the
 * dark-event signal and overwrites a fresh snapshot every run
 * (`.orchestray/state/promised-event-dark-state.last-run.json`) but has no
 * success-path human output. This banner reads that cached snapshot rather
 * than recomputing it (single source of truth, cheap at SessionStart), and
 * adds the one piece that was missing: telling a human.
 *
 * The snapshot is fully overwritten every run (not an accumulating log), so
 * computeDarkEvents() always reflects "dark as of the last scan" rather than
 * "was dark at some point in the last 30 days" — see v2.3.21 fix.
 *
 * Run: node --require ./tests/helpers/setup.js --test tests/dark-event-banner.test.js
 */

const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const crypto = require('node:crypto');

const ROOT   = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'dark-event-banner.js');

// Session IDs must be unique per test run, not just per test — the banner's
// tmpdir lock is keyed by session_id and outlives the process. A fixed
// literal would collide with a lock left behind by a prior run of this same
// file and silently suppress the banner on the next run.
function freshSessionId() {
  return 'dark-banner-test-' + crypto.randomBytes(6).toString('hex');
}

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// The banner's session lock lives in os.tmpdir(), outside the per-test dir —
// sweep it up so repeated local runs don't accumulate lock files.
after(() => {
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith('orchestray-dark-event-banner-dark-banner-test-')) {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_e) {}
      }
    }
  } catch (_e) {}
});

/** Build a temp project root with the .orchestray/state dir ready. */
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-event-banner-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

/** Write the fresh dark-set snapshot audit-promised-events.js produces. */
function writeState(dir, darkTypes, { candidateCount, generatedAt, truncated = false } = {}) {
  const file = path.join(dir, '.orchestray', 'state', 'promised-event-dark-state.last-run.json');
  fs.writeFileSync(file, JSON.stringify({
    generated_at:    generatedAt || new Date().toISOString(),
    candidate_count: candidateCount != null ? candidateCount : darkTypes.length + 300, // plenty of headroom by default
    dark_types:      darkTypes,
    truncated,
  }, null, 2));
}

/** Build a dark_types entry as audit-promised-events.js emits it. */
function darkEntry(eventType, daysDark, totalFireCount = 0) {
  return { event_type: eventType, days_dark: daysDark, total_fire_count: totalFireCount };
}

function runHook(dir, extraEnv = {}, sessionId) {
  const payload = JSON.stringify({ cwd: dir, session_id: sessionId });
  return spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 8000,
    env: Object.assign({}, process.env, extraEnv),
  });
}

function runJson(dir, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--json', '--cwd', dir], {
    encoding: 'utf8',
    timeout: 8000,
    env: Object.assign({}, process.env, extraEnv),
  });
}

// ── computeDarkEvents (pure function) ──────────────────────────────────────

describe('computeDarkEvents', () => {
  test('empty when the snapshot file is absent', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    const result = computeDarkEvents(dir, Date.now());
    assert.deepEqual(result.darkTypes, []);
    assert.equal(result.totalDark, 0);
  });

  test('reads dark_types from the fresh snapshot', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    writeState(dir, [darkEntry('oversized_synthesis_complete', 14)]);
    const result = computeDarkEvents(dir, Date.now());
    assert.equal(result.totalDark, 1);
    assert.equal(result.darkTypes[0].event_type, 'oversized_synthesis_complete');
    assert.equal(result.darkTypes[0].days_dark, 14);
    assert.equal(result.darkTypes[0].total_fire_count, 0);
  });

  test('a type absent from the fresh snapshot does not count, even with a stale historical flag', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    // Snapshot says only one type is dark right now.
    writeState(dir, [darkEntry('still_dark_type', 10)]);
    // A leftover events.jsonl row for a type that has SINCE started firing
    // must have zero influence — the snapshot is the only source of truth.
    fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), JSON.stringify({
      type: 'event_promised_but_dark', event_type: 'now_firing_type',
      days_dark: 20, timestamp: new Date().toISOString(),
    }) + '\n');
    const result = computeDarkEvents(dir, Date.now());
    assert.equal(result.totalDark, 1);
    assert.equal(result.darkTypes[0].event_type, 'still_dark_type');
  });

  test('sorts by days_dark descending', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    writeState(dir, [darkEntry('low_days', 8), darkEntry('high_days', 71), darkEntry('mid_days', 20)]);
    const result = computeDarkEvents(dir, Date.now());
    assert.deepEqual(result.darkTypes.map(d => d.event_type), ['high_days', 'mid_days', 'low_days']);
  });

  test('drops the whole snapshot when generated_at is stale (>30 days old)', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    const staleTs = new Date(Date.now() - 31 * 86400000).toISOString();
    writeState(dir, [darkEntry('long_gone', 90)], { generatedAt: staleTs });
    const result = computeDarkEvents(dir, Date.now());
    assert.equal(result.totalDark, 0, 'a stale snapshot must not count as currently-dark');
  });

  test('ignores malformed snapshot content', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'promised-event-dark-state.last-run.json'),
      'not json at all'
    );
    const result = computeDarkEvents(dir, Date.now());
    assert.equal(result.totalDark, 0);
  });

  test('sanity-assert: dark_types exceeding candidate_count fails closed to silence', () => {
    const { computeDarkEvents } = require(SCRIPT);
    const dir = makeDir();
    // Impossible state: more dark types than the corpus they were drawn from.
    writeState(dir, [darkEntry('a', 10), darkEntry('b', 10)], { candidateCount: 1 });
    const result = computeDarkEvents(dir, Date.now());
    assert.equal(result.totalDark, 0, 'an implausible count must be silenced, not printed');
    assert.deepEqual(result.darkTypes, []);
  });
});

// ── SessionStart banner ─────────────────────────────────────────────────────

describe('dark-event-banner: SessionStart advisory', () => {
  test('prints banner to stderr naming worst offenders when dark types exist', () => {
    const dir = makeDir();
    writeState(dir, [darkEntry('custom_agents_collision', 71), darkEntry('oversized_refused_cap', 14)]);
    const result = runHook(dir, {}, freshSessionId());
    assert.equal(result.status, 0);
    assert.ok(result.stderr.includes('never fired'), 'banner must appear on stderr');
    assert.ok(result.stderr.includes('custom_agents_collision'), 'worst offender must be named');
    assert.ok(result.stderr.includes('/orchestray:doctor'), 'banner must point to doctor for the full list');
  });

  test('no banner when no dark types are present', () => {
    const dir = makeDir();
    writeState(dir, []);
    const result = runHook(dir, {}, freshSessionId());
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes('never fired'), 'silent when nothing dark');
  });

  test('no banner when the snapshot has never been written', () => {
    const dir = makeDir();
    const result = runHook(dir, {}, freshSessionId());
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes('never fired'), 'silent before any orchestration has completed');
  });

  test('caps the named list to 3 even when more types are dark', () => {
    const dir = makeDir();
    writeState(dir, [
      darkEntry('type_a', 40), darkEntry('type_b', 30), darkEntry('type_c', 20),
      darkEntry('type_d', 10), darkEntry('type_e', 9),
    ]);
    const result = runHook(dir, {}, freshSessionId());
    assert.ok(result.stderr.includes('5 declared event type'), 'total count must reflect all dark types');
    assert.ok(!result.stderr.includes('type_e'), 'named list must be capped, not enumerate every type');
  });

  test('ORCHESTRAY_DARK_EVENT_BANNER_DISABLED=1 suppresses the banner', () => {
    const dir = makeDir();
    writeState(dir, [darkEntry('some_type', 20)]);
    const result = runHook(dir, { ORCHESTRAY_DARK_EVENT_BANNER_DISABLED: '1' }, freshSessionId());
    assert.equal(result.status, 0);
    assert.ok(!result.stderr.includes('never fired'), 'kill switch must suppress banner');
  });

  test('session-scoped: same session_id only banners once', () => {
    const dir = makeDir();
    writeState(dir, [darkEntry('repeat_type', 20)]);
    const sessionId = freshSessionId();
    const first  = runHook(dir, {}, sessionId);
    const second = runHook(dir, {}, sessionId);
    assert.ok(first.stderr.includes('never fired'), 'first run in session must banner');
    assert.ok(!second.stderr.includes('never fired'), 'second run in same session must stay silent');
  });
});

// ── doctor --json surface ───────────────────────────────────────────────────

describe('dark-event-banner: --json CLI mode', () => {
  test('emits structured JSON on stdout for doctor to parse', () => {
    const dir = makeDir();
    writeState(dir, [darkEntry('json_probe_type', 15)]);
    const result = runJson(dir);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.totalDark, 1);
    assert.equal(parsed.darkTypes[0].event_type, 'json_probe_type');
    assert.equal(parsed.darkTypes[0].days_dark, 15);
  });

  test('--json mode does not write the session banner to stderr', () => {
    const dir = makeDir();
    writeState(dir, [darkEntry('json_probe_type2', 15)]);
    const result = runJson(dir);
    assert.ok(!result.stderr.includes('never fired'), '--json mode is a data surface, not the advisory');
  });
});
