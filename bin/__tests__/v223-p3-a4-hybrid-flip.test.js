#!/usr/bin/env node
'use strict';

/**
 * v223-p3-a4-hybrid-flip.test.js — v2.2.3 P3-W1 (A4) Structured Outputs flip.
 *
 * Verifies the v2.2.3 expansion of `staged_flip_allowlist` from
 * `["researcher","tester"]` to include all 8 hybrid roles
 * (developer, debugger, reviewer, architect, documenter, refactorer,
 * inventor, release-manager). Asserts:
 *   1. Each of the 8 hybrid roles is in the DEFAULT staged_flip_allowlist
 *      (output-shape.js DEFAULT_OUTPUT_SHAPE_CONFIG, in-code source of truth).
 *   2. decideShape() returns non-null `output_config_format` for each hybrid
 *      role, and the returned schema is the SHARED HYBRID_ROLE_SCHEMA
 *      (one schema reused across the 8 roles, not 8 distinct shapes).
 *   3. Schema required-field set matches the universal Handoff Contract §2
 *      (HANDOFF_REQUIRED_SECTIONS in handoff-contract-text.js).
 *   4. The PreToolUse:Agent hook (inject-output-shape.js) sets
 *      `outputConfig.format` AND emits `output_shape_applied` with
 *      `structured: true` for hybrid roles by default.
 *   5. Researcher + tester behavior is UNCHANGED (regression guard): they
 *      still receive their per-role RESEARCHER_SCHEMA / TESTER_SCHEMA, NOT
 *      the shared hybrid schema.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOK_PATH   = path.join(REPO_ROOT, 'bin', 'inject-output-shape.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE        = process.execPath;

const {
  decideShape,
  DEFAULT_OUTPUT_SHAPE_CONFIG,
  ROLE_SCHEMA_MAP,
  HYBRID_ROLE_SCHEMA,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));

const { HANDOFF_REQUIRED_SECTIONS } = require(
  path.join(REPO_ROOT, 'bin', '_lib', 'handoff-contract-text.js')
);

const HYBRID_ROLES = [
  'developer', 'debugger', 'reviewer', 'architect',
  'documenter', 'refactorer', 'inventor', 'release-manager',
];

// ---------------------------------------------------------------------------
// Test harness helpers (mirrors v222 test conventions)
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p3-a4-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

function writeOrchMarker(root, orchId) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function runHook(payload) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env),
    encoding: 'utf8',
    timeout: 8000,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    parsedStdout: (() => {
      try { return r.stdout ? JSON.parse(r.stdout) : null; } catch (_e) { return null; }
    })(),
  };
}

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter((e) => e !== null);
}

const ORIG_PROMPT = '## Task\nDo a thing.\n';

// ---------------------------------------------------------------------------
// 1. Allowlist membership
// ---------------------------------------------------------------------------

describe('A4: default staged_flip_allowlist contains all 8 hybrid roles', () => {
  test('DEFAULT_OUTPUT_SHAPE_CONFIG.staged_flip_allowlist is a strict superset', () => {
    const allow = DEFAULT_OUTPUT_SHAPE_CONFIG.staged_flip_allowlist;
    assert.ok(Array.isArray(allow), 'allowlist is an array');
    for (const role of HYBRID_ROLES) {
      assert.ok(allow.indexOf(role) !== -1,
        `default allowlist must include hybrid role ${role}`);
    }
    // researcher + tester regression — must remain in allowlist.
    assert.ok(allow.indexOf('researcher') !== -1, 'researcher remains in allowlist');
    assert.ok(allow.indexOf('tester') !== -1,     'tester remains in allowlist');
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Schema reuse + handoff-contract alignment
// ---------------------------------------------------------------------------

describe('A4: hybrid roles share HYBRID_ROLE_SCHEMA via decideShape', () => {
  test('decideShape returns the SAME object identity across all 8 hybrids', () => {
    const seen = new Set();
    for (const role of HYBRID_ROLES) {
      const out = decideShape(role, { cwd: '/' });
      assert.ok(out, `${role}: decideShape returns non-null`);
      assert.equal(out.category, 'hybrid', `${role}: category=hybrid`);
      assert.ok(out.output_config_format,
        `${role}: output_config_format must be non-null after A4 flip`);
      // Object-identity check: one schema, not 8 distinct copies.
      seen.add(out.output_config_format);
      assert.equal(out.output_config_format, HYBRID_ROLE_SCHEMA,
        `${role}: schema must be the SHARED HYBRID_ROLE_SCHEMA`);
    }
    assert.equal(seen.size, 1, 'all 8 hybrids share one frozen schema object');
  });

  test('HYBRID_ROLE_SCHEMA required fields == HANDOFF_REQUIRED_SECTIONS', () => {
    assert.deepEqual(
      [...HYBRID_ROLE_SCHEMA.required].sort(),
      [...HANDOFF_REQUIRED_SECTIONS].sort(),
      'shared hybrid schema must mirror the universal Handoff Contract §2 set'
    );
    // Additive contract: role-specific §4 fields (developer.tests_passing,
    // architect.design_decisions, …) survive via additionalProperties: true.
    assert.equal(HYBRID_ROLE_SCHEMA.additionalProperties, true,
      'additionalProperties: true so per-role optional fields survive');
  });

  test('ROLE_SCHEMA_MAP exposes a schema for each of the 8 hybrids', () => {
    for (const role of HYBRID_ROLES) {
      assert.ok(ROLE_SCHEMA_MAP[role],
        `ROLE_SCHEMA_MAP must have an entry for hybrid role ${role}`);
      assert.equal(ROLE_SCHEMA_MAP[role], HYBRID_ROLE_SCHEMA,
        `${role}: ROLE_SCHEMA_MAP entry IS the shared HYBRID_ROLE_SCHEMA`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end hook integration
// ---------------------------------------------------------------------------

describe('A4: PreToolUse hook sets outputConfig.format on hybrid roles', () => {
  test('each hybrid role gets outputConfig.format and structured=true event', () => {
    for (const role of HYBRID_ROLES) {
      const root = makeTmpRoot();
      writeOrchMarker(root, 'orch-v223-a4-' + role);
      const r = runHook({
        tool_name: 'Agent', cwd: root,
        tool_input: { subagent_type: role, prompt: ORIG_PROMPT },
      });
      assert.equal(r.status, 0, `${role}: hook exit 0; stderr=${r.stderr}`);
      const out = r.parsedStdout;
      assert.ok(out.hookSpecificOutput,
        `${role}: hybrid role must get an updatedInput`);

      const oc = out.hookSpecificOutput.updatedInput.outputConfig;
      assert.ok(oc && oc.format,
        `${role}: outputConfig.format MUST be set after A4 flip`);
      assert.deepEqual(oc.format, HYBRID_ROLE_SCHEMA,
        `${role}: outputConfig.format == HYBRID_ROLE_SCHEMA`);

      // Telemetry — operators read structured=true to confirm the flip
      // landed in production.
      const evs = readEvents(root);
      const ev = evs.find((e) => e.type === 'output_shape_applied');
      assert.ok(ev, `${role}: output_shape_applied event written`);
      assert.equal(ev.role, role);
      assert.equal(ev.category, 'hybrid');
      assert.equal(ev.structured, true,
        `${role}: structured=true confirms schema enforcement is on`);
      assert.match(ev.reason || '', /structured=on/,
        `${role}: reason field records structured=on`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Regression — researcher + tester unchanged
// ---------------------------------------------------------------------------

describe('A4 regression: researcher + tester behavior unchanged', () => {
  test('researcher receives RESEARCHER_SCHEMA, NOT HYBRID_ROLE_SCHEMA', () => {
    const out = decideShape('researcher', { cwd: '/' });
    assert.ok(out.output_config_format);
    assert.notEqual(out.output_config_format, HYBRID_ROLE_SCHEMA,
      'researcher must keep its dedicated structured-only schema');
    assert.ok(Array.isArray(out.output_config_format.required));
    assert.ok(out.output_config_format.required.indexOf('research_summary') !== -1,
      'researcher schema requires the role-specific research_summary field');
  });

  test('tester receives TESTER_SCHEMA, NOT HYBRID_ROLE_SCHEMA', () => {
    const out = decideShape('tester', { cwd: '/' });
    assert.ok(out.output_config_format);
    assert.notEqual(out.output_config_format, HYBRID_ROLE_SCHEMA,
      'tester must keep its dedicated structured-only schema');
    assert.ok(out.output_config_format.required.indexOf('test_summary') !== -1,
      'tester schema requires the role-specific test_summary field');
  });

  test('researcher hook emit still reports category=structured-only, structured=true', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-v223-a4-r');
    const r = runHook({
      tool_name: 'Agent', cwd: root,
      tool_input: { subagent_type: 'researcher', prompt: ORIG_PROMPT },
    });
    assert.equal(r.status, 0);
    const evs = readEvents(root);
    const ev = evs.find((e) => e.type === 'output_shape_applied');
    assert.ok(ev);
    assert.equal(ev.category, 'structured-only',
      'researcher category unchanged by A4');
    assert.equal(ev.structured, true);
  });
});
