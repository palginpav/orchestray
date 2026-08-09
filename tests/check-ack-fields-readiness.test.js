#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/check-ack-fields-readiness.js
 *
 * Covers the mechanical evaluator (evaluate/CLI) and the auto-flip
 * (maybeAutoFlip) that replaces the prose "run this shell command by hand"
 * comment in bin/validate-task-completion.js. See that file's
 * patternAckFieldsEnforced docstring for the condition this mirrors.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/check-ack-fields-readiness.js');
const SESSION_GATE_SCRIPT = path.resolve(__dirname, '../bin/session-feature-gate.js');
const {
  REQUIRED_WINDOW,
  REQUIRED_SHARE,
  evaluate,
  maybeAutoFlip,
} = require(SCRIPT);

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-ack-readiness-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ackEvent(i, ackSource) {
  return {
    version: 1,
    type: 'pattern_ack_captured',
    timestamp: new Date(Date.now() - (1000 - i) * 1000).toISOString(),
    spawn_id: `spawn-${i}`,
    agent_role: 'developer',
    used_slugs: ['some-pattern'],
    rejected_slugs: [],
    offered_count: 1,
    coverage_complete: true,
    agent_status: 'success',
    ack_source: ackSource,
  };
}

/** Write `count` pattern_ack_captured events, `structuredCount` of them structured_fields. */
function writeAckEvents(count, structuredCount) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const source = i < structuredCount ? 'structured_fields' : 'legacy_text_scan';
    lines.push(JSON.stringify(ackEvent(i, source)));
  }
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
    lines.join('\n') + (lines.length ? '\n' : ''),
    'utf8'
  );
}

function writeConfig(patternEvidence) {
  const cfg = patternEvidence ? { pattern_evidence: patternEvidence } : {};
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'config.json'),
    JSON.stringify(cfg, null, 2),
    'utf8'
  );
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.orchestray', 'config.json'), 'utf8'));
}

function readEvents() {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function runCli(args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--cwd', tmpDir, ...args], { encoding: 'utf8' });
}

/** Captures process.stderr.write output for the duration of `fn`. */
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  try {
    const result = fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

// ---------------------------------------------------------------------------

describe('check-ack-fields-readiness — evaluate()', () => {

  test('missing log: reports 0/required, not ready, exit 1', () => {
    // No events.jsonl written at all.
    const measured = evaluate(tmpDir);
    assert.equal(measured.total, 0);
    assert.equal(measured.required, REQUIRED_WINDOW);
    assert.equal(measured.ready, false);

    const cli = runCli(['--json']);
    assert.equal(cli.status, 1, `expected exit 1; got ${cli.status}: ${cli.stderr}`);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.total, 0);
    assert.equal(parsed.ready, false);
  });

  test('empty log file: same as missing — not ready', () => {
    fs.writeFileSync(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');
    const measured = evaluate(tmpDir);
    assert.equal(measured.total, 0);
    assert.equal(measured.ready, false);
  });

  test('below threshold: 8/50 events, condition cannot be evaluated yet', () => {
    writeAckEvents(8, 8); // matches the live-log snapshot referenced in the task
    const measured = evaluate(tmpDir);
    assert.equal(measured.total, 8);
    assert.equal(measured.required, 50);
    assert.equal(measured.ready, false, 'fewer than 50 events must never be ready, regardless of share');

    const cli = runCli(['--json']);
    assert.equal(cli.status, 1);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.total, 8);
    assert.equal(parsed.ready, false);
  });

  test('at threshold and passing: 50 events, 48 structured (96% >= 95%) — ready', () => {
    writeAckEvents(50, 48);
    const measured = evaluate(tmpDir);
    assert.equal(measured.total, 50);
    assert.equal(measured.structured, 48);
    assert.ok(measured.share >= REQUIRED_SHARE);
    assert.equal(measured.ready, true);

    const cli = runCli(['--json']);
    assert.equal(cli.status, 0, `expected exit 0; got ${cli.status}: ${cli.stderr}`);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.ready, true);
  });

  test('at threshold and failing: 50 events, 40 structured (80% < 95%) — not ready', () => {
    writeAckEvents(50, 40);
    const measured = evaluate(tmpDir);
    assert.equal(measured.total, 50);
    assert.equal(measured.structured, 40);
    assert.ok(measured.share < REQUIRED_SHARE);
    assert.equal(measured.ready, false);

    const cli = runCli(['--json']);
    assert.equal(cli.status, 1);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.ready, false);
  });

  test('window caps at the most recent 50 — an old low-share tail does not drag down a passing recent window', () => {
    // 100 legacy events first (0% structured), then 50 recent structured events (100%).
    const oldLines = [];
    for (let i = 0; i < 100; i++) oldLines.push(JSON.stringify(ackEvent(i, 'legacy_text_scan')));
    const recentLines = [];
    for (let i = 0; i < 50; i++) recentLines.push(JSON.stringify(ackEvent(1000 + i, 'structured_fields')));
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      oldLines.concat(recentLines).join('\n') + '\n',
      'utf8'
    );
    const measured = evaluate(tmpDir);
    assert.equal(measured.total, 50, 'only the most recent 50 are measured');
    assert.equal(measured.structured, 50);
    assert.equal(measured.ready, true);
  });

});

