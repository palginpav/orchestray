#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/record-mcp-checkpoint.js
 *
 * PostToolUse:mcp__orchestray__* hook — writes checkpoint rows to both
 * .orchestray/state/mcp-checkpoint.jsonl (operational ledger) and
 * .orchestray/audit/events.jsonl (sealed audit trail).
 *
 * Coverage:
 *   D2 step 3 — orchestration_id from current-orchestration.json anchor
 *   D2 step 3 — phase derivation from routing.jsonl presence
 *   D4 item 1 — dual-write to ledger + events.jsonl
 *   D4 item 1 PII discipline — tool_input fields must NOT be written
 *   Smoke: fabricated ledger rows satisfy the gate
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/record-mcp-checkpoint.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir with the standard .orchestray layout.
 * withOrch=true writes current-orchestration.json.
 * withRouting=true writes an empty routing.jsonl to mark post-decomposition.
 */
function makeDir({ withOrch = false, orchestrationId = 'orch-test-001', withRouting = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-chk-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  if (withOrch) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchestrationId })
    );
  }
  if (withRouting) {
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), '');
  }
  return { dir, auditDir, stateDir };
}

function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// D2 step 3 — orchestration_id anchor from current-orchestration.json
// ---------------------------------------------------------------------------

describe('D2 step 3 — orchestration_id anchor', () => {

  test('writer reads current-orchestration.json and includes the id in the checkpoint row', () => {
    const { dir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-anchor-007' });
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_result: { isError: false },
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1, 'Should write exactly one checkpoint row');
    assert.equal(rows[0].orchestration_id, 'orch-anchor-007',
      'orchestration_id must come from current-orchestration.json');
  });

  test('writer exits 0 and writes nothing when current-orchestration.json is absent', () => {
    const { dir, stateDir } = makeDir({ withOrch: false });
    const { status } = run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_result: { isError: false },
    });
    assert.equal(status, 0, 'Must exit 0 (fail-open) when not in orchestration');
    assert.equal(
      fs.existsSync(path.join(stateDir, 'mcp-checkpoint.jsonl')),
      false,
      'Must not create checkpoint ledger when outside orchestration'
    );
  });

});

// ---------------------------------------------------------------------------
// D2 step 3 — phase derivation from routing.jsonl presence
// ---------------------------------------------------------------------------

describe('D2 step 3 — phase derivation', () => {

  test('phase is "pre-decomposition" when routing.jsonl is absent', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    // routing.jsonl does NOT exist — pre-decomposition window
    run({
      tool_name: 'mcp__orchestray__kb_search',
      cwd: dir,
      tool_result: { isError: false },
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'pre-decomposition',
      'phase must be pre-decomposition when routing.jsonl does not exist');
  });

  test('phase is "post-decomposition" when routing.jsonl is present', () => {
    const { dir, stateDir } = makeDir({ withOrch: true, withRouting: true });
    // routing.jsonl exists — post-decomposition window
    run({
      tool_name: 'mcp__orchestray__kb_search',
      cwd: dir,
      tool_result: { isError: false },
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'post-decomposition',
      'phase must be post-decomposition when routing.jsonl exists');
  });

});

// ---------------------------------------------------------------------------
// D4 item 1 — dual-write to both ledger and events.jsonl
// ---------------------------------------------------------------------------

describe('D4 item 1 — dual-write', () => {

  test('writes to both mcp-checkpoint.jsonl and events.jsonl on a pattern_find call', () => {
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_result: { isError: false, structuredContent: { count: 3 } },
    });

    // Ledger row
    const ledger = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(ledger.length, 1, 'Ledger must have exactly one row');
    const ledgerRow = ledger[0];
    assert.equal(ledgerRow.tool, 'pattern_find');
    assert.equal(ledgerRow.outcome, 'answered');
    assert.equal(ledgerRow.phase, 'pre-decomposition');
    assert.ok(!isNaN(Date.parse(ledgerRow.timestamp)), 'timestamp must be valid ISO 8601');

    // Audit event row
    const events = readJsonlFile(path.join(auditDir, 'events.jsonl'));
    assert.equal(events.length, 1, 'events.jsonl must have exactly one row');
    const auditRow = events[0];
    assert.equal(auditRow.type, 'mcp_checkpoint_recorded');
    assert.equal(auditRow.tool, 'pattern_find');
    assert.equal(auditRow.source, 'hook');
    assert.equal(auditRow.outcome, 'answered');
    assert.ok(auditRow.orchestration_id, 'audit event must have orchestration_id');
  });

  test('writes mcp_checkpoint_recorded for all four enforced tools', () => {
    const tools = [
      'pattern_find',
      'kb_search',
      'history_find_similar_tasks',
      'pattern_record_application',
    ];
    for (const tool of tools) {
      const { dir, stateDir } = makeDir({ withOrch: true });
      run({
        tool_name: 'mcp__orchestray__' + tool,
        cwd: dir,
        tool_result: { isError: false },
      });
      const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
      assert.equal(rows.length, 1, `${tool} must write one checkpoint row`);
      assert.equal(rows[0].tool, tool, `checkpoint row must record tool name "${tool}"`);
    }
  });

  test('ignores non-enforced mcp__orchestray__ tools (e.g. ask_user)', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'mcp__orchestray__ask_user',
      cwd: dir,
      tool_result: { isError: false },
    });
    assert.equal(
      fs.existsSync(path.join(stateDir, 'mcp-checkpoint.jsonl')),
      false,
      'ask_user is not enforced — must not write checkpoint row'
    );
  });

  test('ignores tool_name that does not start with mcp__orchestray__ prefix', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'Bash',
      cwd: dir,
    });
    assert.equal(
      fs.existsSync(path.join(stateDir, 'mcp-checkpoint.jsonl')),
      false,
      'Non-MCP tools must not write checkpoint rows'
    );
  });

  test('result_count captured from structuredContent.count for pattern_find', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_result: { isError: false, structuredContent: { count: 5 } },
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].result_count, 5, 'result_count must be captured from structuredContent.count');
  });

  test('result_count is null for non-pattern_find tools', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'mcp__orchestray__kb_search',
      cwd: dir,
      tool_result: { isError: false },
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].result_count, null,
      'result_count must be null for non-pattern_find tools');
  });

  test('outcome is "error" when tool_result.isError is true', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_result: { isError: true },
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'error');
  });

  test('outcome is "skipped" when tool_result is absent', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
    });
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'skipped');
  });

});

