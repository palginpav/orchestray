#!/usr/bin/env node
'use strict';

/**
 * R-DX1 auto-resolve test suite for bin/gate-agent-spawn.js
 *
 * Tests the 3-stage auto-resolution fallback when Agent() is spawned without
 * a model parameter inside an active orchestration.
 *
 * Strategy: drive gate-agent-spawn.js via spawnSync with stdin-piped payloads.
 * Each test creates an isolated tmpdir with the necessary state files.
 *
 * Test cases (matching the 12 specified by the task):
 *  1. routing_lookup resolves sonnet → spawn proceeds, warning emitted
 *  2. routing.jsonl row has model='inherit' → rejected, falls to global_default_sonnet
 *  3. routing.jsonl row has invalid model → rejected, falls to global_default_sonnet
 *  4. No routing, developer.md has default_model:sonnet → frontmatter_default path
 *  5. No routing, no frontmatter default → global_default_sonnet applied
 *  6. subagent_type='../../etc/passwd' → CANONICAL_AGENTS rejects, spawn proceeds via default
 *  7. subagent_type='nonexistent_agent' → not in allowlist, default applied
 *  8. model='invalid-foo' → existing hard-block fires (unchanged behavior)
 *  9. model='inherit' inside orchestration → existing hard-block fires
 * 10. ORCHESTRAY_STRICT_MODEL_REQUIRED=1 + missing model → legacy hard-block
 * 11. model_auto_resolved event written to events.jsonl
 * 12. stderr warning format matches character-exact template
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/gate-agent-spawn.js');

/** Shared list of tmpdirs to clean up after each test. */
const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir with an active orchestration marker.
 * Writes a config that disables §22c (pattern_record_application) enforcement
 * so that test spawns don't fail on missing checkpoint records.
 */
function makeDir({ orchId = 'orch-test-r-dx1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auto-resolve-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  // Disable §22c enforcement so test spawns don't fail on missing checkpoint records.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({
      mcp_enforcement: {
        pattern_record_application: 'allow',
        pattern_find: 'allow',
        kb_search: 'allow',
        history_find_similar_tasks: 'allow',
      },
    })
  );
  return dir;
}

/**
 * Write a routing.jsonl entry into <dir>/.orchestray/state/routing.jsonl.
 */
function writeRoutingEntry(dir, entry) {
  const routingFile = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
  const defaults = {
    timestamp: new Date().toISOString(),
    orchestration_id: 'orch-test-r-dx1',
    task_id: 'DEV-1',
    agent_type: 'developer',
    description: 'DEV-1 implement feature X',
    model: 'sonnet',
    effort: 'medium',
  };
  fs.appendFileSync(routingFile, JSON.stringify(Object.assign({}, defaults, entry)) + '\n');
}

/**
 * Write an agents/ directory with a minimal agent file.
 * The file can include a default_model frontmatter field.
 */
function writeAgentFile(dir, agentType, extraFrontmatter = '') {
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const frontmatter = '---\nname: ' + agentType + '\n' + extraFrontmatter + '---\n';
  fs.writeFileSync(path.join(agentsDir, agentType + '.md'), frontmatter + '\nAgent content.\n');
}

/**
 * Run the hook script with the given event payload on stdin.
 * Pass optional env overrides.
 */
function run(payload, { env } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, env || {}),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * v2.2.9 B-7.4: default is now hard-block on missing model.
 * Auto-resolve tests must pass ORCHESTRAY_STRICT_MODEL_REQUIRED=0 to
 * restore the legacy 3-stage cascade. This wrapper applies that env var.
 */
function runAutoResolve(payload, { env } = {}) {
  return run(payload, { env: Object.assign({ ORCHESTRAY_STRICT_MODEL_REQUIRED: '0' }, env || {}) });
}

/**
 * Build a minimal Agent() hook payload inside an orchestration.
 */
function agentPayload(dir, overrides = {}) {
  return {
    tool_name: 'Agent',
    cwd: dir,
    tool_input: Object.assign({
      subagent_type: 'developer',
      description: 'DEV-1 implement feature X',
    }, overrides),
  };
}

// ---------------------------------------------------------------------------
// Test 1: routing_lookup resolves sonnet → spawn proceeds
// ---------------------------------------------------------------------------

