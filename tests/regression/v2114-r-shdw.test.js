#!/usr/bin/env node
'use strict';

/**
 * v2.1.14 R-SHDW regression tests — event-schema shadow + emit validator.
 *
 * Covers:
 *   1. Generator produces non-empty JSON with _meta.version=1 and ≥ 5 event types.
 *   2. Generator output is ≤ 4096 bytes.
 *   3. Shadow includes the 4 new R-SHDW event types.
 *   4. PostToolUse hook triggers regen when file is event-schemas.md.
 *   5. PostToolUse hook no-ops when file is NOT event-schemas.md.
 *   6. Injection hook injects content when enabled.
 *   7. Injection hook no-ops on ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1.
 *   8. Injection hook no-ops on config kill switch enabled=false.
 *   9. Injection hook no-ops on stale shadow (hash mismatch).
 *   10. Validator blocks (exit 2) a malformed event payload.
 *   11. Validator allows (exit 0) a valid event payload.
 *   12. Three-strike counter writes sentinel after 3 misses in 24h.
 *   13. Source-hash mismatch detected and emits schema_shadow_stale.
 *   14. Config schema accepts event_schema_shadow block.
 *   15. Config schema rejects invalid event_schema_shadow values.
 *   16. Generator clears three-strike sentinel on regeneration.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const REGEN_SCRIPT   = path.resolve(REPO_ROOT, 'bin', 'regen-schema-shadow.js');
const REGEN_HOOK     = path.resolve(REPO_ROOT, 'bin', 'regen-schema-shadow-hook.js');
const INJECT_HOOK    = path.resolve(REPO_ROOT, 'bin', 'inject-schema-shadow.js');
const VALIDATE_HOOK  = path.resolve(REPO_ROOT, 'bin', 'validate-schema-emit.js');
const SHADOW_PATH    = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const SCHEMA_PATH    = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runScript(scriptPath, stdinData, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  const result = spawnSync(process.execPath, [scriptPath], {
    input: stdinData || '{}',
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shdw-test-'));
}

function setupTmpRepo(tmpDir) {
  // Copy event-schemas.md to tmp dir
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  // Ensure state dir exists
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
}

function writeConfig(tmpDir, config) {
  const confDir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(confDir, { recursive: true });
  fs.writeFileSync(path.join(confDir, 'config.json'), JSON.stringify(config));
}

function makeShadowHookPayload(cwd, filePath) {
  return JSON.stringify({ cwd, tool_input: { file_path: filePath } });
}

function makeInjectPayload(cwd) {
  return JSON.stringify({ cwd });
}

function makeValidatePayload(cwd, eventPayload) {
  return JSON.stringify({ cwd, tool_input: eventPayload });
}

function readShadow(dir) {
  const p = path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readEventsJsonl(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('R-SHDW: generator', () => {
  test('1. generator produces valid shadow JSON with _meta.version=1 and ≥5 event types', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    assert.equal(shadow._meta.version, 1, '_meta.version must be 1');
    assert.ok(shadow._meta.source_hash, '_meta.source_hash must be present');
    assert.ok(shadow._meta.generated_at, '_meta.generated_at must be present');
    assert.ok(shadow._meta.shadow_size_bytes > 0, '_meta.shadow_size_bytes must be positive');
    assert.ok(shadow._meta.event_count >= 5, 'event_count must be >= 5, got ' + shadow._meta.event_count);
    const eventTypes = Object.keys(shadow).filter(k => k !== '_meta');
    assert.ok(eventTypes.length >= 5, 'shadow must have >= 5 event types, got ' + eventTypes.length);
  });

  test('2. generator output is ≤ 4096 bytes', () => {
    const stat = fs.statSync(SHADOW_PATH);
    assert.ok(stat.size <= 4096, 'shadow file size ' + stat.size + ' exceeds 4096 bytes');
  });

  test('3. shadow includes the 4 new R-SHDW event types', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    const newTypes = [
      'schema_shadow_hit',
      'schema_shadow_miss',
      'schema_shadow_validation_block',
      'schema_shadow_stale',
    ];
    for (const t of newTypes) {
      assert.ok(t in shadow, 'shadow must include event type "' + t + '"');
    }
  });

  test('16. generator clears three-strike sentinel on regeneration', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      // Create sentinel
      const sentinelPath = path.join(tmpDir, '.orchestray', 'state', '.schema-shadow-disabled');
      fs.writeFileSync(sentinelPath, 'test\n');
      assert.ok(fs.existsSync(sentinelPath), 'sentinel should exist before regen');

      // Run generator
      const result = spawnSync(process.execPath, [REGEN_SCRIPT, '--cwd', tmpDir], {
        encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, 'regen should exit 0: ' + result.stderr);
      assert.ok(!fs.existsSync(sentinelPath), 'sentinel should be cleared after regen');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('R-SHDW: PostToolUse regen hook', () => {
  test('4. hook triggers regen when file is event-schemas.md', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      const shadowBefore = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
      assert.ok(!fs.existsSync(shadowBefore), 'shadow should not exist before hook run');

      const payload = makeShadowHookPayload(tmpDir, path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.md'));
      const result = runScript(REGEN_HOOK, payload);
      assert.equal(result.status, 0, 'hook should exit 0: ' + result.stderr);

      assert.ok(fs.existsSync(shadowBefore), 'shadow should exist after hook run');
      const shadow = JSON.parse(fs.readFileSync(shadowBefore, 'utf8'));
      assert.equal(shadow._meta.version, 1, 'shadow version should be 1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('5. hook no-ops when file is NOT event-schemas.md', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      const shadowPath = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.shadow.json');

      const payload = makeShadowHookPayload(tmpDir, path.join(tmpDir, 'agents', 'pm-reference', 'other-file.md'));
      const result = runScript(REGEN_HOOK, payload);
      assert.equal(result.status, 0, 'hook should exit 0');
      assert.ok(!fs.existsSync(shadowPath), 'shadow should NOT be created for non-event-schemas.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('R-SHDW: inject-schema-shadow hook', () => {
  test('6. injection hook injects content when shadow is present and current', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      // Generate shadow in tmp dir
      spawnSync(process.execPath, [REGEN_SCRIPT, '--cwd', tmpDir], {
        encoding: 'utf8', timeout: 10000,
      });

      const payload = makeInjectPayload(tmpDir);
      const result = runScript(INJECT_HOOK, payload);
      assert.equal(result.status, 0, 'inject hook should exit 0: ' + result.stderr);

      const out = JSON.parse(result.stdout);
      assert.ok(out.hookSpecificOutput, 'should have hookSpecificOutput');
      assert.ok(out.hookSpecificOutput.additionalContext, 'should have additionalContext');
      assert.ok(
        out.hookSpecificOutput.additionalContext.includes('<event-schema-shadow>'),
        'additionalContext should contain <event-schema-shadow> fence'
      );
      assert.ok(
        out.hookSpecificOutput.additionalContext.includes('Schema shadow'),
        'additionalContext should mention Schema shadow'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('7. injection hook no-ops on ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      spawnSync(process.execPath, [REGEN_SCRIPT, '--cwd', tmpDir], {
        encoding: 'utf8', timeout: 10000,
      });

      const payload = makeInjectPayload(tmpDir);
      const result = runScript(INJECT_HOOK, payload, { ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1' });
      assert.equal(result.status, 0, 'should exit 0 on kill switch');
      // Should return continue: true (no injection)
      const out = JSON.parse(result.stdout.trim());
      assert.ok(!out.hookSpecificOutput || !out.hookSpecificOutput.additionalContext,
        'should NOT inject when kill switch is active');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('8. injection hook no-ops on config kill switch enabled=false', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      spawnSync(process.execPath, [REGEN_SCRIPT, '--cwd', tmpDir], {
        encoding: 'utf8', timeout: 10000,
      });
      writeConfig(tmpDir, { event_schema_shadow: { enabled: false } });

      const payload = makeInjectPayload(tmpDir);
      const result = runScript(INJECT_HOOK, payload);
      assert.equal(result.status, 0, 'should exit 0 on config kill switch');
      const out = JSON.parse(result.stdout.trim());
      assert.ok(!out.hookSpecificOutput || !out.hookSpecificOutput.additionalContext,
        'should NOT inject when config.event_schema_shadow.enabled is false');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('9. injection hook no-ops on stale shadow (hash mismatch)', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      // Generate shadow
      spawnSync(process.execPath, [REGEN_SCRIPT, '--cwd', tmpDir], {
        encoding: 'utf8', timeout: 10000,
      });

      // Tamper the shadow to have a wrong source_hash
      const shadowPath = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
      const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
      shadow._meta.source_hash = 'deadbeef'.repeat(8).slice(0, 64);
      fs.writeFileSync(shadowPath, JSON.stringify(shadow));

      const payload = makeInjectPayload(tmpDir);
      const result = runScript(INJECT_HOOK, payload);
      assert.equal(result.status, 0, 'should exit 0 on stale shadow');
      const out = JSON.parse(result.stdout.trim());
      assert.ok(!out.hookSpecificOutput || !out.hookSpecificOutput.additionalContext,
        'should NOT inject when shadow is stale');

      // Should have emitted schema_shadow_stale event
      const events = readEventsJsonl(tmpDir);
      const staleEvents = events.filter(e => e.type === 'schema_shadow_stale');
      assert.ok(staleEvents.length > 0, 'should emit schema_shadow_stale event on hash mismatch');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('R-SHDW: validate-schema-emit validator', () => {
  test('10. validator blocks (exit 2) a malformed event payload', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);

      // Valid event type but missing required field 'timestamp'
      const badPayload = makeValidatePayload(tmpDir, {
        type: 'tier2_load',
        // missing: timestamp, orchestration_id, file_path
      });

      const result = runScript(VALIDATE_HOOK, badPayload);
      // The validator exits 2 on block, but the process.exit(2) may result in
      // status 2 or the hook output may have permissionDecision: 'block'
      const hasBlock = result.status === 2 ||
        (result.stdout.includes('"block"') && result.stdout.includes('permissionDecision'));
      assert.ok(hasBlock,
        'validator should block (exit 2 or permissionDecision:block) for malformed event. Status: ' +
        result.status + ', stdout: ' + result.stdout.slice(0, 200));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('11. validator allows (exit 0) an unknown/non-audit payload (no type field)', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);

      // Payload with no type field — not an audit event, should allow
      const noTypePayload = makeValidatePayload(tmpDir, { foo: 'bar' });

      const result = runScript(VALIDATE_HOOK, noTypePayload);
      assert.equal(result.status, 0, 'validator should exit 0 for non-audit payload');
      assert.ok(
        result.stdout.includes('"allow"'),
        'should return permissionDecision: allow for non-audit payload'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('11b. validator allows valid event payload (schema_shadow_hit)', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);

      // Valid schema_shadow_hit event with all required fields
      const validPayload = makeValidatePayload(tmpDir, {
        type: 'schema_shadow_hit',
        version: 1,
        timestamp: new Date().toISOString(),
        orchestration_id: 'orch-test-123',
        event_type: 'tier2_load',
      });

      const result = runScript(VALIDATE_HOOK, validPayload);
      assert.equal(result.status, 0, 'validator should exit 0 for valid schema_shadow_hit: ' + result.stderr);
      assert.ok(
        result.stdout.includes('"allow"'),
        'should return permissionDecision: allow for valid event'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('R-SHDW: three-strike auto-disable', () => {
  test('12. three-strike counter writes sentinel after 3 misses in 24h', () => {
    const tmpDir = makeTmpDir();
    try {
      const { recordMiss } = require(path.resolve(REPO_ROOT, 'bin', '_lib', 'load-schema-shadow.js'));
      const fakeHash = crypto.randomBytes(32).toString('hex');
      const sentinelPath = path.join(tmpDir, '.orchestray', 'state', '.schema-shadow-disabled');

      // Record 2 misses — sentinel should NOT yet exist
      recordMiss(tmpDir, 'tier2_load', fakeHash, 3);
      recordMiss(tmpDir, 'tier2_invoked', fakeHash, 3);
      assert.ok(!fs.existsSync(sentinelPath), 'sentinel should not exist after 2 misses');

      // Record 3rd miss — sentinel SHOULD now exist
      recordMiss(tmpDir, 'feature_gate_eval', fakeHash, 3);
      assert.ok(fs.existsSync(sentinelPath), 'sentinel should exist after 3 misses in 24h');

      // Verify misses file exists
      const missesPath = path.join(tmpDir, '.orchestray', 'state', 'schema-shadow-misses.jsonl');
      assert.ok(fs.existsSync(missesPath), 'misses log should exist');
      const lines = fs.readFileSync(missesPath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 3, 'misses log should have 3 entries');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('R-SHDW: source-hash staleness', () => {
  test('13. source-hash mismatch detected (loadShadowWithCheck)', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      spawnSync(process.execPath, [REGEN_SCRIPT, '--cwd', tmpDir], {
        encoding: 'utf8', timeout: 10000,
      });

      // Tamper the shadow hash
      const shadowPath = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.shadow.json');
      const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
      shadow._meta.source_hash = 'badhash'.repeat(10).slice(0, 64);
      fs.writeFileSync(shadowPath, JSON.stringify(shadow));

      const { loadShadowWithCheck } = require(path.resolve(REPO_ROOT, 'bin', '_lib', 'load-schema-shadow.js'));
      const result = loadShadowWithCheck(tmpDir, {});

      assert.ok(result.stale === true, 'stale should be true on hash mismatch');
      assert.ok(result.disabled === false, 'disabled should be false (stale != disabled)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('R-SHDW: config schema', () => {
  test('14. config schema accepts valid event_schema_shadow block', () => {
    const { loadEventSchemaShadowConfig, validateEventSchemaShadowConfig } = require(
      path.resolve(REPO_ROOT, 'bin', '_lib', 'config-schema.js')
    );

    const valid = validateEventSchemaShadowConfig({ enabled: true, miss_threshold_24h: 5 });
    assert.ok(valid.valid, 'valid config should pass: ' + JSON.stringify(valid));

    const validDefault = validateEventSchemaShadowConfig({ enabled: false });
    assert.ok(validDefault.valid, 'enabled:false should be valid');
  });

  test('15. config schema rejects invalid event_schema_shadow values', () => {
    const { validateEventSchemaShadowConfig } = require(
      path.resolve(REPO_ROOT, 'bin', '_lib', 'config-schema.js')
    );

    const bad1 = validateEventSchemaShadowConfig({ enabled: 'yes' });
    assert.ok(!bad1.valid, 'enabled:string should be invalid');

    const bad2 = validateEventSchemaShadowConfig({ miss_threshold_24h: -1 });
    assert.ok(!bad2.valid, 'negative threshold should be invalid');

    const bad3 = validateEventSchemaShadowConfig({ typo_key: true });
    assert.ok(!bad3.valid, 'unknown key should be reported');
    assert.ok(bad3.errors.some(e => e.includes('typo_key')), 'error should name the unknown key');
  });
});
