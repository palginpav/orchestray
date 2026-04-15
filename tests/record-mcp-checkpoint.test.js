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
 *   D4 item 1 PII discipline — tool_input and tool_response must NOT be written
 *   BUG-A-2.0.13 — real-shape fixtures using tool_response (JSON string), not tool_result
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
 * withRouting=true writes a routing.jsonl containing an entry for
 *   routingOrchId (defaults to orchestrationId) to simulate post-decomposition.
 *   Pass routingOrchId='orch-PREVIOUS' to test the cross-orch phase derivation
 *   (BUG-B-2.0.13 regression scenario).
 */
function makeDir({
  withOrch = false,
  orchestrationId = 'orch-test-001',
  withRouting = false,
  routingOrchId = null,
} = {}) {
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
    // Write a routing entry so the BUG-B fix can see it.
    // routingOrchId defaults to the current orchestrationId (post-decomposition
    // scenario). To test cross-orch poisoning, pass a different routingOrchId.
    const effectiveRoutingOrchId = routingOrchId !== null ? routingOrchId : orchestrationId;
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      orchestration_id: effectiveRoutingOrchId,
      task_id: 'task-1',
      agent_type: 'developer',
      description: 'Test task',
      model: 'sonnet',
      effort: 'medium',
      complexity_score: 4,
      score_breakdown: {},
      decided_by: 'pm',
      decided_at: 'decomposition',
    });
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), entry + '\n');
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
// Real-shape payload fixtures (BUG-A-2.0.13)
// Derived from the W0 probe of Claude Code 2.1.59:
//   .orchestray/kb/artifacts/2013-posttooluse-probe-record.md
// The real field is tool_response (JSON STRING), not tool_result (undefined).
// All test fixtures below use this real shape. Old mock-shape fixtures that
// used tool_result:{...} objects have been replaced — they were the blind spot
// that let 2.0.12 ship with BUG-A.
// ---------------------------------------------------------------------------

/**
 * Build a real-shape PostToolUse payload with parametrizable tool_name and
 * tool_response. This mirrors the verbatim probe capture structure.
 */
