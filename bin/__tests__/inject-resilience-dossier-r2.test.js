#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.1.10 R2 — native additionalContext envelope for resilience dossier.
 *
 * Covers:
 *   AC-01: UserPromptSubmit emits single-line JSON with hookSpecificOutput.additionalContext ≤10000 chars
 *   AC-05: ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1 reverts to fenced-markdown output
 *   AC-06: Truncation when dossier exceeds 10000 characters
 *
 * Also covers:
 *   - handleSessionStart emits correct envelope on SessionStart path
 *   - ORCHESTRAY_RESILIENCE_DISABLED=1 produces no injection (nop output)
 *   - Stale dossier (status=completed) is skipped on SessionStart
 *   - _buildAdditionalContext helper used correctly in both modes
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'inject-resilience-dossier.js');

// Import the module directly for unit tests.
const {
  handleUserPromptSubmit,
  handleSessionStart,
  NATIVE_ENVELOPE_MAX_CHARS,
  TRUNCATION_MARKER,
  FENCE_OPEN,
  FENCE_CLOSE,
  _buildAdditionalContext,
} = require(HOOK);

const {
  buildDossier,
  serializeDossier,
} = require('../_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid dossier serialized string using the schema builder.
 * @param {string} [orchestrationId]
 * @returns {string}
 */
function buildMinimalDossier(orchestrationId = 'orch-test-r2') {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: {
      id: orchestrationId,
      phase: 'executing',
      status: 'in_progress',
      complexity_score: 7,
    },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }));
  return serialized;
}

/**
 * Build a completed dossier (status=completed).
 */
function buildCompletedDossier() {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: {
      id: 'orch-done',
      phase: 'completed',
      status: 'completed',
      complexity_score: 5,
    },
    task_ids: { pending: [], completed: ['W1'], failed: [] },
  }));
  return serialized;
}

/**
 * Create a minimal .orchestray directory tree in a temp dir with a valid dossier
 * and compact-signal.lock.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.dossierRaw] - Raw string for dossier.json, or null to omit.
 *   Defaults to a valid minimal dossier built by buildMinimalDossier().
 * @param {boolean} [opts.withLock] - If true (default), writes compact-signal.lock.
 * @param {object|null} [opts.config] - Object to write as .orchestray/config.json.
 * @returns {string} Temp directory path.
 */
