#!/usr/bin/env node
'use strict';

/**
 * v223-haiku-routing-fix.test.js — v2.2.3 P0-1 Haiku-routing fix coverage.
 *
 * Validates three independent fixes:
 *   Fix A1: PM tools allowlist now includes haiku-scout + orchestray-housekeeper
 *           (Claude Code subagent dispatch precondition).
 *   Fix A2: Resolver CANONICAL_AGENTS_ALLOWLIST now includes the four Haiku-default
 *           agents — Stage-2 frontmatter resolution actually fires for them.
 *   Fix B:  bin/migrate-routing-jsonl.js purges stale routing.jsonl entries
 *           where the seeded model conflicts with agent frontmatter.
 *   Fix C:  model_auto_resolved event carries `path_trace` array.
 *
 * Run: `node --require tests/helpers/setup.js --test bin/__tests__/v223-haiku-routing-fix.test.js`
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js');
const MIGRATOR = path.join(REPO_ROOT, 'bin', 'migrate-routing-jsonl.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create an isolated tmpdir simulating an orchestration. Mirrors helper from
 * tests/agent-spawn-auto-resolve.test.js so the resolver behaves identically
 * under test.
 */
function makeOrchDir({ orchId = 'orch-test-v223-p1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-haiku-routing-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
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

function writeAgentFrontmatter(dir, agentType, modelValue) {
  const fm = '---\nname: ' + agentType + '\nmodel: ' + modelValue + '\neffort: low\n---\n\nbody\n';
  fs.writeFileSync(path.join(dir, 'agents', agentType + '.md'), fm);
}

function runGate(dir, payloadOverrides = {}) {
  const payload = {
    tool_name: 'Agent',
    cwd: dir,
    tool_input: Object.assign({
      subagent_type: 'developer',
      description: 'V223-1 sample task',
    }, payloadOverrides),
  };
  const r = spawnSync(process.execPath, [GATE_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readEvents(dir) {
  const evPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(evPath)) return [];
  return fs.readFileSync(evPath, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fix A1 — PM tools allowlist contains the four Haiku-related dispatch types
// ---------------------------------------------------------------------------

describe('Fix A1 — PM tools allowlist includes Haiku agents', () => {
  test('agents/pm.md `tools:` line lists haiku-scout and orchestray-housekeeper', () => {
    const pmContent = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'pm.md'), 'utf8');
    const toolsLine = pmContent.split('\n').find(l => l.startsWith('tools:'));
    assert.ok(toolsLine, 'PM file must have a tools: line');
    // Both must appear inside the Agent(...) cluster
    const agentMatch = toolsLine.match(/Agent\(([^)]+)\)/);
    assert.ok(agentMatch, 'tools: line must include Agent(...) cluster');
    const agentList = agentMatch[1];
    assert.match(agentList, /\bhaiku-scout\b/, 'haiku-scout must be in PM Agent allowlist');
    assert.match(agentList, /\borchestray-housekeeper\b/, 'orchestray-housekeeper must be in PM Agent allowlist');
    assert.match(agentList, /\bproject-intent\b/, 'project-intent must remain in PM Agent allowlist');
  });
});

// ---------------------------------------------------------------------------
// Fix A2 — resolver Stage-2 fires for Haiku-default agents
// ---------------------------------------------------------------------------

describe('Fix A2 — resolver Stage-2 fires for canonical Haiku agents', () => {
  for (const agentType of ['haiku-scout', 'orchestray-housekeeper', 'project-intent', 'pattern-extractor']) {
    test(agentType + ' resolves to haiku via frontmatter_default', () => {
      const dir = makeOrchDir();
      writeAgentFrontmatter(dir, agentType, 'haiku');
      const { status, stderr } = runGate(dir, {
        subagent_type: agentType,
        description: 'V223-2 ' + agentType + ' resolve test',
      });
      assert.equal(status, 0, 'gate should exit 0; stderr: ' + stderr);
      assert.match(stderr, /auto-resolved from agents\//,
        agentType + ' should hit Stage-2 frontmatter (got stderr: ' + stderr + ')');
      assert.match(stderr, /"haiku"/,
        agentType + ' Stage-2 should resolve to haiku');

      const events = readEvents(dir);
      const resolveEvents = events.filter(e =>
        (e.type === 'model_auto_resolved' || e.event === 'model_auto_resolved') &&
        e.subagent_type === agentType
      );
      assert.ok(resolveEvents.length > 0, 'expected model_auto_resolved event for ' + agentType);
      const ev = resolveEvents[resolveEvents.length - 1];
      assert.equal(ev.resolved_model, 'haiku', agentType + ' resolved_model must be haiku');
      assert.equal(ev.source, 'frontmatter_default', agentType + ' source must be frontmatter_default');
    });
  }
});

// ---------------------------------------------------------------------------
// Fix C — path_trace populated on every model_auto_resolved event
// ---------------------------------------------------------------------------

describe('Fix C — model_auto_resolved.path_trace telemetry', () => {
  test('Stage-2 frontmatter hit produces stage1+stage2 trace markers', () => {
    const dir = makeOrchDir();
    writeAgentFrontmatter(dir, 'haiku-scout', 'haiku');
    runGate(dir, { subagent_type: 'haiku-scout', description: 'V223-3 trace' });
    const events = readEvents(dir).filter(e =>
      (e.type === 'model_auto_resolved' || e.event === 'model_auto_resolved') &&
      e.subagent_type === 'haiku-scout'
    );
    assert.ok(events.length > 0, 'expected event');
    const trace = events[events.length - 1].path_trace;
    assert.ok(Array.isArray(trace), 'path_trace must be an array');
    assert.ok(trace.includes('stage1_entered'), 'trace must include stage1_entered');
    assert.ok(trace.includes('stage2_entered'), 'trace must include stage2_entered');
    assert.ok(trace.includes('stage2_frontmatter_hit'), 'trace must include stage2_frontmatter_hit');
    assert.ok(!trace.includes('stage3_default'), 'trace must NOT reach stage3_default on a frontmatter hit');
  });

  test('Stage-3 default produces stage1+stage2_allowlist_miss+stage3 trace', () => {
    const dir = makeOrchDir();
    // Use a non-canonical agent type → Stage-2 allowlist miss → Stage-3.
    runGate(dir, { subagent_type: 'nonexistent_custom_agent', description: 'V223-4 trace' });
    const events = readEvents(dir).filter(e =>
      (e.type === 'model_auto_resolved' || e.event === 'model_auto_resolved') &&
      e.subagent_type === 'nonexistent_custom_agent'
    );
    assert.ok(events.length > 0, 'expected event');
    const trace = events[events.length - 1].path_trace;
    assert.ok(trace.includes('stage1_entered'), 'stage1 must be entered');
    assert.ok(trace.includes('stage2_entered'), 'stage2 must be entered');
    assert.ok(trace.includes('stage2_allowlist_miss'), 'non-canonical type should mark allowlist miss');
    assert.ok(trace.includes('stage3_default'), 'should reach stage3_default');
  });
});

// ---------------------------------------------------------------------------
// Fix B — routing.jsonl migrator
// ---------------------------------------------------------------------------

describe('Fix B — bin/migrate-routing-jsonl.js purges stale entries', () => {
  test('purges entry where seeded model conflicts with frontmatter', () => {
    const dir = makeOrchDir();
    writeAgentFrontmatter(dir, 'haiku-scout', 'haiku');
    // Seed a routing.jsonl row with sonnet for haiku-scout — the bug case.
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    fs.writeFileSync(routingPath, JSON.stringify({
      timestamp: '2026-04-26T10:00:00Z',
      orchestration_id: 'orch-prior',
      task_id: 'X1',
      agent_type: 'haiku-scout',
      description: 'X1 stale entry',
      model: 'sonnet',
      effort: 'medium',
    }) + '\n');
    // Also include a CORRECTLY-seeded entry that must survive.
    fs.appendFileSync(routingPath, JSON.stringify({
      timestamp: '2026-04-26T10:01:00Z',
      orchestration_id: 'orch-prior',
      task_id: 'Y1',
      agent_type: 'developer',
      description: 'Y1 ok entry',
      model: 'sonnet',
      effort: 'medium',
    }) + '\n');
    // developer agent file with model: inherit (matches reviewer.md pattern); migrator
    // should KEEP this row because frontmatter is non-concrete.
    writeAgentFrontmatter(dir, 'developer', 'inherit');

    const r = spawnSync(process.execPath, [MIGRATOR, dir], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 0, 'migrator exit 0; stderr: ' + r.stderr);

    const survivors = fs.readFileSync(routingPath, 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
    const haikuScoutSurvivors = survivors.filter(e => e.agent_type === 'haiku-scout');
    const devSurvivors = survivors.filter(e => e.agent_type === 'developer');
    assert.equal(haikuScoutSurvivors.length, 0, 'stale haiku-scout entry must be purged');
    assert.equal(devSurvivors.length, 1, 'developer entry with inherit frontmatter must survive');

    // Verify audit event.
    const events = readEvents(dir);
    const purgeEvents = events.filter(e =>
      (e.type === 'routing_jsonl_migrator_purge' || e.event === 'routing_jsonl_migrator_purge') &&
      e.subagent_type === 'haiku-scout'
    );
    assert.ok(purgeEvents.length === 1, 'expected exactly one purge event for haiku-scout');
    assert.equal(purgeEvents[0].seeded_model, 'sonnet');
    assert.equal(purgeEvents[0].frontmatter_model, 'haiku');

    // Sentinel must be written.
    const sentinel = path.join(dir, '.orchestray', 'state', '.routing-jsonl-migrated-v223');
    assert.ok(fs.existsSync(sentinel), 'sentinel file must be written');
  });

  test('idempotent — sentinel prevents re-runs', () => {
    const dir = makeOrchDir();
    writeAgentFrontmatter(dir, 'haiku-scout', 'haiku');
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    fs.writeFileSync(routingPath, JSON.stringify({
      timestamp: '2026-04-26T10:00:00Z',
      orchestration_id: 'orch-prior',
      task_id: 'X1',
      agent_type: 'haiku-scout',
      description: 'X1',
      model: 'sonnet',
    }) + '\n');

    const first = spawnSync(process.execPath, [MIGRATOR, dir], { encoding: 'utf8' });
    assert.equal(first.status, 0);
    const purgeMatch = (first.stderr || '').match(/purged 1 stale/);
    assert.ok(purgeMatch, 'first run should announce purge: ' + first.stderr);

    // Re-seed a stale entry — second run should NOT touch it (sentinel guards).
    fs.appendFileSync(routingPath, JSON.stringify({
      timestamp: '2026-04-27T10:00:00Z',
      orchestration_id: 'orch-prior2',
      task_id: 'X2',
      agent_type: 'haiku-scout',
      description: 'X2',
      model: 'sonnet',
    }) + '\n');

    const second = spawnSync(process.execPath, [MIGRATOR, dir], { encoding: 'utf8' });
    assert.equal(second.status, 0);
    const survivors = fs.readFileSync(routingPath, 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
    // The freshly-added stale entry should still be there — sentinel prevented re-sweep.
    assert.ok(survivors.some(e => e.task_id === 'X2'),
      'sentinel-guarded second run must not re-sweep new entries');
  });

  test('keeps entries when agent frontmatter declares model: inherit', () => {
    const dir = makeOrchDir();
    writeAgentFrontmatter(dir, 'reviewer', 'inherit');
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    fs.writeFileSync(routingPath, JSON.stringify({
      timestamp: '2026-04-26T10:00:00Z',
      orchestration_id: 'orch-prior',
      task_id: 'R1',
      agent_type: 'reviewer',
      description: 'R1',
      model: 'sonnet',
    }) + '\n');

    spawnSync(process.execPath, [MIGRATOR, dir], { encoding: 'utf8' });

    const survivors = fs.readFileSync(routingPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(survivors.length, 1, 'inherit-frontmatter entry must survive');
  });

  test('no routing.jsonl → exit 0, sentinel written, no error', () => {
    const dir = makeOrchDir();
    const r = spawnSync(process.execPath, [MIGRATOR, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const sentinel = path.join(dir, '.orchestray', 'state', '.routing-jsonl-migrated-v223');
    assert.ok(fs.existsSync(sentinel), 'sentinel must be written even when no routing.jsonl');
  });

  test('malformed jsonl line is preserved (not silently dropped)', () => {
    const dir = makeOrchDir();
    writeAgentFrontmatter(dir, 'haiku-scout', 'haiku');
    const routingPath = path.join(dir, '.orchestray', 'state', 'routing.jsonl');
    fs.writeFileSync(routingPath,
      'not-json-garbage\n' +
      JSON.stringify({
        timestamp: '2026-04-26T10:00:00Z',
        orchestration_id: 'orch-prior',
        task_id: 'X1',
        agent_type: 'haiku-scout',
        description: 'X1',
        model: 'sonnet',
      }) + '\n'
    );

    spawnSync(process.execPath, [MIGRATOR, dir], { encoding: 'utf8' });

    const lines = fs.readFileSync(routingPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.includes('not-json-garbage'),
      'malformed line must be preserved (data-loss safety)');
    // The valid stale entry was purged.
    assert.equal(lines.length, 1, 'expected only the malformed line to remain');
  });
});

// ---------------------------------------------------------------------------
// Fix D — Frontmatter sanity for the four Haiku agents
// ---------------------------------------------------------------------------

describe('Fix D — Haiku agent frontmatter unchanged and correct', () => {
  for (const agentType of ['haiku-scout', 'orchestray-housekeeper', 'project-intent', 'pattern-extractor']) {
    test(agentType + ' has model: haiku and effort: low', () => {
      const filePath = path.join(REPO_ROOT, 'agents', agentType + '.md');
      const content = fs.readFileSync(filePath, 'utf8');
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fm, agentType + ' must have YAML frontmatter');
      const fmBlock = fm[1];
      assert.match(fmBlock, /^model:\s*haiku\s*$/m, agentType + ' must declare model: haiku');
      assert.match(fmBlock, /^effort:\s*low\s*$/m, agentType + ' must declare effort: low');
    });
  }
});