function realShapePayload(dir, toolName, toolResponseStr) {
  const payload = {
    session_id: 'test-session-bugA-2013',
    transcript_path: '/tmp/test-transcript.jsonl',
    cwd: dir,
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { task_summary: 'test', max_results: 5 },
    tool_use_id: 'toolu_test_bugA',
  };
  // Only set tool_response if provided — omitting simulates the "missing" case
  if (toolResponseStr !== undefined) {
    payload.tool_response = toolResponseStr;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// BUG-A-2.0.13 — classifyOutcome + extractResultCount with real-shape payloads
// These tests use tool_response (JSON string) — the real field, not tool_result.
// ---------------------------------------------------------------------------

describe('BUG-A-2.0.13 — real-shape tool_response fixtures', () => {

  test('pattern_find: success with 3 matches → outcome=answered, result_count=3', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const toolResponse = '{"matches":[{"slug":"a"},{"slug":"b"},{"slug":"c"}],"considered":10,"filtered_out":7}';
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', toolResponse));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1, 'Should write one checkpoint row');
    assert.equal(rows[0].outcome, 'answered', 'outcome must be answered for valid JSON response');
    assert.equal(rows[0].result_count, 3, 'result_count must equal matches.length');
  });

  test('pattern_find: empty matches array → outcome=answered, result_count=0', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const toolResponse = '{"matches":[],"considered":5,"filtered_out":5}';
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', toolResponse));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered', 'outcome must be answered even with 0 matches');
    assert.equal(rows[0].result_count, 0, 'result_count must be 0 for empty matches array');
  });

  test('pattern_find: malformed JSON tool_response → outcome=error, result_count=null', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', 'not-valid-json{{{'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'error', 'malformed JSON must classify as error');
    assert.equal(rows[0].result_count, null, 'result_count must be null on parse failure');
  });

  test('pattern_find: missing tool_response (undefined) → outcome=skipped, result_count=null', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    // Pass payload WITHOUT tool_response — simulates the BUG-A scenario where
    // we read the wrong field (tool_result) and get undefined. Now with the fix,
    // missing tool_response → skipped.
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', undefined));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'skipped', 'absent tool_response must produce skipped outcome');
    assert.equal(rows[0].result_count, null, 'result_count must be null when tool_response absent');
  });

  test('pattern_find: explicit isError:true in tool_response → outcome=error, result_count=null', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const toolResponse = '{"isError":true,"error":"tool execution failed"}';
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', toolResponse));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'error', 'isError:true in tool_response must produce error outcome');
    assert.equal(rows[0].result_count, null, 'result_count must be null for error responses');
  });

  test('kb_search: real shape with 1 match → outcome=answered, result_count=1', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const toolResponse = '{"matches":[{"slug":"kb-entry-1"}],"total":1}';
    run(realShapePayload(dir, 'mcp__orchestray__kb_search', toolResponse));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered');
    assert.equal(rows[0].result_count, 1, 'kb_search must use the same matches extractor as pattern_find');
  });

  test('history_find_similar_tasks: real shape with 2 matches → outcome=answered, result_count=2', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const toolResponse = '{"matches":[{"task_id":"t1"},{"task_id":"t2"}]}';
    run(realShapePayload(dir, 'mcp__orchestray__history_find_similar_tasks', toolResponse));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered');
    assert.equal(rows[0].result_count, 2, 'history_find_similar_tasks must use the same matches extractor');
  });

  test('pattern_record_application: real shape → outcome=answered, result_count=null (write tool)', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    // pattern_record_application is a write tool — result_count is always null
    const toolResponse = '{"status":"recorded","slug":"some-pattern"}';
    run(realShapePayload(dir, 'mcp__orchestray__pattern_record_application', toolResponse));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered');
    assert.equal(rows[0].result_count, null, 'write tools never produce a result_count');
  });

  test('all three retrieval tools uniformly use matches extractor (OQ-T1-2)', () => {
    // Verify that pattern_find, kb_search, and history_find_similar_tasks all
    // return result_count from matches.length using the same table-driven extractor.
    const tools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const toolResponse = '{"matches":[{"slug":"x"},{"slug":"y"}]}';
    for (const tool of tools) {
      const { dir, stateDir } = makeDir({ withOrch: true });
      run(realShapePayload(dir, 'mcp__orchestray__' + tool, toolResponse));
      const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
      assert.equal(rows[0].result_count, 2,
        `${tool} must extract result_count=2 from matches array`);
    }
  });

  test('raw tool_response string is NOT written to ledger (PII discipline)', () => {
    // The raw JSON string content from tool_response must never appear in the checkpoint.
    // Only outcome and result_count (derived values) are allowed.
    const { dir, stateDir } = makeDir({ withOrch: true });
    const SENSITIVE_SLUG = 'very-sensitive-internal-pattern-XYZ-98765';
    const toolResponse = JSON.stringify({
      matches: [{ slug: SENSITIVE_SLUG, one_line: 'do not log this' }],
      considered: 1,
    });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', toolResponse));
    const ledgerContent = fs.readFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), 'utf8');
    assert.ok(
      !ledgerContent.includes(SENSITIVE_SLUG),
      'raw tool_response content must NOT appear in mcp-checkpoint.jsonl (PII discipline)'
    );
    // Derived values must still be correct
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].result_count, 1);
    assert.equal(rows[0].outcome, 'answered');
  });

});

// ---------------------------------------------------------------------------
// D2 step 3 — orchestration_id anchor from current-orchestration.json
// ---------------------------------------------------------------------------

