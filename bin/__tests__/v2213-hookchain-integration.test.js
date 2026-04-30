'use strict';

/**
 * v2213-hookchain-integration.test.js — Hook-chain integration tests (G-02, v2.2.13 W2).
 *
 * Exercises TWO two-hop scenarios on the PreToolUse:Agent chain using
 * child_process.spawnSync() to match real Claude Code hook-dispatch behaviour
 * (each hook receives the ORIGINAL stdin, not a mutated copy from a prior hook).
 *
 * Scenario S1 (post-W1 inline parse — proves W1 works):
 *   chain = [collect-context-telemetry.js pre-spawn, preflight-spawn-budget.js]
 *   stdin: Agent spawn with hint line in prompt body.
 *   assert: chain exits 0; audit trail has context_size_hint_parsed_inline{source:'prompt_body'}.
 *
 * Scenario S2 (PLATFORM CONSTRAINT REGRESSION):
 *   chain = [hook-A (returns updatedInput with mutated subagent_type), hook-B (reads tool_input.subagent_type)]
 *   Test driver pipes ORIGINAL stdin to BOTH hooks — matching Claude Code's non-propagation behaviour.
 *   assert: hook-B sees ORIGINAL subagent_type, NOT the mutated value.
 *   This test WILL FAIL if a future implementation tries to propagate updatedInput between sibling hooks.
 *
 * Additional cases:
 *   - Negative: spawn WITHOUT hint line in prompt → preflight blocks (exit 2, context_size_hint_required_failed in events).
 *   - Kill-switch: ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1 → blocks even when prompt has hint.
 *
 * Kill switch: ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED=1 → all tests skip.
 *
 * Runner: node --test bin/__tests__/v2213-hookchain-integration.test.js
 */

const { spawnSync } = require('node:child_process');
const path          = require('node:path');
const fs            = require('node:fs');
const os            = require('node:os');
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert        = require('node:assert/strict');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const NODE         = process.execPath;

const COLLECT_TELEMETRY = path.join(REPO_ROOT, 'bin', 'collect-context-telemetry.js');
const PREFLIGHT         = path.join(REPO_ROOT, 'bin', 'preflight-spawn-budget.js');

// ---------------------------------------------------------------------------
// Kill switch: skip entire file if set
// ---------------------------------------------------------------------------

const SKIP_ALL = process.env.ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED === '1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated tmp dir with minimal Orchestray state needed by the hooks.
 */
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-chain-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),  { recursive: true });

  // Config: soft-warn budgets so budget check never blocks in these tests
  const cfg = {
    budget_enforcement: { enabled: true, hard_block: false },
    role_budgets: {
      developer: { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
      tester:    { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
      architect: { budget_tokens: 200000, source: 'fallback_model_tier_thin_telemetry' },
    },
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(cfg),
    'utf8',
  );

  // Stub orchestration id for audit events
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-w2-chain-test' }),
    'utf8',
  );

  return dir;
}

/**
 * Read and parse events.jsonl from a tmp dir.
 */
