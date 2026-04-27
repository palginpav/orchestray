#!/usr/bin/env node
'use strict';

/**
 * v223-p2-scout-decision.test.js — Phase 2 W1 scout_decision telemetry.
 *
 * Verifies bin/track-scout-decision.js (PreToolUse:Read hook):
 *   1. Fires `scout_decision` on Read of file >= scout_min_bytes.
 *   2. Silent on small file Reads (< threshold).
 *   3. Handles missing file gracefully (no event, exit 0).
 *   4. Honors config override of scout_min_bytes.
 *   5. Handles malformed stdin.
 *   6. Honors env kill switches and config gates.
 *   7. Schema entry present in shadow + tier2-index after regen.
 *   8. Hook registered in hooks.json under PreToolUse:Read matcher chain.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'track-scout-decision.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const SHADOW     = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const TIER2_IDX  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.tier2-index.json');
const NODE       = process.execPath;

// ---------------------------------------------------------------------------
// Test root scaffolding
// ---------------------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-scout-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

function writeOrchMarker(root, orchId) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function writeConfig(root, cfg) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify(cfg || {}),
    'utf8'
  );
}

function writeFileSized(root, relPath, bytes) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'a'.repeat(bytes), 'utf8');
  return abs;
}

function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: payload === '__RAW__' ? opts.raw : JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return r;
}

function readEvents(root) {
  const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 1. Fires on Read of file >= scout_min_bytes
// ---------------------------------------------------------------------------

describe('track-scout-decision — fires above threshold', () => {

  test('Read of 12288-byte file emits scout_decision (boundary inclusive)', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-1');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const abs = writeFileSized(root, 'big.md', 12288);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0, 'hook must exit 0');
    assert.equal(r.stdout.trim(), '{"continue":true}');

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1, 'one scout_decision event');
    const ev = evs[0];
    assert.equal(ev.version, 1);
    assert.equal(ev.decision, 'inline_read_observed');
    assert.equal(ev.file_bytes, 12288);
    assert.equal(ev.scout_min_bytes, 12288);
    assert.equal(ev.caller_role, 'pm', 'defaults to pm when payload omits agent_type');
    assert.equal(ev.orchestration_id, 'orch-scout-test-1');
    assert.equal(ev.file_path, 'big.md');
    assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0);
  });

  test('Read of 30000-byte file emits scout_decision', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-2');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const abs = writeFileSized(root, 'huge.md', 30000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].file_bytes, 30000);
  });

  test('caller_role honors agent_type from payload envelope', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-3');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
      agent_type: 'reviewer',
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].caller_role, 'reviewer');
  });

});

// ---------------------------------------------------------------------------
// 2. Silent below threshold
// ---------------------------------------------------------------------------

describe('track-scout-decision — silent below threshold', () => {

  test('Read of 12287-byte file emits NO event (one byte below)', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-4');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const abs = writeFileSized(root, 'small.md', 12287);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{"continue":true}');

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0, 'no event below threshold');
  });

  test('Read of 1KB file emits no event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-5');
    writeConfig(root, {});
    const abs = writeFileSized(root, 'tiny.md', 1024);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

});

// ---------------------------------------------------------------------------
// 3. Missing file
// ---------------------------------------------------------------------------

describe('track-scout-decision — missing file', () => {

  test('Read of nonexistent file exits 0 with no event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-6');
    writeConfig(root, {});

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: path.join(root, 'does-not-exist.md') },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{"continue":true}');

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

  test('empty file_path exits 0 with no event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-7');
    writeConfig(root, {});

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: '' },
    });
    assert.equal(r.status, 0);
    assert.equal(readEvents(root).filter((e) => e.type === 'scout_decision').length, 0);
  });

});

// ---------------------------------------------------------------------------
// 4. Config override
// ---------------------------------------------------------------------------

describe('track-scout-decision — config override', () => {

  test('custom scout_min_bytes=4096 fires for 5000-byte file', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-8');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 4096 } });
    const abs = writeFileSized(root, 'mid.md', 5000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].scout_min_bytes, 4096);
    assert.equal(evs[0].file_bytes, 5000);
  });

  test('default 12288 when config block missing', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-9');
    writeConfig(root, {});
    const abs = writeFileSized(root, 'big.md', 15000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].scout_min_bytes, 12288);
  });

  test('invalid scout_min_bytes (string) falls back to default 12288', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-10');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 'nope' } });
    const abs = writeFileSized(root, 'big.md', 15000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].scout_min_bytes, 12288);
  });

});

// ---------------------------------------------------------------------------
// 5. Malformed stdin
// ---------------------------------------------------------------------------

describe('track-scout-decision — malformed stdin', () => {

  test('garbage stdin exits 0', () => {
    const r = runHook('__RAW__', { raw: 'this-is-not-json{{{' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{"continue":true}');
  });

  test('empty stdin exits 0', () => {
    const r = runHook('__RAW__', { raw: '' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{"continue":true}');
  });

  test('payload without tool_input exits 0 with no event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-11');
    writeConfig(root, {});

    const r = runHook({ tool_name: 'Read', cwd: root });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

});

// ---------------------------------------------------------------------------
// 6. Kill switches
// ---------------------------------------------------------------------------

describe('track-scout-decision — kill switches', () => {

  test('ORCHESTRAY_DISABLE_SCOUT_TELEMETRY=1 suppresses event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-12');
    writeConfig(root, {});
    const abs = writeFileSized(root, 'big.md', 20000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    }, { env: { ORCHESTRAY_DISABLE_SCOUT_TELEMETRY: '1' } });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

  test('ORCHESTRAY_METRICS_DISABLED=1 suppresses event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-13');
    writeConfig(root, {});
    const abs = writeFileSized(root, 'big.md', 20000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    }, { env: { ORCHESTRAY_METRICS_DISABLED: '1' } });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

  test('haiku_routing.enabled=false suppresses event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-14');
    writeConfig(root, { haiku_routing: { enabled: false } });
    const abs = writeFileSized(root, 'big.md', 20000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

  test('haiku_routing.scout_telemetry_enabled=false suppresses event', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-15');
    writeConfig(root, { haiku_routing: { scout_telemetry_enabled: false } });
    const abs = writeFileSized(root, 'big.md', 20000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 0);
  });

});

// ---------------------------------------------------------------------------
// 7. Schema-shadow + tier2-index entries
// ---------------------------------------------------------------------------

describe('track-scout-decision — schema entries', () => {

  test('event-schemas.shadow.json contains scout_decision', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW, 'utf8'));
    assert.ok(shadow.scout_decision, 'scout_decision must exist in shadow');
    assert.equal(shadow.scout_decision.v, 1, 'version === 1');
  });

  test('event-schemas.tier2-index.json contains scout_decision', () => {
    const idx = JSON.parse(fs.readFileSync(TIER2_IDX, 'utf8'));
    // tier2-index nests entries under .events
    const entries = idx.events || idx;
    assert.ok(entries.scout_decision, 'scout_decision must exist in tier2-index');
  });

  test('shadow event_count >= 119 (118 baseline + scout_decision)', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW, 'utf8'));
    assert.ok(shadow._meta && shadow._meta.event_count >= 119,
      'event_count >= 119 (got ' + (shadow._meta && shadow._meta.event_count) + ')');
  });

});

// ---------------------------------------------------------------------------
// 8. hooks.json registration
// ---------------------------------------------------------------------------

describe('track-scout-decision — hooks.json registration', () => {

  test('registered under PreToolUse matcher="Read"', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const entries = hooks.hooks.PreToolUse || [];
    const readChain = entries.find((e) => e.matcher === 'Read');
    assert.ok(readChain, 'PreToolUse:Read chain must exist');
    const cmds = readChain.hooks.map((h) => h.command || '');
    const matches = cmds.filter((c) => c.includes('track-scout-decision.js'));
    assert.equal(matches.length, 1,
      'track-scout-decision.js must appear EXACTLY once');
  });

  test('hook entry has 5-second timeout and type=command', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const entries = hooks.hooks.PreToolUse || [];
    const readChain = entries.find((e) => e.matcher === 'Read');
    const entry = readChain.hooks.find((h) => (h.command || '').includes('track-scout-decision.js'));
    assert.ok(entry, 'entry exists');
    assert.equal(entry.timeout, 5);
    assert.equal(entry.type, 'command');
  });

});

// ---------------------------------------------------------------------------
// 9. tool_input.path fallback (v2.2.3 P2 follow-up)
//
// track-scout-decision.js:224 accepts `tool_input.path` as a defensive
// fallback for `tool_input.file_path` (the documented Read input shape).
// Reviewer flagged the fallback as untested. Confirm it works so the
// fallback is exercised by CI before deciding to remove it.
// ---------------------------------------------------------------------------

describe('track-scout-decision — tool_input.path fallback', () => {

  test('tool_input.path (alternate key) is accepted and emits scout_decision', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-path-fallback');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      // No file_path — only `path`. Defensive fallback exercised.
      tool_input: { path: abs },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1, 'fallback path key produces one event');
    assert.equal(evs[0].file_bytes, 13000);
    assert.equal(evs[0].file_path, 'big.md',
      'file_path field carries the relativized path from the fallback key');
  });

  test('file_path takes priority over path when BOTH keys present', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-scout-test-path-priority');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const correct = writeFileSized(root, 'correct.md', 13000);
    const wrong = writeFileSized(root, 'wrong.md', 25000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: correct, path: wrong },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root).filter((e) => e.type === 'scout_decision');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].file_path, 'correct.md',
      'documented file_path key wins over fallback path key');
    assert.equal(evs[0].file_bytes, 13000);
  });

});