// ---------------------------------------------------------------------------
// D4 item 1 PII discipline — tool_input must NOT be written
// ---------------------------------------------------------------------------

describe('D4 item 1 PII discipline', () => {

  test('secret field in tool_input is NOT written to the checkpoint ledger', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const SECRET = 'my-super-secret-api-key-12345';
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_input: {
        query: 'find patterns',
        secret_credential: SECRET,
        api_key: SECRET,
      },
      tool_result: { isError: false },
    });

    const ledgerContent = fs.existsSync(path.join(stateDir, 'mcp-checkpoint.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), 'utf8')
      : '';
    assert.ok(
      !ledgerContent.includes(SECRET),
      'tool_input secret must NOT appear in mcp-checkpoint.jsonl'
    );
  });

  test('secret field in tool_input is NOT written to events.jsonl', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const SECRET = 'my-super-secret-api-key-12345';
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_input: {
        query: 'find patterns',
        secret_credential: SECRET,
      },
      tool_result: { isError: false },
    });

    const eventsContent = fs.existsSync(path.join(auditDir, 'events.jsonl'))
      ? fs.readFileSync(path.join(auditDir, 'events.jsonl'), 'utf8')
      : '';
    assert.ok(
      !eventsContent.includes(SECRET),
      'tool_input secret must NOT appear in events.jsonl'
    );
  });

  test('raw tool_result content is NOT persisted — only derived fields', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const SENSITIVE_CONTENT = 'internal-pattern-data-XYZ-7890';
    run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_input: {},
      tool_result: {
        isError: false,
        content: [{ text: SENSITIVE_CONTENT + ' (3 matches)' }],
        structuredContent: { count: 3 },
      },
    });

    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    // Only derived fields: result_count=3 (from structuredContent.count)
    assert.equal(rows[0].result_count, 3);
    // The raw content string must not appear in the row
    const rowStr = JSON.stringify(rows[0]);
    assert.ok(
      !rowStr.includes(SENSITIVE_CONTENT),
      'raw tool_result content text must NOT be written to checkpoint row'
    );
  });

});

// ---------------------------------------------------------------------------
// Fail-open behaviour
// ---------------------------------------------------------------------------

describe('fail-open discipline', () => {

  test('malformed JSON on stdin exits 0 and writes continue:true', () => {
    const { stdout, status } = run('{{not json}}');
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout.trim()).continue, true);
  });

  test('empty stdin exits 0 and writes continue:true', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout.trim()).continue, true);
  });

  test('always exits 0 even for valid MCP call — never blocks PostToolUse', () => {
    const { dir } = makeDir({ withOrch: true });
    const { status } = run({
      tool_name: 'mcp__orchestray__pattern_find',
      cwd: dir,
      tool_result: { isError: false },
    });
    assert.equal(status, 0, 'PostToolUse hook must always exit 0');
  });

});

// ---------------------------------------------------------------------------
// D6 smoke — fabricated ledger satisfies the gate
// ---------------------------------------------------------------------------

describe('D6 smoke — end-to-end: fabricated ledger rows allow first spawn', () => {

  test('all 3 required pre-decomposition MCP calls present in ledger → gate exits 0', () => {
    // This is the end-to-end happy path: simulate that record-mcp-checkpoint.js
    // has already written rows for all 3 required tools, then confirm the gate
    // (gate-agent-spawn.js) allows the first spawn.
    const GATE = path.resolve(__dirname, '../bin/gate-agent-spawn.js');
    const { dir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-smoke-001' });

    // Write the 3 required checkpoint rows directly (simulating what
    // record-mcp-checkpoint.js would write during pre-decomposition).
    const now = new Date().toISOString();
    const requiredTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const ledgerRows = requiredTools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-smoke-001',
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: tool === 'pattern_find' ? 2 : null,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), ledgerRows);

    // Also write routing.jsonl with a matching entry so routing validation passes
    const routingEntry = JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-smoke-001',
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Build the feature',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
    });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), routingEntry + '\n');

    const gateResult = spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({
        tool_name: 'Agent',
        cwd: dir,
        tool_input: {
          subagent_type: 'developer',
          model: 'sonnet',
          description: 'Build the feature',
        },
      }),
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(gateResult.status, 0,
      'Gate must exit 0 when all 3 required MCP checkpoints are present');
  });

});