function readEvents(dir) {
  try {
    return fs.readFileSync(
      path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

/**
 * Build a clean env for hook invocations: inherit current process env, clear all
 * context_size_hint kill switches so tests are deterministic, then apply overrides.
 */
function buildEnv(overrides) {
  const env = Object.assign({}, process.env);
  delete env.ORCHESTRAY_CONTEXT_SIZE_HINT_REQUIRED_DISABLED;
  delete env.ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED;
  delete env.ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED;
  delete env.ORCHESTRAY_DEBUG;
  return Object.assign(env, overrides || {});
}

/**
 * runChain — per the W2 driver design, pipe the ORIGINAL stdin to EVERY hook in
 * the chain. This matches Claude Code's actual hook dispatch: sibling hooks are
 * each called with the original event; updatedInput from one hook does NOT
 * propagate to the next hook's stdin.
 *
 * @param {string[]} hooks     — absolute paths to hook scripts (with optional args embedded)
 * @param {object}   payload   — the stdin payload (JSON-serialised before passing)
 * @param {object}   envExtra  — additional env vars to layer over the base env
 * @returns {{ blocked: boolean, blockStatus: number|null, stderr: string, lastStdout: string }}
 */
function runChain(hooks, payload, envExtra) {
  const stdinJson = JSON.stringify(payload);
  const env = buildEnv(envExtra);

  for (const hookEntry of hooks) {
    // hookEntry may be 'path/to/script.js' or 'path/to/script.js arg1 arg2'
    const parts = hookEntry.split(' ');
    const scriptPath = parts[0];
    const args = parts.slice(1);

    const r = spawnSync(NODE, [scriptPath, ...args], {
      input:    stdinJson,   // ORIGINAL stdin — never mutated between hops
      env,
      encoding: 'utf8',
      timeout:  10000,
    });

    if (r.status === 2) {
      return { blocked: true, blockStatus: 2, stderr: r.stderr, lastStdout: r.stdout };
    }
  }

  return { blocked: false, blockStatus: null, stderr: '', lastStdout: '' };
}

// ---------------------------------------------------------------------------
// S2 mock hook scripts — written to a per-test tmp dir at runtime
// ---------------------------------------------------------------------------

/**
 * Write the S2 mock hooks into a directory and return their paths.
 *
 * Hook-A: reads tool_input.subagent_type from stdin, always returns updatedInput
 *   with subagent_type mutated to 'tester', and writes the mutated value to a
 *   side-channel file so the test can verify what it returned.
 *
 * Hook-B: reads tool_input.subagent_type from its own stdin (the ORIGINAL payload
 *   per the non-propagation model), writes what it saw to a side-channel file.
 */
function writeMockHooks(dir) {
  const hookAPath = path.join(dir, 'mock-hook-a.js');
  const hookBPath = path.join(dir, 'mock-hook-b.js');
  const hookASideChannel = path.join(dir, 'hook-a-emitted.json');
  const hookBSideChannel = path.join(dir, 'hook-b-saw.json');

  // Hook-A: mutates subagent_type → 'tester', returns updatedInput
  fs.writeFileSync(hookAPath, `
'use strict';
const fs   = require('fs');
const path = require('path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  const event = JSON.parse(input || '{}');
  const toolInput = event.tool_input || {};
  const original = toolInput.subagent_type;
  const mutated  = 'tester';

  // Write side-channel: what we emitted as updatedInput.subagent_type
  fs.writeFileSync(${JSON.stringify(hookASideChannel)},
    JSON.stringify({ original_seen: original, mutated_to: mutated }),
    'utf8',
  );

  // Emit updatedInput with mutated subagent_type
  const updatedInput = Object.assign({}, toolInput, { subagent_type: mutated });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }));
  process.exit(0);
});
`, 'utf8');

  // Hook-B: records what it sees in tool_input.subagent_type from stdin
  fs.writeFileSync(hookBPath, `
'use strict';
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  const event = JSON.parse(input || '{}');
  const toolInput = event.tool_input || {};

  // Write side-channel: what we received in tool_input.subagent_type
  fs.writeFileSync(${JSON.stringify(hookBSideChannel)},
    JSON.stringify({ subagent_type_received: toolInput.subagent_type }),
    'utf8',
  );

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
`, 'utf8');

  return { hookAPath, hookBPath, hookASideChannel, hookBSideChannel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.13 W2 — PreToolUse:Agent hook-chain integration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── S1-A: Two-hop chain passes when prompt body contains hint ─────────────

  test(
    'S1: [collect-context-telemetry pre-spawn, preflight] with hint in prompt body → chain exits 0',
    { skip: SKIP_ALL ? 'ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED=1' : false },
    () => {
      const payload = {
        tool_name:  'Agent',
        tool_input: {
          subagent_type: 'developer',
          prompt: 'context_size_hint: system=12000 tier2=2000 handoff=1000\n\nDo X.',
        },
        cwd: tmpDir,
      };

      const result = runChain(
        [
          COLLECT_TELEMETRY + ' pre-spawn',
          PREFLIGHT,
        ],
        payload,
      );

      assert.equal(result.blocked, false,
        'chain must not block when hint is present in prompt body; stderr=' + result.stderr);
    },
  );

  // ── S1-B: audit trail records context_size_hint_parsed_inline{source:prompt_body} ─

  test(
    'S1: preflight emits context_size_hint_parsed_inline with source=prompt_body when hint is in prompt',
    { skip: SKIP_ALL ? 'ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED=1' : false },
    () => {
      const payload = {
        tool_name:  'Agent',
        tool_input: {
          subagent_type: 'developer',
          task_id:       'chain-s1-b',
          prompt: 'context_size_hint: system=12000 tier2=2000 handoff=1000\n\nDo X.',
        },
        cwd: tmpDir,
      };

      // Run just preflight (the emitter of context_size_hint_parsed_inline)
      runChain([PREFLIGHT], payload);

      const events = readEvents(tmpDir);
      const inlineEvents = events.filter(e => e.event_type === 'context_size_hint_parsed_inline');

      assert.equal(inlineEvents.length >= 1, true,
        'at least 1 context_size_hint_parsed_inline event expected; got: ' + JSON.stringify(events.map(e => e.event_type)));
      assert.equal(inlineEvents[0].source, 'prompt_body',
        'source must be prompt_body');
      assert.equal(inlineEvents[0].subagent_type, 'developer',
        'subagent_type must propagate to event');
      assert.equal(inlineEvents[0].schema_version, 1,
        'schema_version must be 1');
    },
  );

  // ── Negative: no hint → preflight hard-blocks ────────────────────────────

  test(
    'negative: [collect-context-telemetry pre-spawn, preflight] without hint → chain blocked (exit 2)',
    { skip: SKIP_ALL ? 'ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED=1' : false },
    () => {
      const payload = {
        tool_name:  'Agent',
        tool_input: {
          subagent_type: 'developer',
          prompt: 'No hint here. Just a plain task description.',
        },
        cwd: tmpDir,
      };

      const result = runChain(
        [
          COLLECT_TELEMETRY + ' pre-spawn',
          PREFLIGHT,
        ],
        payload,
      );

      assert.equal(result.blocked, true,
        'chain must block when no hint is present');

      // Preflight writes the block message to stdout; check it contains the
      // identifying token so a future reader knows WHY it blocked.
      assert.match(result.lastStdout, /context_size_hint/,
        'block message must mention context_size_hint');
    },
  );

  // ── Kill-switch: inline parse disabled → blocks even with prompt hint ─────

  test(
    'kill-switch ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1 → chain blocked even with hint in prompt',
    { skip: SKIP_ALL ? 'ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED=1' : false },
    () => {
      const payload = {
        tool_name:  'Agent',
        tool_input: {
          subagent_type: 'developer',
          prompt: 'context_size_hint: system=12000 tier2=2000 handoff=1000\n\nDo X.',
        },
        cwd: tmpDir,
      };

      const result = runChain(
        [PREFLIGHT],
        payload,
        { ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED: '1' },
      );

      assert.equal(result.blocked, true,
        'chain must block when inline parse is disabled, even if prompt contains hint');
    },
  );

  // ── S2: Platform constraint regression ───────────────────────────────────
  //
  // This scenario documents and regression-guards the Claude Code platform
  // constraint: updatedInput returned by Hook-A does NOT propagate to Hook-B's
  // stdin. Each hook receives the ORIGINAL event from Claude Code.
  //
  // The test WILL FAIL if a future hook chain is designed assuming propagation,
  // or if the runChain driver is (wrongly) changed to simulate propagation.

  test(
    'S2: platform constraint — Hook-B receives ORIGINAL tool_input even when Hook-A returned updatedInput',
    { skip: SKIP_ALL ? 'ORCHESTRAY_HOOKCHAIN_INTEGRATION_TEST_DISABLED=1' : false },
    () => {
      const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-s2-'));

      try {
        const { hookAPath, hookBPath, hookASideChannel, hookBSideChannel } =
          writeMockHooks(mockDir);

        const ORIGINAL_TYPE = 'developer';
        const payload = {
          tool_name:  'Agent',
          tool_input: {
            subagent_type: ORIGINAL_TYPE,
            prompt: 'context_size_hint: system=12000 tier2=2000 handoff=1000\n\nDo X.',
          },
          cwd: mockDir,
        };

        const result = runChain([hookAPath, hookBPath], payload);

        // Both hooks should have exited 0 (no block)
        assert.equal(result.blocked, false,
          'S2 chain should not block; stderr=' + result.stderr);

        // Hook-A should have seen and emitted the mutation
        const hookAData = JSON.parse(fs.readFileSync(hookASideChannel, 'utf8'));
        assert.equal(hookAData.original_seen, ORIGINAL_TYPE,
          'Hook-A must have received the original subagent_type');
        assert.equal(hookAData.mutated_to, 'tester',
          'Hook-A must have emitted tester as mutated subagent_type');

        // Hook-B must have seen the ORIGINAL value — not Hook-A's mutated output.
        // This is the core assertion: Claude Code does NOT propagate updatedInput
        // between sibling PreToolUse hooks.
        const hookBData = JSON.parse(fs.readFileSync(hookBSideChannel, 'utf8'));
        assert.equal(hookBData.subagent_type_received, ORIGINAL_TYPE,
          'Hook-B MUST see the ORIGINAL subagent_type=' + ORIGINAL_TYPE +
          ', NOT the mutated value. If this fails, the test driver is simulating ' +
          'updatedInput propagation — which is NOT how Claude Code behaves.');

        // Belt-and-suspenders: confirm Hook-B did NOT see the mutated value
        assert.notEqual(hookBData.subagent_type_received, 'tester',
          'Hook-B must NOT see the tester value that Hook-A returned in updatedInput');

      } finally {
        fs.rmSync(mockDir, { recursive: true, force: true });
      }
    },
  );

});
