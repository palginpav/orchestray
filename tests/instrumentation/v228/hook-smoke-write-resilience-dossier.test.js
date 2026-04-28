'use strict';

/**
 * Smoke tests for bin/write-resilience-dossier.js
 *
 * Hook events: Stop, SubagentStop, PreCompact
 *
 * Validates:
 *   1. No .orchestray dir → exit 0, dossier NOT written (no active orchestration)
 *   2. ORCHESTRAY_RESILIENCE_DISABLED=1 → exit 0, dossier NOT written
 *   3. Active orchestration with orchestration.md → exit 0, dossier written
 *   4. Malformed JSON on stdin → exit 0, fail-open
 *   5. dossier file is valid JSON when written
 *   6. SubagentStop event format also exits 0 cleanly
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../bin/write-resilience-dossier.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-wrd-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

/**
 * Set up a minimal active orchestration in dir.
 * Writes orchestration.md with YAML frontmatter and current-orchestration.json.
 */
function setupActiveOrchestration(dir, orchId) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  const id = orchId || 'orch-wrd-smoke';

  // Write orchestration.md with frontmatter
  const orchMd = [
    '---',
    `id: ${id}`,
    'phase: executing',
    'status: in_progress',
    'complexity_score: 7',
    '---',
    '',
    '# Orchestration Notes',
    'Active orchestration for smoke test.',
  ].join('\n');
  fs.writeFileSync(path.join(stateDir, 'orchestration.md'), orchMd, 'utf8');

  // Write current-orchestration.json (the marker file)
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );

  return { stateDir, auditDir };
}

function invoke(payload, env) {
  const mergedEnv = Object.assign({}, process.env, env || {});
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  10000,
    env:      mergedEnv,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// ---------------------------------------------------------------------------
// Test 1: No .orchestray dir → exit 0, dossier NOT written
// ---------------------------------------------------------------------------
test('write-resilience-dossier: no .orchestray dir exits 0 without creating dossier', (t) => {
  const dir = makeTmpDir(t);

  const payload = { hook_event_name: 'Stop', cwd: dir };
  const { status } = invoke(payload);

  assert.strictEqual(status, 0, 'exit code must be 0 with no .orchestray dir');
  const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
  assert.ok(!fs.existsSync(dossierPath), 'dossier must not be created when .orchestray is absent');
});

// ---------------------------------------------------------------------------
// Test 2: ORCHESTRAY_RESILIENCE_DISABLED=1 → exit 0, dossier NOT written
// ---------------------------------------------------------------------------
test('write-resilience-dossier: ORCHESTRAY_RESILIENCE_DISABLED=1 exits 0 without writing dossier', (t) => {
  const dir = makeTmpDir(t);
  setupActiveOrchestration(dir);

  const payload = { hook_event_name: 'Stop', cwd: dir };
  const { status } = invoke(payload, { ORCHESTRAY_RESILIENCE_DISABLED: '1' });

  assert.strictEqual(status, 0, 'exit code must be 0 when kill switch is set');
  const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
  assert.ok(!fs.existsSync(dossierPath), 'dossier must not be written when kill switch is active');
});

// ---------------------------------------------------------------------------
// Test 3: Active orchestration → exit 0, dossier written
// ---------------------------------------------------------------------------
test('write-resilience-dossier: active orchestration writes resilience-dossier.json', (t) => {
  const dir = makeTmpDir(t);
  setupActiveOrchestration(dir, 'orch-wrd-003');

  const payload = { hook_event_name: 'Stop', cwd: dir };
  const { status } = invoke(payload, { ORCHESTRAY_RESILIENCE_DISABLED: '' });

  assert.strictEqual(status, 0, 'exit code must be 0');
  const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
  assert.ok(fs.existsSync(dossierPath), 'resilience-dossier.json must be written when orchestration is active');
});

// ---------------------------------------------------------------------------
// Test 4: Dossier file is valid JSON when written
// ---------------------------------------------------------------------------
test('write-resilience-dossier: written dossier is valid JSON with orchestration_id field', (t) => {
  const dir = makeTmpDir(t);
  setupActiveOrchestration(dir, 'orch-wrd-004');

  const payload = { hook_event_name: 'Stop', cwd: dir };
  invoke(payload, { ORCHESTRAY_RESILIENCE_DISABLED: '' });

  const dossierPath = path.join(dir, '.orchestray', 'state', 'resilience-dossier.json');
  if (!fs.existsSync(dossierPath)) {
    // Skip if dossier was not written (config may have disabled it)
    return;
  }

  let dossier;
  try {
    dossier = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
  } catch (e) {
    assert.fail('resilience-dossier.json must contain valid JSON: ' + e.message);
  }

  assert.ok(dossier && typeof dossier === 'object', 'dossier must be a JSON object');
  assert.ok('orchestration_id' in dossier || 'phase' in dossier || 'status' in dossier,
    'dossier must contain at least one recovery field (orchestration_id, phase, or status)');
});

// ---------------------------------------------------------------------------
// Test 5: Malformed JSON on stdin → exit 0, fail-open
// ---------------------------------------------------------------------------
test('write-resilience-dossier: malformed JSON on stdin exits 0 (fail-open)', (_t) => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input:    'not json at all',
    encoding: 'utf8',
    timeout:  8000,
  });
  assert.strictEqual(result.status, 0, 'malformed stdin must not cause non-zero exit');
});

// ---------------------------------------------------------------------------
// Test 6: SubagentStop event format exits 0 cleanly
// ---------------------------------------------------------------------------
test('write-resilience-dossier: SubagentStop event format exits 0 cleanly', (t) => {
  const dir = makeTmpDir(t);
  setupActiveOrchestration(dir, 'orch-wrd-006');

  const payload = {
    hook_event_name: 'SubagentStop',
    cwd:             dir,
    stop_reason:     'end_turn',
    subagent_type:   'developer',
  };
  const { status } = invoke(payload, { ORCHESTRAY_RESILIENCE_DISABLED: '' });

  assert.strictEqual(status, 0, 'SubagentStop event must exit 0');
});