function makeProjectDir({ dossierRaw, withLock = true, config = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ird-r2-'));
  const orchestrayDir = path.join(tmp, '.orchestray');
  const stateDir = path.join(orchestrayDir, 'state');
  const auditDir = path.join(orchestrayDir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  // Default: use a properly-formed dossier (parseDossier must return ok:true).
  const raw = dossierRaw !== undefined ? dossierRaw : buildMinimalDossier();
  if (raw !== null) {
    fs.writeFileSync(path.join(stateDir, 'resilience-dossier.json'), raw);
  }

  if (withLock) {
    const lock = JSON.stringify({
      source: 'compact',
      ingested_count: 0,
      max_injections: 3,
      written_at: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(stateDir, 'compact-signal.lock'), lock);
  }

  if (config !== null) {
    fs.writeFileSync(
      path.join(orchestrayDir, 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  return tmp;
}

/**
 * Run the hook via spawnSync, returning { status, stdout, stderr }.
 *
 * @param {object} eventPayload - JSON payload sent to stdin.
 * @param {object} [extraEnv] - Extra env vars.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(eventPayload, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  // Remove any lingering kill-switches from parent env.
  delete env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
  delete env.ORCHESTRAY_RESILIENCE_DISABLED;
  Object.assign(env, extraEnv);

  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(eventPayload),
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ---------------------------------------------------------------------------
// AC-01: UserPromptSubmit emits single-line JSON with hookSpecificOutput.additionalContext ≤ 10000 chars
// ---------------------------------------------------------------------------

describe('R2 AC-01 — UserPromptSubmit native envelope', () => {

  test('emits single-line JSON with top-level hookSpecificOutput', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook({ cwd: tmp });
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      // Must be a single non-empty line (no trailing newline before end).
      const lines = r.stdout.split('\n').filter(l => l.trim());
      assert.equal(lines.length, 1, 'stdout must be a single JSON line');
      const parsed = JSON.parse(lines[0]);
      assert.ok('hookSpecificOutput' in parsed, 'top-level key hookSpecificOutput must be present');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('hookSpecificOutput.additionalContext is a string ≤ 10000 characters', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook({ cwd: tmp });
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.equal(typeof ctx, 'string', 'additionalContext must be a string');
      assert.ok(ctx.length <= 10000, `additionalContext length ${ctx.length} exceeds 10000 chars`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('native mode: additionalContext does NOT contain fence markers', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook({ cwd: tmp });
      const parsed = JSON.parse(r.stdout.trim());
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(!ctx.includes('<orchestray-resilience-dossier>'),
        'native mode must not wrap content in XML fence');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('native mode: additionalContext contains the dossier JSON content', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook({ cwd: tmp });
      const parsed = JSON.parse(r.stdout.trim());
      const ctx = parsed.hookSpecificOutput.additionalContext;
      // The orchestration_id must appear in the context.
      assert.ok(ctx.includes('orch-test-r2'),
        'additionalContext must contain the dossier orchestration_id');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no lock present → nop output (no injection)', () => {
    const tmp = makeProjectDir({ withLock: false });
    try {
      const r = runHook({ cwd: tmp });
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      // When there is no lock, the hook emits {continue:true} with no hookSpecificOutput.
      assert.ok(!parsed.hookSpecificOutput,
        'no lock → must not inject dossier');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// AC-05: ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1 reverts to fenced markdown
// ---------------------------------------------------------------------------

describe('R2 AC-05 — legacy fence mode via kill-switch', () => {

  test('ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1 wraps content in XML fence', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        { cwd: tmp },
        { ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED: '1' }
      );
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok('hookSpecificOutput' in parsed, 'hookSpecificOutput must be present');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('<orchestray-resilience-dossier>'),
        'legacy fence mode must include opening fence marker');
      assert.ok(ctx.includes('</orchestray-resilience-dossier>'),
        'legacy fence mode must include closing fence marker');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('legacy mode: additionalContext still ≤ 10000 characters', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        { cwd: tmp },
        { ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED: '1' }
      );
      const parsed = JSON.parse(r.stdout.trim());
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.length <= 10000,
        `legacy mode additionalContext length ${ctx.length} exceeds 10000`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unit: _buildAdditionalContext returns fence in legacy mode', () => {
    const originalEnv = process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED = '1';
    try {
      const raw = buildMinimalDossier();
      const dossier = JSON.parse(raw);
      // Use a dummy cwd — audit dir won't exist so no audit write.
      const { finalContext, truncated } = _buildAdditionalContext(raw, dossier, '/tmp');
      assert.ok(finalContext.includes(FENCE_OPEN), 'must start with fence open tag');
      assert.ok(finalContext.includes(FENCE_CLOSE), 'must include fence close tag');
      assert.equal(truncated, false, 'minimal dossier must not be truncated');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
      } else {
        process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED = originalEnv;
      }
    }
  });

});

// ---------------------------------------------------------------------------
// AC-06: Truncation when dossier > 10000 characters
// ---------------------------------------------------------------------------

describe('R2 AC-06 — truncation enforcement', () => {

  test('unit: _buildAdditionalContext native mode truncates at 10000 chars', () => {
    const originalEnv = process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
    delete process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
    try {
      // Build a raw string that is definitely > 10000 characters.
      const longString = 'x'.repeat(15000);
      const { finalContext, truncated } = _buildAdditionalContext(longString, { orchestration_id: 'orch-large', phase: 'executing', status: 'in_progress' }, '/tmp');
      assert.equal(truncated, true, 'large dossier must trigger truncation');
      assert.ok(finalContext.length <= NATIVE_ENVELOPE_MAX_CHARS,
        `truncated context length ${finalContext.length} must be ≤ ${NATIVE_ENVELOPE_MAX_CHARS}`);
      assert.ok(finalContext.includes(TRUNCATION_MARKER),
        'truncated context must include the truncation marker');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
      } else {
        process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED = originalEnv;
      }
    }
  });

  test('unit: _buildAdditionalContext legacy mode truncates at 10000 chars', () => {
    const originalEnv = process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED = '1';
    try {
      const longString = 'x'.repeat(15000);
      const dossier = { schema_version: 2, orchestration_id: 'orch-large', phase: 'executing', status: 'in_progress' };
      const { finalContext, truncated } = _buildAdditionalContext(longString, dossier, '/tmp');
      assert.equal(truncated, true, 'large dossier must trigger truncation in legacy mode');
      assert.ok(finalContext.length <= NATIVE_ENVELOPE_MAX_CHARS,
        `truncated legacy context length ${finalContext.length} must be ≤ ${NATIVE_ENVELOPE_MAX_CHARS}`);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
      } else {
        process.env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED = originalEnv;
      }
    }
  });

  test('integration: large dossier via hook exits 0 and emits additionalContext ≤ 10000 chars', () => {
    // Build a proper schema-valid dossier, then pad it so it exceeds 10000 chars.
    // We accomplish this by writing a raw JSON file with extra padding fields.
    const base = JSON.parse(buildMinimalDossier('orch-large-integ'));
    base.large_pad = 'x'.repeat(15000);
    const largeDossierRaw = JSON.stringify(base);
    const tmp = makeProjectDir({ dossierRaw: largeDossierRaw });
    try {
      const r = runHook({ cwd: tmp });
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      if (parsed.hookSpecificOutput) {
        const ctx = parsed.hookSpecificOutput.additionalContext;
        assert.ok(ctx.length <= 10000,
          `Hook must cap additionalContext at 10000 chars; got ${ctx.length}`);
      }
      // Also check the audit events.jsonl for dossier_truncated event.
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      if (fs.existsSync(eventsPath)) {
        const content = fs.readFileSync(eventsPath, 'utf8');
        assert.ok(content.includes('dossier_truncated'),
          'truncation must emit dossier_truncated audit event');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// SessionStart handler
// ---------------------------------------------------------------------------

describe('R2 — SessionStart handler', () => {

  test('SessionStart via SESSION_SOURCE=compact emits envelope with dossier', () => {
    const tmp = makeProjectDir({ withLock: false }); // No lock needed for SessionStart
    try {
      const r = runHook(
        { cwd: tmp, hook_event_name: 'SessionStart', session_source: 'compact' },
        {}
      );
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok('hookSpecificOutput' in parsed, 'SessionStart must emit hookSpecificOutput');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('orch-test-r2'),
        'SessionStart additionalContext must contain the dossier content');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('SessionStart with no dossier file → nop output', () => {
    const tmp = makeProjectDir({ dossierRaw: null, withLock: false });
    try {
      const r = runHook(
        { cwd: tmp, hook_event_name: 'SessionStart', session_source: 'compact' },
        {}
      );
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok(!parsed.hookSpecificOutput,
        'no dossier → SessionStart must not inject');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('SessionStart with completed dossier → nop output (stale skip)', () => {
    const completedDossier = buildCompletedDossier();
    const tmp = makeProjectDir({ dossierRaw: completedDossier, withLock: false });
    try {
      const r = runHook(
        { cwd: tmp, hook_event_name: 'SessionStart', session_source: 'resume' },
        {}
      );
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok(!parsed.hookSpecificOutput,
        'completed dossier → SessionStart must skip injection');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handleSessionStart unit: returns injected action with envelope output', () => {
    const tmp = makeProjectDir({ withLock: false });
    try {
      const result = handleSessionStart({ cwd: tmp });
      assert.equal(result.action, 'injected');
      assert.ok(result.output.hookSpecificOutput,
        'unit: output must carry hookSpecificOutput');
      assert.equal(result.output.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(typeof result.output.hookSpecificOutput.additionalContext === 'string');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Kill-switch: ORCHESTRAY_RESILIENCE_DISABLED=1
// ---------------------------------------------------------------------------

describe('R2 — ORCHESTRAY_RESILIENCE_DISABLED kill-switch', () => {

  test('ORCHESTRAY_RESILIENCE_DISABLED=1 → nop output on UserPromptSubmit', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        { cwd: tmp },
        { ORCHESTRAY_RESILIENCE_DISABLED: '1' }
      );
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok(!parsed.hookSpecificOutput,
        'ORCHESTRAY_RESILIENCE_DISABLED must suppress injection');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handleUserPromptSubmit unit: ORCHESTRAY_RESILIENCE_DISABLED=1 → skipped_kill_switch', () => {
    const tmp = makeProjectDir();
    const originalEnv = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
    try {
      const result = handleUserPromptSubmit({ cwd: tmp });
      assert.equal(result.action, 'skipped_kill_switch');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      } else {
        process.env.ORCHESTRAY_RESILIENCE_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// F-01 regression: UserPromptSubmit with oversized dossier must inject (not nop)
// ---------------------------------------------------------------------------

describe('R2 F-01 regression — oversized dossier injects truncated content via UserPromptSubmit', () => {

  test('integration: UserPromptSubmit with oversized dossier injects truncated content (not nop)', () => {
    const base = JSON.parse(buildMinimalDossier('orch-large-up'));
    base.large_pad = 'x'.repeat(15000);
    const tmp = makeProjectDir({ dossierRaw: JSON.stringify(base) });
    try {
      const r = runHook({ cwd: tmp });
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      // Must inject truncated content, not silently skip (nop) due to ReferenceError on `fenced`.
      assert.ok(parsed.hookSpecificOutput, 'oversized dossier must still inject (truncated), not nop');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.ok(ctx.length <= 10000, `additionalContext must be capped; got ${ctx.length}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// NATIVE_ENVELOPE_MAX_CHARS constant sanity
// ---------------------------------------------------------------------------

describe('R2 — constants', () => {

  test('NATIVE_ENVELOPE_MAX_CHARS is 10000', () => {
    assert.equal(NATIVE_ENVELOPE_MAX_CHARS, 10000);
  });

  test('TRUNCATION_MARKER includes the key string', () => {
    assert.ok(TRUNCATION_MARKER.includes('TRUNCATED'),
      'marker must include the word TRUNCATED');
    assert.ok(TRUNCATION_MARKER.includes('resilience-dossier.json'),
      'marker must reference the disk dossier path');
  });

});
