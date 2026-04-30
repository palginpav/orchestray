'use strict';

/**
 * Test v2.2.8 Item 1: Mechanical housekeeper delegation.
 *
 * Tests spawn-housekeeper-on-trigger.js (PostToolUse) and
 * inject-housekeeper-pending.js (PreToolUse:Agent) in isolation.
 *
 * Scenarios covered:
 *   1. KB write → sentinel written with trigger_type:'kb_write'.
 *   2. Edit on event-schemas.md → sentinel written with trigger_type:'schema_edit'.
 *   3. Edit on a non-schema file → no sentinel written.
 *   4. Kill switch ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER=1 → no sentinel.
 *   5. Config kill switch housekeeping.auto_delegate.enabled:false → no sentinel.
 *   6. Debounce: second KB write within 60s window → sentinel NOT overwritten
 *      (same ts preserved).
 *   7. inject-housekeeper-pending: no sentinel present → passthrough.
 *   8. inject-housekeeper-pending: sentinel present + non-housekeeper spawn →
 *      prompt prepended with pending note, sentinel cleared.
 *   9. inject-housekeeper-pending: sentinel present + housekeeper spawn →
 *      sentinel cleared, prompt unchanged.
 *  10. inject-housekeeper-pending: corrupted sentinel → sentinel cleared,
 *      passthrough (fail-open).
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const TRIGGER_SCRIPT = path.join(__dirname, '../../../bin/spawn-housekeeper-on-trigger.js');
const INJECT_SCRIPT  = path.join(__dirname, '../../../bin/inject-housekeeper-pending.js');
const SENTINEL_REL   = path.join('.orchestray', 'state', 'housekeeper-pending.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v228-hk-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function scaffoldProject(dir, { config } = {}) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  // Write current-orchestration.json
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({
      orchestration_id: 'orch-test-hk-v228',
      task_summary:     'test',
      started_at:       '2026-04-28T12:00:00Z',
      phase:            'execute',
    }),
    'utf8'
  );

  // Write config.json (optional override)
  const cfg = config !== undefined ? config : { version: '2.2.8' };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8'
  );

  return { stateDir, auditDir };
}

function sentinelPath(dir) {
  return path.join(dir, SENTINEL_REL);
}

function runTriggerScript(dir, payload, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  return spawnSync(process.execPath, [TRIGGER_SCRIPT], {
    input:   JSON.stringify(payload),
    cwd:     dir,
    env,
    encoding: 'utf8',
    timeout:  10000,
  });
}

function runInjectScript(dir, payload, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  return spawnSync(process.execPath, [INJECT_SCRIPT], {
    input:   JSON.stringify(payload),
    cwd:     dir,
    env,
    encoding: 'utf8',
    timeout:  10000,
  });
}

function makeKbWritePayload(dir) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name:       'mcp__orchestray__kb_write',
    tool_input:      { path: 'facts/test.md', content: 'hello' },
    tool_response:   '{}',
    cwd:             dir,
  };
}

function makeEditPayload(dir, filePath) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name:       'Edit',
    tool_input:      { file_path: filePath, old_string: 'x', new_string: 'y' },
    tool_response:   '{}',
    cwd:             dir,
  };
}

function makeAgentSpawnPayload(dir, subagentType, prompt) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name:       'Agent',
    tool_input:      {
      subagent_type: subagentType,
      prompt:        prompt || 'do the task',
    },
    cwd: dir,
  };
}

// ---------------------------------------------------------------------------
// spawn-housekeeper-on-trigger.js tests
// ---------------------------------------------------------------------------

test('trigger: KB write → sentinel written with trigger_type kb_write', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const result = runTriggerScript(dir, makeKbWritePayload(dir));
  assert.equal(result.status, 0, `exit code: ${result.status}\nstderr: ${result.stderr}`);

  const sp = sentinelPath(dir);
  assert.ok(fs.existsSync(sp), 'sentinel file should exist');

  const sentinel = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(sentinel.trigger_type, 'kb_write');
  assert.equal(sentinel.orchestration_id, 'orch-test-hk-v228');
  assert.ok(typeof sentinel.ts === 'string', 'ts should be a string');
});

test('trigger: Edit on event-schemas.md → sentinel with trigger_type schema_edit', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);
  const schemaPath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(schemaPath, '# schemas', 'utf8');

  const result = runTriggerScript(dir, makeEditPayload(dir, schemaPath));
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const sp = sentinelPath(dir);
  assert.ok(fs.existsSync(sp), 'sentinel file should exist');

  const sentinel = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(sentinel.trigger_type, 'schema_edit');
});

test('trigger: Edit on non-schema file → no sentinel', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);
  const nonSchemaPath = path.join(dir, 'agents', 'pm.md');
  fs.mkdirSync(path.dirname(nonSchemaPath), { recursive: true });
  fs.writeFileSync(nonSchemaPath, '# pm', 'utf8');

  runTriggerScript(dir, makeEditPayload(dir, nonSchemaPath));

  assert.ok(!fs.existsSync(sentinelPath(dir)), 'sentinel should NOT exist for non-schema edit');
});

test('trigger: env kill switch ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER=1 → no sentinel', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  runTriggerScript(dir, makeKbWritePayload(dir), {
    ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER: '1',
  });

  assert.ok(!fs.existsSync(sentinelPath(dir)), 'sentinel should NOT exist when kill switch set');
});

test('trigger: config kill switch housekeeping.auto_delegate.enabled:false → no sentinel', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir, {
    config: {
      version:      '2.2.8',
      housekeeping: { auto_delegate: { enabled: false } },
    },
  });

  runTriggerScript(dir, makeKbWritePayload(dir));

  assert.ok(!fs.existsSync(sentinelPath(dir)), 'sentinel should NOT exist when config disabled');
});

test('trigger: debounce — second KB write within window does not overwrite sentinel', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  // First write
  runTriggerScript(dir, makeKbWritePayload(dir));
  const sp = sentinelPath(dir);
  assert.ok(fs.existsSync(sp), 'sentinel should exist after first write');

  const firstSentinel = JSON.parse(fs.readFileSync(sp, 'utf8'));

  // Second write immediately (within 60s window)
  runTriggerScript(dir, makeKbWritePayload(dir));

  const secondSentinel = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(firstSentinel.ts, secondSentinel.ts, 'ts should be unchanged (debounce)');
});

test('trigger: always exits 0 (fail-open) on invalid JSON input', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const result = spawnSync(process.execPath, [TRIGGER_SCRIPT], {
    input:   'NOT JSON {{{',
    cwd:     dir,
    encoding: 'utf8',
    timeout:  10000,
  });
  assert.equal(result.status, 0, 'should exit 0 even on invalid JSON');
  assert.ok(!fs.existsSync(sentinelPath(dir)), 'no sentinel on invalid JSON');
});

// ---------------------------------------------------------------------------
// inject-housekeeper-pending.js tests
// ---------------------------------------------------------------------------

test('inject: no sentinel present → passthrough (continue: true, no updatedInput)', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const result = runInjectScript(dir, makeAgentSpawnPayload(dir, 'developer', 'build it'));
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const out = JSON.parse(result.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput || !out.hookSpecificOutput.updatedInput,
    'no updatedInput when no sentinel');
});

// v2.2.9 B-1.1 superseded the inject-housekeeper-pending.js prose-nudge
// mechanism with mechanical spawn-queue insertion in
// spawn-housekeeper-on-trigger.js. The original v2.2.8 inject path is
// covered by bin/__tests__/v229-housekeeper-auto-spawn.test.js.
// v2.2.17 deletes the empty test.skip(...) stubs that were placeholders for
// the now-removed v2.2.8 contract.

test('inject: corrupted sentinel → cleared, passthrough (fail-open)', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const sp = sentinelPath(dir);
  fs.writeFileSync(sp, 'NOT VALID JSON', 'utf8');

  const result = runInjectScript(dir, makeAgentSpawnPayload(dir, 'developer', 'build it'));
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const out = JSON.parse(result.stdout);
  assert.equal(out.continue, true);
  // No updatedInput when sentinel is corrupted.
  const updatedInput = out.hookSpecificOutput && out.hookSpecificOutput.updatedInput;
  assert.ok(!updatedInput, 'no prompt mutation on corrupted sentinel');
});

test('inject: kill switch ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER=1 → passthrough even with sentinel', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const sp = sentinelPath(dir);
  fs.writeFileSync(sp, JSON.stringify({
    trigger_type:     'kb_write',
    source_file:      '',
    orchestration_id: null,
    ts:               new Date().toISOString(),
  }), 'utf8');

  const result = runInjectScript(
    dir,
    makeAgentSpawnPayload(dir, 'developer', 'build it'),
    { ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER: '1' }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const out = JSON.parse(result.stdout);
  assert.equal(out.continue, true);
  const updatedInput = out.hookSpecificOutput && out.hookSpecificOutput.updatedInput;
  assert.ok(!updatedInput, 'no prompt mutation when kill switch active');

  // Sentinel is NOT cleared when kill switch is active (hook exits before reading it).
  assert.ok(fs.existsSync(sp), 'sentinel preserved when kill switch prevents drain');
});
