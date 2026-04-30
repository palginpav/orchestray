'use strict';

/**
 * v2214-G04-context-hint-required-retired.test.js — G-04 retirement regression.
 *
 * Asserts that ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED is fully retired:
 *   1. No process.env read of the var exists in any bin/ source file.
 *   2. Setting the var does NOT bypass the hard-block in preflight-spawn-budget.js
 *      (spawn still exits 2 when no context_size_hint is present).
 *   3. context_size_hint_required_failed event fires even when the var is set.
 *
 * Runner: node --require ./tests/helpers/setup.js --test
 *         bin/__tests__/v2214-G04-context-hint-required-retired.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const BIN_DIR    = path.join(REPO_ROOT, 'bin');
const HOOK_PATH  = path.join(BIN_DIR, 'preflight-spawn-budget.js');
const NODE       = process.execPath;
const VAR_NAME   = 'ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk bin/ recursively and return all .js source files (excluding __tests__). */
function collectBinSources() {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.js')) {
        results.push(full);
      }
    }
  }
  walk(BIN_DIR);
  return results;
}

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2214-g04-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
    },
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-g04-test' }),
    'utf8',
  );

  return dir;
}

function readEvents(root) {
  try {
    return fs.readFileSync(
      path.join(root, '.orchestray', 'audit', 'events.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(e => e.type !== 'audit_event_autofilled'); /* v2.2.15: filter P1-13 diagnostic emit */
  } catch (_e) { return []; }
}

function runHook(cwd, toolInput, envOverrides) {
  const payload = { tool_name: 'Agent', cwd, tool_input: toolInput };
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv[VAR_NAME];
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED;
  delete baseEnv.ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED;
  const env = Object.assign({}, baseEnv, { ORCHESTRAY_DEBUG: '' }, envOverrides || {});
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.14 G-04 — ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED fully retired', () => {

  let tmpRoot;
  beforeEach(() => { tmpRoot = makeTmpRoot(); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  // ── Test 1: no process.env read in any bin/ source ─────────────────────
  test('no bin/ source file reads process.env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED', () => {
    const PROCESS_ENV_READ_RE = new RegExp(
      'process\\.env\\.' + VAR_NAME.replace(/_/g, '_'),
    );

    const violations = [];
    for (const file of collectBinSources()) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (PROCESS_ENV_READ_RE.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.equal(
      violations.length,
      0,
      'Found process.env reads that should have been deleted (G-04):\n' +
      violations.join('\n'),
    );
  });

  // ── Test 2: var set → spawn still hard-blocks (exit 2) ─────────────────
  test(`${VAR_NAME}=1 + missing hint → exits 2 (hard-block is unconditional)`, () => {
    const r = runHook(
      tmpRoot,
      {
        subagent_type: 'developer',
        task_id: 'G04-T2',
        prompt: 'You are a developer agent. No hint in this prompt.',
        // deliberately no context_size_hint
      },
      { [VAR_NAME]: '1' },
    );

    assert.equal(
      r.status,
      2,
      `Setting ${VAR_NAME}=1 must not bypass the hard-block; stderr=${r.stderr}`,
    );
  });

  // ── Test 3: var set → context_size_hint_required_failed still emits ────
  test(`${VAR_NAME}=1 → context_size_hint_required_failed event fires`, () => {
    runHook(
      tmpRoot,
      {
        subagent_type: 'developer',
        task_id: 'G04-T3',
        prompt: 'No hint here.',
      },
      { [VAR_NAME]: '1' },
    );

    const events  = readEvents(tmpRoot);
    const required = events.filter(e => e.event_type === 'context_size_hint_required_failed');
    assert.equal(
      required.length,
      1,
      'context_size_hint_required_failed must emit even when (retired) var is set',
    );
  });

});
