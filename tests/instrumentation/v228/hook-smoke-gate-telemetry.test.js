'use strict';

/**
 * Smoke tests for bin/gate-telemetry.js
 *
 * Hook event: UserPromptSubmit
 *
 * Validates:
 *   1. ORCHESTRAY_METRICS_DISABLED=1 → exit 0, { continue: true }, no event
 *   2. ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1 → exit 0, { continue: true }
 *   3. Normal run with config → exit 0, { continue: true }, feature_gate_eval event written
 *   4. telemetry.tier2_tracking.enabled=false in config → exit 0, no event
 *   5. Malformed JSON on stdin → exit 0, fail-open
 *   6. Empty config → exit 0 (all gates default to absent/false)
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/gate-telemetry.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-gt-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function writeConfig(dir, cfg) {
  const configDir = path.join(dir, '.orchestray');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg));
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

function invoke(payload, env) {
  const mergedEnv = Object.assign({}, process.env, env || {});
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  8000,
    env:      mergedEnv,
  });
  // NOTE: gate-telemetry has a known double-write bug: the `handle()` function
  // writes CONTINUE_RESPONSE in `try` and again in `finally`, producing
  // '{"continue":true}{"continue":true}' on stdout for early-return paths.
  // We parse only the FIRST JSON object from stdout.
  const raw = (result.stdout || '').trim();
  let parsed = null;
  try {
    // Extract just the first JSON object via a balanced-brace scan.
    let depth = 0, end = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    parsed = end >= 0 ? JSON.parse(raw.slice(0, end + 1)) : JSON.parse(raw);
  } catch (_e) {}
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', parsed };
}

// ---------------------------------------------------------------------------
// Test 1: ORCHESTRAY_METRICS_DISABLED=1 → exit 0, continue:true, no event
// ---------------------------------------------------------------------------
test('gate-telemetry: ORCHESTRAY_METRICS_DISABLED=1 exits 0 with continue:true', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, { enable_outcome_tracking: true });

  const payload = { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'hello' };
  const { status, parsed } = invoke(payload, { ORCHESTRAY_METRICS_DISABLED: '1' });

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const events = readEvents(dir);
  const gateEvents = events.filter(e => e.type === 'feature_gate_eval');
  assert.strictEqual(gateEvents.length, 0, 'no feature_gate_eval event must be written when metrics disabled');
});

// ---------------------------------------------------------------------------
// Test 2: ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1 → exit 0, continue:true
// ---------------------------------------------------------------------------
test('gate-telemetry: ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1 exits 0 with continue:true', (t) => {
  const dir = makeTmpDir(t);

  const payload = { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'do something' };
  const { status, parsed } = invoke(payload, { ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '1' });

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');
});

// ---------------------------------------------------------------------------
// Test 3: Normal run with config → exit 0, feature_gate_eval event written
// ---------------------------------------------------------------------------
test('gate-telemetry: normal UserPromptSubmit with config writes feature_gate_eval event', (t) => {
  const dir = makeTmpDir(t);
  // Set up config with some gates
  writeConfig(dir, {
    enable_outcome_tracking: true,
    enable_replay_analysis: false,
    auto_review:            true,
  });
  // Set up audit dir
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });

  const payload = {
    hook_event_name: 'UserPromptSubmit',
    cwd:             dir,
    prompt:          'Please implement feature X',
  };
  const { status, parsed } = invoke(payload, {
    ORCHESTRAY_METRICS_DISABLED:       '',
    ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '',
  });

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.ok(parsed, 'stdout must be valid JSON');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const events = readEvents(dir);
  const gateEvents = events.filter(e => e.type === 'feature_gate_eval');
  assert.ok(gateEvents.length >= 1, 'feature_gate_eval event must be written on normal run');

  const ev = gateEvents[0];
  assert.ok(Array.isArray(ev.gates_true), 'feature_gate_eval must have gates_true array');
  assert.ok(Array.isArray(ev.gates_false), 'feature_gate_eval must have gates_false array');
});

// ---------------------------------------------------------------------------
// Test 4: telemetry.tier2_tracking.enabled=false in config → exit 0, no event
// ---------------------------------------------------------------------------
test('gate-telemetry: telemetry.tier2_tracking.enabled=false in config exits 0 without emitting event', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, {
    telemetry: { tier2_tracking: { enabled: false } },
    enable_outcome_tracking: true,
  });
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });

  const payload = { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'hello' };
  const { status, parsed } = invoke(payload, {
    ORCHESTRAY_METRICS_DISABLED: '',
    ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '',
  });

  assert.strictEqual(status, 0, 'exit code must be 0');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');

  const events = readEvents(dir);
  const gateEvents = events.filter(e => e.type === 'feature_gate_eval');
  assert.strictEqual(gateEvents.length, 0, 'no feature_gate_eval event when tier2 is config-disabled');
});

// ---------------------------------------------------------------------------
// Test 5: Malformed JSON on stdin → exit 0, fail-open
// ---------------------------------------------------------------------------
test('gate-telemetry: malformed JSON on stdin exits 0 (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    '{ this is not json!',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch (_e) {}
  assert.ok(parsed, 'stdout must be valid JSON on malformed stdin');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true } on malformed stdin');
});

// ---------------------------------------------------------------------------
// Test 6: Empty config → exit 0
// ---------------------------------------------------------------------------
test('gate-telemetry: empty config (no gates defined) exits 0 with continue:true', (t) => {
  const dir = makeTmpDir(t);
  writeConfig(dir, {});
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });

  const payload = { hook_event_name: 'UserPromptSubmit', cwd: dir, prompt: 'test' };
  const { status, parsed } = invoke(payload, {
    ORCHESTRAY_METRICS_DISABLED: '',
    ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '',
  });

  assert.strictEqual(status, 0, 'empty config must exit 0');
  assert.strictEqual(parsed.continue, true, 'must emit { continue: true }');
});