describe('D2 step 3 — orchestration_id anchor', () => {

  test('writer reads current-orchestration.json and includes the id in the checkpoint row', () => {
    const { dir, stateDir } = makeDir({ withOrch: true, orchestrationId: 'orch-anchor-007' });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[{"slug":"x"}]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1, 'Should write exactly one checkpoint row');
    assert.equal(rows[0].orchestration_id, 'orch-anchor-007',
      'orchestration_id must come from current-orchestration.json');
  });

  test('writer exits 0 and writes nothing when current-orchestration.json is absent', () => {
    const { dir, stateDir } = makeDir({ withOrch: false });
    const { status } = run(realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[]}'));
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
    run(realShapePayload(dir, 'mcp__orchestray__kb_search', '{"matches":[]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'pre-decomposition',
      'phase must be pre-decomposition when routing.jsonl does not exist');
  });

  test('phase is "post-decomposition" when routing.jsonl contains an entry for the current orchestration_id', () => {
    // BUG-B-2.0.13 fix: post-decomposition is determined by finding routing entries
    // for the CURRENT orchestration_id, not just by file presence. This test
    // exercises the happy path: the routing entry belongs to the same orch.
    const { dir, stateDir } = makeDir({
      withOrch: true,
      orchestrationId: 'orch-test-001',
      withRouting: true,
      // routingOrchId defaults to orchestrationId ('orch-test-001') — matches current orch
    });
    run(realShapePayload(dir, 'mcp__orchestray__kb_search', '{"matches":[{"slug":"y"}]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'post-decomposition',
      'phase must be post-decomposition when routing.jsonl contains an entry for the current orch_id');
  });

});

// ---------------------------------------------------------------------------
// G8 — BUG-B-2.0.13 regression: orch-scoped phase derivation
// Ensures phase is derived from routing entries for the CURRENT orch_id,
// not from global routing.jsonl file presence. Missing test class that would
// have caught the BUG-B + BUG-C showstopper during the 2.0.12 review.
// ---------------------------------------------------------------------------

describe('G8 — BUG-B-2.0.13 regression: orch-scoped phase derivation', () => {

  test('T2: phase is "pre-decomposition" when routing.jsonl contains only entries for a prior orchestration', () => {
    // BUG-B scenario: routing.jsonl has rows for orch-PREVIOUS but not for
    // orch-CURRENT. The old file-existence heuristic would have returned
    // 'post-decomposition' because the file exists. The correct answer is
    // 'pre-decomposition' since the current orchestration has not decomposed.
    const { dir, stateDir } = makeDir({
      withOrch: true,
      orchestrationId: 'orch-CURRENT',
      withRouting: true,
      routingOrchId: 'orch-PREVIOUS',   // routing entry belongs to a prior orch
    });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', '{"matches":[]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1, 'Should write exactly one checkpoint row');
    assert.equal(rows[0].phase, 'pre-decomposition',
      'T2: phase must be pre-decomposition when routing.jsonl has no entry for the current orch_id');
  });

  test('T3: phase is "post-decomposition" when routing.jsonl contains an entry for the current orchestration_id', () => {
    // Positive case: routing.jsonl has an entry for orch-CURRENT, meaning
    // the PM has already written its routing decision for this orchestration.
    const { dir, stateDir } = makeDir({
      withOrch: true,
      orchestrationId: 'orch-CURRENT',
      withRouting: true,
      routingOrchId: 'orch-CURRENT',    // routing entry belongs to the current orch
    });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', '{"matches":[{"slug":"z"}]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1, 'Should write exactly one checkpoint row');
    assert.equal(rows[0].phase, 'post-decomposition',
      'T3: phase must be post-decomposition when routing.jsonl has a matching entry for the current orch_id');
  });

  test('T2b: routing.jsonl with multiple prior-orch entries, zero current-orch entries → pre-decomposition', () => {
    // Edge case: routing.jsonl has several entries from multiple prior orchestrations
    // but none for the current one. All rows should be ignored.
    const { dir, stateDir } = makeDir({
      withOrch: true,
      orchestrationId: 'orch-CURRENT',
    });
    // Manually write routing.jsonl with two prior-orch entries
    const entries = [
      { orchestration_id: 'orch-ONE', task_id: 'task-1', agent_type: 'developer', description: 'A', model: 'sonnet', timestamp: '2026-04-10T10:00:00.000Z' },
      { orchestration_id: 'orch-TWO', task_id: 'task-1', agent_type: 'reviewer', description: 'B', model: 'sonnet', timestamp: '2026-04-11T10:00:00.000Z' },
    ].map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(stateDir, 'routing.jsonl'), entries);

    run(realShapePayload(dir, 'mcp__orchestray__kb_search', '{"matches":[]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'pre-decomposition',
      'T2b: phase must be pre-decomposition when all routing entries belong to prior orchestrations');
  });

});

// ---------------------------------------------------------------------------
// D4 item 1 — dual-write to both ledger and events.jsonl
// ---------------------------------------------------------------------------

describe('D4 item 1 — dual-write', () => {

  test('writes to both mcp-checkpoint.jsonl and events.jsonl on a pattern_find call', () => {
    const { dir, auditDir, stateDir } = makeDir({ withOrch: true });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[{"slug":"a"},{"slug":"b"},{"slug":"c"}],"considered":10}'));

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
      run(realShapePayload(dir, 'mcp__orchestray__' + tool,
        '{"matches":[],"status":"ok"}'));
      const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
      assert.equal(rows.length, 1, `${tool} must write one checkpoint row`);
      assert.equal(rows[0].tool, tool, `checkpoint row must record tool name "${tool}"`);
    }
  });

  test('ignores non-enforced mcp__orchestray__ tools (e.g. ask_user)', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run(realShapePayload(dir, 'mcp__orchestray__ask_user', '{"answer":"yes"}'));
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

  test('result_count extracted from matches array in tool_response for pattern_find', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[{"slug":"a"},{"slug":"b"},{"slug":"c"},{"slug":"d"},{"slug":"e"}],"considered":20}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].result_count, 5, 'result_count must equal matches.length from tool_response');
  });

  test('result_count extracted from matches array for kb_search (not null)', () => {
    // Before BUG-A fix, kb_search always returned null. Now it should return
    // the real count from matches.
    const { dir, stateDir } = makeDir({ withOrch: true });
    run(realShapePayload(dir, 'mcp__orchestray__kb_search',
      '{"matches":[{"slug":"kb-1"}]}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].result_count, 1,
      'kb_search must now return result_count from matches (BUG-A fix)');
  });

  test('outcome is "error" when tool_response contains isError:true', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"isError":true,"error":"tool failed"}'));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'error');
  });

  test('outcome is "skipped" when tool_response is absent', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    // No tool_response field — simulates what happened under BUG-A when
    // the hook read tool_result (undefined) instead of tool_response.
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', undefined));
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'skipped');
  });

});

