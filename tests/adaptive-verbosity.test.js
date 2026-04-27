#!/usr/bin/env node
'use strict';

/**
 * T24 — Adaptive Verbosity tests  (v2.0.17)
 *
 * Covers:
 *  - DEFAULT_ADAPTIVE_VERBOSITY shape and defaults
 *  - loadAdaptiveVerbosityConfig fail-open / merge / partial-override
 *  - validateAdaptiveVerbosityConfig field-level rejection and acceptance
 *  - tier1-orchestration.md §3.Y structural content
 *  - delegation-templates.md response-budget line
 *  - agents/pm.md dispatch-table row referencing adaptive_verbosity gate
 *  - capture-pm-turn output_tokens regression (Phase 1 schema records output_tokens)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

const {
  DEFAULT_ADAPTIVE_VERBOSITY,
  loadAdaptiveVerbosityConfig,
  validateAdaptiveVerbosityConfig,
} = require(path.join(ROOT, 'bin/_lib/config-schema.js'));

const CAPTURE_PM_TURN = path.join(ROOT, 'bin/capture-pm-turn.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-avtest-'));
}

function writeConfig(tmpDir, obj) {
  const dir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8');
}

function writeOrchestrationId(tmpDir, id) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

function writeTranscript(tmpDir, lines) {
  const p = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function readMetricsRows(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function runCapturePmTurn(stdinData, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CAPTURE_PM_TURN], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// DEFAULT_ADAPTIVE_VERBOSITY shape and defaults
// ---------------------------------------------------------------------------

describe('DEFAULT_ADAPTIVE_VERBOSITY defaults', () => {

  test('default object has enabled, base_response_tokens, reducer_on_late_phase keys', () => {
    assert.ok('enabled' in DEFAULT_ADAPTIVE_VERBOSITY, 'must have enabled');
    assert.ok('base_response_tokens' in DEFAULT_ADAPTIVE_VERBOSITY, 'must have base_response_tokens');
    assert.ok('reducer_on_late_phase' in DEFAULT_ADAPTIVE_VERBOSITY, 'must have reducer_on_late_phase');
  });

  test('enabled defaults to true (v2.2.3 P3-W3 default-on flip per feedback_default_on_shipping.md)', () => {
    assert.strictEqual(DEFAULT_ADAPTIVE_VERBOSITY.enabled, true);
  });

  test('base_response_tokens defaults to 2000', () => {
    assert.strictEqual(DEFAULT_ADAPTIVE_VERBOSITY.base_response_tokens, 2000);
  });

  test('reducer_on_late_phase defaults to 0.4', () => {
    assert.strictEqual(DEFAULT_ADAPTIVE_VERBOSITY.reducer_on_late_phase, 0.4);
  });

  test('default object is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(DEFAULT_ADAPTIVE_VERBOSITY), 'must be frozen to prevent accidental mutation');
  });

  test('default object has exactly three keys — no undocumented extras', () => {
    const keys = Object.keys(DEFAULT_ADAPTIVE_VERBOSITY);
    assert.deepEqual(keys.sort(), ['base_response_tokens', 'enabled', 'reducer_on_late_phase'].sort());
  });

});

// ---------------------------------------------------------------------------
// loadAdaptiveVerbosityConfig — fail-open contract
// ---------------------------------------------------------------------------

describe('loadAdaptiveVerbosityConfig — fail-open contract', () => {

  test('returns defaults when .orchestray/config.json is missing', () => {
    const tmpDir = makeTmpDir();
    try {
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      // v2.2.3 P3-W3: default-on flip per `feedback_default_on_shipping.md`
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 2000);
      assert.strictEqual(cfg.reducer_on_late_phase, 0.4);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns defaults when config.json contains invalid JSON', () => {
    const tmpDir = makeTmpDir();
    try {
      const dir = path.join(tmpDir, '.orchestray');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json }');
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 2000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns defaults when config.json has no adaptive_verbosity key', () => {
    const tmpDir = makeTmpDir();
    try {
      writeConfig(tmpDir, { some_other_key: true });
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 2000);
      assert.strictEqual(cfg.reducer_on_late_phase, 0.4);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns defaults when adaptive_verbosity is not an object (e.g. a string)', () => {
    const tmpDir = makeTmpDir();
    try {
      writeConfig(tmpDir, { adaptive_verbosity: 'on' });
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns defaults when adaptive_verbosity is an array', () => {
    const tmpDir = makeTmpDir();
    try {
      writeConfig(tmpDir, { adaptive_verbosity: [true] });
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// loadAdaptiveVerbosityConfig — partial override / merge
// ---------------------------------------------------------------------------

describe('loadAdaptiveVerbosityConfig — partial override and merge', () => {

  test('merges enabled:true while keeping other defaults', () => {
    const tmpDir = makeTmpDir();
    try {
      writeConfig(tmpDir, { adaptive_verbosity: { enabled: true } });
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 2000, 'non-overridden fields must stay at default');
      assert.strictEqual(cfg.reducer_on_late_phase, 0.4, 'non-overridden fields must stay at default');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('merges base_response_tokens:1500 while reducer stays at default', () => {
    const tmpDir = makeTmpDir();
    try {
      writeConfig(tmpDir, { adaptive_verbosity: { enabled: true, base_response_tokens: 1500 } });
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 1500);
      assert.strictEqual(cfg.reducer_on_late_phase, 0.4, 'reducer_on_late_phase must remain default');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('merges all three fields when all are provided', () => {
    const tmpDir = makeTmpDir();
    try {
      writeConfig(tmpDir, {
        adaptive_verbosity: { enabled: true, base_response_tokens: 3000, reducer_on_late_phase: 0.6 },
      });
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.base_response_tokens, 3000);
      assert.strictEqual(cfg.reducer_on_late_phase, 0.6);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns a plain mutable copy, not the frozen DEFAULT object', () => {
    const tmpDir = makeTmpDir();
    try {
      const cfg = loadAdaptiveVerbosityConfig(tmpDir);
      assert.ok(!Object.isFrozen(cfg), 'returned config must be a mutable copy, not the frozen default');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// validateAdaptiveVerbosityConfig — rejection cases
// ---------------------------------------------------------------------------

describe('validateAdaptiveVerbosityConfig — invalid inputs rejected', () => {

  test('rejects when enabled is a string "yes"', () => {
    const result = validateAdaptiveVerbosityConfig({ enabled: 'yes', base_response_tokens: 2000, reducer_on_late_phase: 0.4 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0, 'must return errors array');
    assert.ok(result.errors.some(e => e.includes('enabled')), 'error must mention "enabled"');
  });

  test('rejects when enabled is a number 1', () => {
    const result = validateAdaptiveVerbosityConfig({ enabled: 1 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('enabled')));
  });

  test('rejects when base_response_tokens is negative', () => {
    const result = validateAdaptiveVerbosityConfig({ base_response_tokens: -100 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('base_response_tokens')));
  });

  test('rejects when base_response_tokens is zero', () => {
    const result = validateAdaptiveVerbosityConfig({ base_response_tokens: 0 });
    assert.strictEqual(result.valid, false);
  });

  test('rejects when base_response_tokens is a float (non-integer)', () => {
    const result = validateAdaptiveVerbosityConfig({ base_response_tokens: 1500.5 });
    assert.strictEqual(result.valid, false);
  });

  test('rejects when base_response_tokens is a string', () => {
    const result = validateAdaptiveVerbosityConfig({ base_response_tokens: '2000' });
    assert.strictEqual(result.valid, false);
  });

  test('rejects when reducer_on_late_phase is 1.5 (above 1.0)', () => {
    const result = validateAdaptiveVerbosityConfig({ reducer_on_late_phase: 1.5 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('reducer_on_late_phase')));
  });

  test('rejects when reducer_on_late_phase is -0.1 (below 0.0)', () => {
    const result = validateAdaptiveVerbosityConfig({ reducer_on_late_phase: -0.1 });
    assert.strictEqual(result.valid, false);
  });

  test('rejects when reducer_on_late_phase is a string', () => {
    const result = validateAdaptiveVerbosityConfig({ reducer_on_late_phase: '0.4' });
    assert.strictEqual(result.valid, false);
  });

  test('rejects non-object input (array)', () => {
    const result = validateAdaptiveVerbosityConfig([]);
    assert.strictEqual(result.valid, false);
  });

  test('rejects non-object input (null)', () => {
    const result = validateAdaptiveVerbosityConfig(null);
    assert.strictEqual(result.valid, false);
  });

  test('rejects non-object input (string)', () => {
    const result = validateAdaptiveVerbosityConfig('enabled');
    assert.strictEqual(result.valid, false);
  });

});

// ---------------------------------------------------------------------------
// validateAdaptiveVerbosityConfig — valid inputs accepted
// ---------------------------------------------------------------------------

describe('validateAdaptiveVerbosityConfig — valid inputs accepted', () => {

  test('accepts the default object values', () => {
    const result = validateAdaptiveVerbosityConfig({
      enabled: false,
      base_response_tokens: 2000,
      reducer_on_late_phase: 0.4,
    });
    assert.strictEqual(result.valid, true);
  });

  test('accepts enabled:true with custom budget', () => {
    const result = validateAdaptiveVerbosityConfig({
      enabled: true,
      base_response_tokens: 3000,
      reducer_on_late_phase: 0.5,
    });
    assert.strictEqual(result.valid, true);
  });

  test('accepts reducer_on_late_phase at boundary value 0.0', () => {
    const result = validateAdaptiveVerbosityConfig({ reducer_on_late_phase: 0.0 });
    assert.strictEqual(result.valid, true);
  });

  test('accepts reducer_on_late_phase at boundary value 1.0', () => {
    const result = validateAdaptiveVerbosityConfig({ reducer_on_late_phase: 1.0 });
    assert.strictEqual(result.valid, true);
  });

  test('accepts base_response_tokens at minimum value 1', () => {
    const result = validateAdaptiveVerbosityConfig({ base_response_tokens: 1 });
    assert.strictEqual(result.valid, true);
  });

  test('accepts an empty object (no fields to validate)', () => {
    const result = validateAdaptiveVerbosityConfig({});
    assert.strictEqual(result.valid, true);
  });

  test('valid result has no errors array or an empty one', () => {
    const result = validateAdaptiveVerbosityConfig({ enabled: true });
    assert.strictEqual(result.valid, true);
    if ('errors' in result) {
      assert.strictEqual(result.errors.length, 0);
    }
  });

});

// ---------------------------------------------------------------------------
// tier1-orchestration.md §3.Y structural content
// ---------------------------------------------------------------------------

describe('tier1-orchestration.md §3.Y structural content', () => {

  // W5 split: §3.Y content moved to tier1-orchestration-rare.md.
  // W8 (v2.1.15): tier1-orchestration.md retired to .legacy. Scan the legacy
  // file plus the rare file so the suite passes regardless of which one hosts
  // the content.
  const TIER1_LEGACY = path.join(ROOT, 'agents/pm-reference/tier1-orchestration.md.legacy');
  const TIER1_RARE = path.join(ROOT, 'agents/pm-reference/tier1-orchestration-rare.md');

  function getContent() {
    let c = '';
    try { c += fs.readFileSync(TIER1_LEGACY, 'utf8'); } catch (_e) { /* ok */ }
    try { c += '\n' + fs.readFileSync(TIER1_RARE, 'utf8'); } catch (_e) { /* ok */ }
    return c;
  }

  test('file exists', () => {
    // Legacy preserves §3.Y content for one release per W8 reversibility plan.
    assert.ok(fs.existsSync(TIER1_LEGACY), `${TIER1_LEGACY} must exist for the rollback path`);
  });

  test('contains §3.Y heading (adaptive verbosity section)', () => {
    const c = getContent();
    assert.ok(/§3\.Y|3\.Y\s+Adaptive\s+Verbosity/i.test(c), '§3.Y heading not found in tier1-orchestration.md or tier1-orchestration-rare.md');
  });

  test('mentions phase_position in the formula section', () => {
    assert.ok(/phase_position/.test(getContent()), 'formula must reference phase_position');
  });

  test('mentions reducer_on_late_phase in the formula section', () => {
    assert.ok(/reducer_on_late_phase/.test(getContent()), 'formula must reference reducer_on_late_phase');
  });

  test('mentions base_response_tokens in the formula section', () => {
    assert.ok(/base_response_tokens/.test(getContent()), 'formula must reference base_response_tokens');
  });

  test('formula uses >= 0.5 threshold for late-phase detection', () => {
    assert.ok(
      /phase_position\s*>=\s*0\.5/.test(getContent()),
      'formula must include phase_position >= 0.5'
    );
  });

  test('does NOT contain cache_control_marker (deprecated concept must be absent)', () => {
    assert.ok(
      !getContent().includes('cache_control_marker'),
      'cache_control_marker must not appear — it was removed from the design'
    );
  });

  test('references both gates: adaptive_verbosity.enabled and v2017_experiments.adaptive_verbosity', () => {
    const c = getContent();
    assert.ok(c.includes('adaptive_verbosity.enabled'), 'must reference adaptive_verbosity.enabled gate');
    assert.ok(
      /v2017_experiments\.adaptive_verbosity/.test(c),
      'must reference v2017_experiments.adaptive_verbosity gate'
    );
  });

});