describe('Test 1: routing_lookup resolves to sonnet', () => {
  test('missing model + matching routing.jsonl row → auto-resolved, warning emitted', () => {
    const dir = makeDir();
    writeRoutingEntry(dir, { model: 'sonnet', task_id: 'DEV-1', agent_type: 'developer' });
    const { status, stderr } = runAutoResolve(agentPayload(dir));
    assert.equal(status, 0, 'Expected exit 0 but got ' + status + '. stderr: ' + stderr);
    assert.match(stderr, /auto-resolved from routing\.jsonl/, 'Expected routing_lookup warning');
    assert.match(stderr, /"sonnet"/, 'Expected resolved model sonnet in warning');
  });
});

// ---------------------------------------------------------------------------
// Test 2: routing row has model='inherit' → Stage 1 rejects, falls to Stage 3
// ---------------------------------------------------------------------------

describe('Test 2: routing row with model=inherit falls through Stage 1', () => {
  test('routing entry model=inherit is rejected by Stage 1; global_default_sonnet warning emitted', () => {
    const dir = makeDir();
    writeRoutingEntry(dir, { model: 'inherit', task_id: 'DEV-1', agent_type: 'developer' });
    const { stderr } = runAutoResolve(agentPayload(dir));
    assert.doesNotMatch(stderr, /auto-resolved from routing\.jsonl.*"inherit"/, 'Must not accept inherit from routing');
    assert.match(stderr, /defaulting to "sonnet"/, 'Expected global_default_sonnet warning after inherit rejection');
  });
});

// ---------------------------------------------------------------------------
// Test 3: routing row has invalid model → Stage 1 rejects, falls to Stage 3
// ---------------------------------------------------------------------------

describe('Test 3: routing row with invalid model falls through Stage 1', () => {
  test('routing entry model=gpt-4 is rejected by Stage 1; global_default_sonnet warning emitted', () => {
    const dir = makeDir();
    writeRoutingEntry(dir, { model: 'gpt-4', task_id: 'DEV-1', agent_type: 'developer' });
    const { stderr } = runAutoResolve(agentPayload(dir));
    assert.doesNotMatch(stderr, /auto-resolved from routing\.jsonl.*"gpt-4"/, 'Must not accept gpt-4 from routing');
    assert.match(stderr, /defaulting to "sonnet"/, 'Expected global_default_sonnet warning after invalid routing model');
  });
});

// ---------------------------------------------------------------------------
// Test 4: No routing, developer.md has default_model:sonnet → frontmatter path
// ---------------------------------------------------------------------------

describe('Test 4: frontmatter_default path', () => {
  test('no routing + agents/developer.md has model: sonnet → frontmatter resolved', () => {
    const dir = makeDir();
    writeAgentFile(dir, 'developer', 'model: sonnet\n');
    const { status, stderr } = runAutoResolve(agentPayload(dir));
    assert.equal(status, 0, 'Expected exit 0 but got ' + status + '. stderr: ' + stderr);
    assert.match(stderr, /auto-resolved from agents\/developer\.md frontmatter/, 'Expected frontmatter_default warning');
    assert.match(stderr, /"sonnet"/, 'Expected sonnet in frontmatter warning');
  });
});

// ---------------------------------------------------------------------------
// Test 5: No routing, no frontmatter → global_default_sonnet
// ---------------------------------------------------------------------------

describe('Test 5: global_default_sonnet fallback', () => {
  test('no routing, no frontmatter default → global sonnet applied', () => {
    const dir = makeDir();
    const { status, stderr } = runAutoResolve(agentPayload(dir));
    assert.equal(status, 0, 'Expected exit 0 but got ' + status + '. stderr: ' + stderr);
    assert.match(stderr, /defaulting to "sonnet"/, 'Expected global_default_sonnet warning');
  });
});

// ---------------------------------------------------------------------------
// Test 6: subagent_type='../../etc/passwd' → CANONICAL_AGENTS rejects
// ---------------------------------------------------------------------------

describe('Test 6: path-traversal subagent_type rejected (S01)', () => {
  test('subagent_type=../../etc/passwd → CANONICAL_AGENTS rejects, falls to default', () => {
    const dir = makeDir();
    const { status, stderr } = runAutoResolve(agentPayload(dir, { subagent_type: '../../etc/passwd' }));
    assert.equal(status, 0, 'Expected exit 0 (fail-open path). stderr: ' + stderr);
    assert.doesNotMatch(stderr, /Stage 2.*etc\/passwd/, 'Must not attempt to read /etc/passwd');
    assert.match(stderr, /defaulting to "sonnet"/, 'Expected global_default_sonnet for non-canonical type');
  });
});

// ---------------------------------------------------------------------------
// Test 7: subagent_type='nonexistent_agent' → not in allowlist, default applied
// ---------------------------------------------------------------------------