describe('check-ack-fields-readiness — maybeAutoFlip()', () => {

  test('not ready: does not flip, does not write config or sentinel', () => {
    writeAckEvents(8, 8);
    writeConfig(null);
    const r = maybeAutoFlip(tmpDir);
    assert.equal(r.flipped, false);
    assert.equal(r.reason, 'not_ready');
    const cfg = readConfig();
    assert.notEqual(cfg.pattern_evidence && cfg.pattern_evidence.enforce_ack_fields, true);
  });

  test('ready: flips config, emits banner, writes sentinel, records audit event', () => {
    writeAckEvents(50, 49); // 98%
    writeConfig(null);

    const { result, stderr } = captureStderr(() => maybeAutoFlip(tmpDir));
    assert.equal(result.flipped, true, `expected flip; got reason=${result.reason}`);

    const cfg = readConfig();
    assert.equal(cfg.pattern_evidence.enforce_ack_fields, true, 'config flipped to true');

    assert.match(stderr, /enforce_ack_fields flipped from false to true/, 'one-time banner emitted on stderr');

    const sentinelPath = path.join(tmpDir, '.orchestray', 'state', '.ack-fields-autoflip-done');
    assert.ok(fs.existsSync(sentinelPath), 'sentinel written');

    const events = readEvents();
    const flipEvent = events.find((e) => e.type === 'pattern_ack_fields_autoflip');
    assert.ok(flipEvent, 'pattern_ack_fields_autoflip audit event recorded');
    assert.equal(flipEvent.previous_value, false);
    assert.equal(flipEvent.new_value, true);
    assert.equal(flipEvent.measured_count, 50);
  });

  test('banner fires exactly once: a second call is a no-op even after the config is reverted', () => {
    writeAckEvents(50, 49);
    writeConfig(null);

    const first = captureStderr(() => maybeAutoFlip(tmpDir));
    assert.equal(first.result.flipped, true);

    // Simulate a user manually reverting the flip — the sentinel must still
    // suppress re-flipping and re-bannering (time-bounded ramp, not a fight
    // with an explicit override).
    const cfg = readConfig();
    cfg.pattern_evidence.enforce_ack_fields = false;
    fs.writeFileSync(path.join(tmpDir, '.orchestray', 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

    const second = captureStderr(() => maybeAutoFlip(tmpDir));
    assert.equal(second.result.flipped, false);
    assert.equal(second.result.reason, 'sentinel_present');
    assert.equal(second.stderr, '', 'no banner on second call');

    const cfgAfter = readConfig();
    assert.equal(cfgAfter.pattern_evidence.enforce_ack_fields, false, 'sentinel does not fight the manual revert');
  });

  test('already enforced: no-op, does not require the sentinel to exist', () => {
    writeAckEvents(50, 49);
    writeConfig({ enforce_ack_fields: true });
    const r = maybeAutoFlip(tmpDir);
    assert.equal(r.flipped, false);
    assert.equal(r.reason, 'already_enforced');
  });

  test('kill switch via config: pattern_evidence.ack_fields_autoflip_enabled=false suppresses the flip', () => {
    writeAckEvents(50, 49);
    writeConfig({ ack_fields_autoflip_enabled: false });

    const { result, stderr } = captureStderr(() => maybeAutoFlip(tmpDir));
    assert.equal(result.flipped, false);
    assert.equal(result.reason, 'kill_switch');
    assert.equal(stderr, '');

    const cfg = readConfig();
    assert.notEqual(cfg.pattern_evidence.enforce_ack_fields, true, 'config left untouched');
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.orchestray', 'state', '.ack-fields-autoflip-done')),
      false,
      'no sentinel written when the kill switch suppressed the flip'
    );
  });

  test('kill switch via env var: ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED=1 suppresses the flip', () => {
    writeAckEvents(50, 49);
    writeConfig(null);

    const prev = process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED;
    process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED = '1';
    try {
      const r = maybeAutoFlip(tmpDir);
      assert.equal(r.flipped, false);
      assert.equal(r.reason, 'kill_switch');
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED;
      else process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED = prev;
    }
  });

});

describe('check-ack-fields-readiness — wired into session-feature-gate.js SessionStart hook', () => {

  test('not ready: session-feature-gate.js surfaces the progress line without failing the session', () => {
    writeAckEvents(8, 8);
    writeConfig(null);

    const result = spawnSync(process.execPath, [SESSION_GATE_SCRIPT, '--cwd', tmpDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, `session-feature-gate.js must never fail the session: ${result.stderr}`);
    assert.match(result.stderr, /ack-fields readiness: 8\/50/, 'progress line surfaced on stderr');

    const cfg = readConfig();
    assert.notEqual(cfg.pattern_evidence && cfg.pattern_evidence.enforce_ack_fields, true);
  });

  test('ready: session-feature-gate.js performs the flip end-to-end', () => {
    writeAckEvents(50, 49);
    writeConfig(null);

    const result = spawnSync(process.execPath, [SESSION_GATE_SCRIPT, '--cwd', tmpDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, `session-feature-gate.js must never fail the session: ${result.stderr}`);
    assert.match(result.stderr, /enforce_ack_fields flipped from false to true/, 'flip banner surfaced');

    const cfg = readConfig();
    assert.equal(cfg.pattern_evidence.enforce_ack_fields, true);
  });

  test('--dry-run does not trigger the ack-fields flip', () => {
    writeAckEvents(50, 49);
    writeConfig(null);

    const result = spawnSync(process.execPath, [SESSION_GATE_SCRIPT, '--cwd', tmpDir, '--dry-run'], { encoding: 'utf8' });
    assert.equal(result.status, 0);

    const cfg = readConfig();
    assert.notEqual(cfg.pattern_evidence && cfg.pattern_evidence.enforce_ack_fields, true, 'dry-run must not mutate config');
  });

});