// ---------------------------------------------------------------------------
// delegation-templates.md — response-budget line template
// ---------------------------------------------------------------------------

describe('delegation-templates.md response-budget line', () => {

  // W5 split: response-budget content moved to delegation-templates-detailed.md.
  // Tests scan both lean and detailed files so the suite passes regardless of
  // which file hosts specific content.
  const TEMPLATES = path.join(ROOT, 'agents/pm-reference/delegation-templates.md');
  const TEMPLATES_DETAILED = path.join(ROOT, 'agents/pm-reference/delegation-templates-detailed.md');

  function getContent() {
    let c = '';
    try { c += fs.readFileSync(TEMPLATES, 'utf8'); } catch (_e) { /* ok */ }
    try { c += '\n' + fs.readFileSync(TEMPLATES_DETAILED, 'utf8'); } catch (_e) { /* ok */ }
    return c;
  }

  test('file exists', () => {
    assert.ok(fs.existsSync(TEMPLATES), `${TEMPLATES} must exist`);
  });

  test('contains a Response budget template line', () => {
    const c = getContent();
    assert.ok(
      /[Rr]esponse\s+[Bb]udget/.test(c),
      'delegation-templates.md or delegation-templates-detailed.md must contain a "Response budget" line'
    );
  });

  test('template uses {N} placeholder for the budget value', () => {
    const c = getContent();
    assert.ok(
      /\{N\}/.test(c),
      'template must use {N} as a placeholder for the token-budget integer'
    );
  });

  test('template line references "tokens"', () => {
    assert.ok(/tokens/.test(getContent()), 'template must mention "tokens"');
  });

  test('references injection rules or gates (guards against unconditional injection)', () => {
    const c = getContent();
    assert.ok(
      /gate|Gate|inject|only inject|§3\.Y/i.test(c),
      'templates file must reference gates or injection rules to prevent unconditional use'
    );
  });

  test('states that Haiku-tier agents are excluded from injection', () => {
    const c = getContent();
    assert.ok(
      /[Hh]aiku/.test(c),
      'delegation-templates.md or delegation-templates-detailed.md must mention Haiku exclusion for response-budget injection'
    );
  });

});