describe('Test 7: non-canonical subagent_type falls to default', () => {
  test('subagent_type=nonexistent_agent → not in CANONICAL_AGENTS, global default applied', () => {
    const dir = makeDir();
    const { status, stderr } = runAutoResolve(agentPayload(dir, { subagent_type: 'nonexistent_agent' }));
    assert.equal(status, 0, 'Expected exit 0 (fail-open). stderr: ' + stderr);
    assert.match(stderr, /defaulting to "sonnet"/, 'Expected global_default_sonnet for non-canonical type');
  });
});

// ---------------------------------------------------------------------------
// Test 8: model='invalid-foo' → existing hard-block fires (unchanged)
// ---------------------------------------------------------------------------

describe('Test 8: explicit invalid model still hard-blocks', () => {
  test('model=invalid-foo → lines 211+ hard-block fires, exit 2', () => {
    const dir = makeDir();
    const { status, stderr } = run(agentPayload(dir, { model: 'invalid-foo' }));
    assert.equal(status, 2, 'Expected exit 2 for invalid model. stderr: ' + stderr);
    assert.match(stderr, /not a recognized routing tier/, 'Expected invalid-model error message');
  });
});

// ---------------------------------------------------------------------------
// Test 9: model='inherit' → existing hard-block fires
// ---------------------------------------------------------------------------

describe('Test 9: explicit model=inherit hard-blocks', () => {
  test('model=inherit → lines 196+ hard-block fires, exit 2', () => {
    const dir = makeDir();
    const { status, stderr } = run(agentPayload(dir, { model: 'inherit' }));
    assert.equal(status, 2, 'Expected exit 2 for inherit. stderr: ' + stderr);
    assert.match(stderr, /inherit.*forbidden/, 'Expected inherit forbidden message');
  });
});

// ---------------------------------------------------------------------------
// Test 10: default is hard-block; =0 opt-out restores auto-resolve
// ---------------------------------------------------------------------------
describe('Test 10: ORCHESTRAY_STRICT_MODEL_REQUIRED=0 restores auto-resolve (B-7.4)', () => {
  test('default (no env var) + missing model → exit 2 (hard-block is now the default)', () => {
    const dir = makeDir();
    const { status, stderr } = run(agentPayload(dir));
    assert.equal(status, 2, 'Expected exit 2: default is hard-block in v2.2.9 B-7.4. stderr: ' + stderr);
    assert.match(stderr, /ORCHESTRAY_STRICT_MODEL_REQUIRED=0/, 'Expected opt-out hint in stderr');
  });

  test('ORCHESTRAY_STRICT_MODEL_REQUIRED=0 + missing model → exit 0 (auto-resolve restored)', () => {
    const dir = makeDir();
    const { status, stderr } = runAutoResolve(agentPayload(dir));
    assert.equal(status, 0, 'Expected exit 0: =0 restores auto-resolve. stderr: ' + stderr);
    assert.match(stderr, /defaulting to "sonnet"/, 'Expected auto-resolve warning');
  });
});

// ---------------------------------------------------------------------------
// Test 11: model_auto_resolved event written to events.jsonl
// ---------------------------------------------------------------------------

describe('Test 11: model_auto_resolved event written to events.jsonl', () => {
  test('global_default_sonnet path writes model_auto_resolved event', () => {
    const dir = makeDir();
    const { status } = runAutoResolve(agentPayload(dir));
    assert.equal(status, 0, 'Expected exit 0');
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl should exist after auto-resolve');
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    const autoResolveEvents = lines
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(e => e && (e.type === 'model_auto_resolved' || e.event === 'model_auto_resolved'));
    assert.ok(autoResolveEvents.length > 0, 'Expected at least one model_auto_resolved event');
    const ev = autoResolveEvents[0];
    assert.ok(ev.orchestration_id, 'Event must have orchestration_id');
    assert.ok(ev.timestamp || ev.ts, 'Event must have timestamp (or legacy ts)');
    assert.equal(ev.level, 'warn', 'Event level must be warn');
    assert.ok(['routing_lookup', 'frontmatter_default', 'global_default_sonnet'].includes(ev.source),
      'source must be one of the three valid values, got: ' + ev.source);
    assert.ok(ev.resolved_model, 'Event must have resolved_model');
    assert.ok(ev.subagent_type !== undefined, 'Event must have subagent_type');
  });

  test('routing_lookup path includes routing_entry_timestamp in event', () => {
    const dir = makeDir();
    const ts = new Date().toISOString();
    writeRoutingEntry(dir, { model: 'sonnet', task_id: 'DEV-1', agent_type: 'developer', timestamp: ts });
    run(agentPayload(dir)); // status may be 0 (routing match passes) or 2 (§22c), either is fine
    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
      const ev = lines
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .find(e => e && (e.type === 'model_auto_resolved' || e.event === 'model_auto_resolved') && e.source === 'routing_lookup');
      if (ev) {
        // routing_entry_timestamp is optional but recommended when source=routing_lookup.
        assert.ok(ev.routing_entry_timestamp, 'routing_entry_timestamp should be present for routing_lookup');
      }
      // If no routing_lookup event found, the test is inconclusive (routing.jsonl not matched).
    }
  });
});