// ---------------------------------------------------------------------------
// D4 item 1 PII discipline — tool_input and raw tool_response must NOT be written
// ---------------------------------------------------------------------------

describe('D4 item 1 PII discipline', () => {

  test('secret field in tool_input is NOT written to the checkpoint ledger', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const SECRET = 'my-super-secret-api-key-12345';
    // Build a real-shape payload but with a secret in tool_input
    const payload = realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[]}');
    payload.tool_input = {
      query: 'find patterns',
      secret_credential: SECRET,
      api_key: SECRET,
    };
    run(payload);

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
    const payload = realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[]}');
    payload.tool_input = {
      query: 'find patterns',
      secret_credential: SECRET,
    };
    run(payload);

    const eventsContent = fs.existsSync(path.join(auditDir, 'events.jsonl'))
      ? fs.readFileSync(path.join(auditDir, 'events.jsonl'), 'utf8')
      : '';
    assert.ok(
      !eventsContent.includes(SECRET),
      'tool_input secret must NOT appear in events.jsonl'
    );
  });

  test('raw tool_response content is NOT persisted — only derived fields', () => {
    const { dir, stateDir } = makeDir({ withOrch: true });
    const SENSITIVE_CONTENT = 'internal-pattern-data-XYZ-7890';
    // Sensitive content appears inside the matches array — must not leak to ledger
    const toolResponse = JSON.stringify({
      matches: [
        { slug: SENSITIVE_CONTENT, one_line: 'secret description' },
        { slug: 'normal-slug', one_line: 'other' },
      ],
      considered: 2,
    });
    run(realShapePayload(dir, 'mcp__orchestray__pattern_find', toolResponse));

    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1);
    // Only derived fields: result_count=2 (from matches.length)
    assert.equal(rows[0].result_count, 2);
    // The raw content string must not appear in the row
    const rowStr = JSON.stringify(rows[0]);
    assert.ok(
      !rowStr.includes(SENSITIVE_CONTENT),
      'raw tool_response content must NOT be written to checkpoint row'
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
    const { status } = run(realShapePayload(dir, 'mcp__orchestray__pattern_find',
      '{"matches":[]}'));
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
    // Also write a pattern_record_application row to satisfy the §22c Stage B
    // post-decomp gate (D2 v2.0.16 default: hook-strict). routing.jsonl exists
    // below → second-spawn window is active, so this row is required.
    const now = new Date().toISOString();
    const requiredTools = ['pattern_find', 'kb_search', 'history_find_similar_tasks'];
    const ledgerRows = requiredTools.map(tool => JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-smoke-001',
      tool,
      outcome: 'answered',
      phase: 'pre-decomposition',
      result_count: tool === 'pattern_find' ? 2 : null,
    }));
    ledgerRows.push(JSON.stringify({
      timestamp: now,
      orchestration_id: 'orch-smoke-001',
      tool: 'pattern_record_application',
      outcome: 'answered',
      phase: 'post-decomposition',
      result_count: null,
    }));
    fs.writeFileSync(path.join(stateDir, 'mcp-checkpoint.jsonl'), ledgerRows.join('\n') + '\n');

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