// ---------------------------------------------------------------------------
// agents/pm.md dispatch-table references adaptive_verbosity gate
// ---------------------------------------------------------------------------

describe('agents/pm.md dispatch-table adaptive_verbosity row', () => {

  const PM_MD = path.join(ROOT, 'agents/pm.md');

  function getContent() {
    return fs.readFileSync(PM_MD, 'utf8');
  }

  test('file exists', () => {
    assert.ok(fs.existsSync(PM_MD), `${PM_MD} must exist`);
  });

  test('dispatch table contains adaptive_verbosity === on gate condition', () => {
    const c = getContent();
    assert.ok(
      /v2017_experiments\.adaptive_verbosity\s*===\s*['"]on['"]/.test(c),
      'pm.md dispatch table must have row gating on v2017_experiments.adaptive_verbosity === "on"'
    );
  });

  test('dispatch row references tier1-orchestration.md §3.Y', () => {
    const c = getContent();
    assert.ok(
      /tier1-orchestration\.md/.test(c) && /§3\.Y/.test(c),
      'dispatch row must reference tier1-orchestration.md §3.Y'
    );
  });

  test('dispatch row also requires adaptive_verbosity.enabled === true', () => {
    const c = getContent();
    assert.ok(
      /adaptive_verbosity\.enabled\s*===\s*true/.test(c),
      'dispatch row must require adaptive_verbosity.enabled === true as second gate'
    );
  });

});

// ---------------------------------------------------------------------------
// output_tokens regression — capture-pm-turn.js records usage.output_tokens
// (§7.5 measurement hook: once adaptive_verbosity flips on, existing metrics
//  already capture output_tokens without new instrumentation)
// ---------------------------------------------------------------------------

describe('capture-pm-turn records usage.output_tokens (Phase 1 schema)', () => {

  test('pm_turn row preserves output_tokens from transcript', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      {
        role: 'assistant',
        content: 'response here',
        model: 'claude-sonnet-4-6',
        timestamp: '2026-04-15T10:00:00.000Z',
        usage: {
          input_tokens: 1200,
          output_tokens: 500,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    try {
      const { status, stdout } = runCapturePmTurn(JSON.stringify({
        cwd: tmpDir,
        transcript_path: transcriptPath,
        session_id: 'sess-av-regression',
      }));

      assert.strictEqual(status, 0);
      const out = JSON.parse(stdout.trim());
      assert.strictEqual(out.continue, true);

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row must be written');
      assert.strictEqual(pmRow.usage.output_tokens, 500,
        'output_tokens must be recorded exactly — adaptive_verbosity measurement depends on this');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pm_turn row with output_tokens:500 does not conflate with input_tokens', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      {
        role: 'assistant',
        usage: {
          input_tokens: 3000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    try {
      runCapturePmTurn(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row required');
      assert.strictEqual(pmRow.usage.output_tokens, 500);
      assert.strictEqual(pmRow.usage.input_tokens, 3000, 'input_tokens must not be clobbered');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pm_turn row records zero output_tokens when assistant turn has zero output', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      {
        role: 'assistant',
        usage: {
          input_tokens: 800,
          output_tokens: 0,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    try {
      runCapturePmTurn(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row required');
      assert.strictEqual(pmRow.usage.output_tokens, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pm_turn row includes usage.output_tokens field even when orchestration_id is unknown', () => {
    const tmpDir = makeTmpDir();
    // No current-orchestration.json
    const transcriptPath = writeTranscript(tmpDir, [
      {
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 250, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    ]);

    try {
      runCapturePmTurn(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row required');
      assert.ok('output_tokens' in pmRow.usage, 'usage.output_tokens field must be present');
      assert.strictEqual(pmRow.usage.output_tokens, 250);
      assert.strictEqual(pmRow.orchestration_id, null, 'orchestration_id must be null when no state file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