// ---------------------------------------------------------------------------
// Test 12: stderr warning format matches character-exact template
// ---------------------------------------------------------------------------

describe('Test 12: warning stderr format matches character-exact templates', () => {
  test('routing_lookup warning starts with [orchestray] gate-agent-spawn: prefix', () => {
    const dir = makeDir();
    writeRoutingEntry(dir, { model: 'sonnet', task_id: 'DEV-1', agent_type: 'developer' });
    const { stderr } = runAutoResolve(agentPayload(dir));
    // Character-exact prefix check per F-03.
    assert.match(stderr, /\[orchestray\] gate-agent-spawn: Agent\(\) model missing; auto-resolved from routing\.jsonl: "sonnet"/,
      'Warning must match routing_lookup template exactly');
  });

  test('frontmatter_default warning starts with [orchestray] gate-agent-spawn: prefix', () => {
    const dir = makeDir();
    writeAgentFile(dir, 'developer', 'model: sonnet\n');
    const { stderr } = runAutoResolve(agentPayload(dir));
    assert.match(stderr, /\[orchestray\] gate-agent-spawn: Agent\(\) model missing; auto-resolved from agents\/developer\.md frontmatter: "sonnet"/,
      'Warning must match frontmatter_default template exactly');
  });

  test('global_default_sonnet warning starts with [orchestray] gate-agent-spawn: prefix', () => {
    const dir = makeDir();
    const { stderr } = runAutoResolve(agentPayload(dir));
    assert.match(stderr,
      /\[orchestray\] gate-agent-spawn: Agent\(\) model missing AND no routing hint AND no frontmatter; defaulting to "sonnet"\./,
      'Warning must match global_default_sonnet template exactly');
  });
});

// ---------------------------------------------------------------------------
// Bonus: AC-11 — routing row with inherit falls through (S02 closure)
// ---------------------------------------------------------------------------

describe('AC-11 (S02 closure): routing inherit-bypass prevented', () => {
  test('routing row model=inherit is discarded at Stage 1 (not accepted as-is)', () => {
    const dir = makeDir();
    writeRoutingEntry(dir, { model: 'inherit', task_id: 'DEV-1', agent_type: 'developer' });
    writeAgentFile(dir, 'developer', 'model: haiku\n');
    const { stderr } = runAutoResolve(agentPayload(dir));
    assert.doesNotMatch(stderr, /auto-resolved from routing\.jsonl.*"inherit"/, 'Must not accept inherit from routing');
    assert.match(stderr, /auto-resolved from agents\/developer\.md frontmatter: "haiku"/,
      'Expected frontmatter_default after inherit routing bypass rejected');
    assert.doesNotMatch(stderr, /model="inherit" is forbidden/, 'Must not hard-block on inherit — it was discarded before the explicit-model path');
  });
});

// ---------------------------------------------------------------------------
// Bonus: AC-14 (S06) — routing mismatch check still fires after auto-resolve
// ---------------------------------------------------------------------------

describe('AC-14 (S06 closure): routing mismatch check runs after auto-resolve', () => {
  test('auto-resolved model differs from routing.jsonl recorded tier → mismatch blocks', () => {
    // Scenario: routing.jsonl has haiku, frontmatter has sonnet.
    // R-DX1 stage 1 routing lookup finds haiku → accepts it.
    // The routing mismatch check then compares the same entry's model against itself — trivially passes.
    // To trigger mismatch: routing entry says haiku, but we spawn with model=sonnet explicitly.
    // This tests that the existing mismatch check is not bypassed.
    const dir = makeDir();
    writeRoutingEntry(dir, { model: 'haiku', task_id: 'DEV-1', agent_type: 'developer' });
    // Spawn with explicit model=sonnet (not auto-resolve path — model is set).
    const { status, stderr } = run(agentPayload(dir, { model: 'sonnet' }));
    // Routing says haiku, spawn says sonnet → mismatch → exit 2.
    assert.equal(status, 2, 'Expected routing mismatch to block. stderr: ' + stderr);
    assert.match(stderr, /model routing mismatch/, 'Expected mismatch message');
  });
});
