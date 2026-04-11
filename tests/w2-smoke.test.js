#!/usr/bin/env node
'use strict';

/**
 * W2 smoke test — end-to-end BUG-A regression guard for record-mcp-checkpoint.js
 *
 * This is the smoke test that would have caught BUG-A in 2.0.12.
 *
 * BUG-A: classifyOutcome/extractResultCount read `event.tool_result` (undefined
 * in Claude Code 2.1.59) instead of `event.tool_response` (a JSON string).
 * All checkpoint rows written by the 2.0.12 hook showed outcome:"skipped" and
 * result_count:null, making the advisory gate and the pattern_record enforcement
 * permanently non-functional.
 *
 * Fix: W2 rewrites both classifiers to read `event.tool_response` (string) and
 * parse it. Probe artifact at:
 *   .orchestray/kb/artifacts/2013-posttooluse-probe-record.md
 *
 * Test methodology: spawn record-mcp-checkpoint.js as a fresh child process and
 * pipe in a real-shape PostToolUse payload copied verbatim from the probe capture
 * (with cwd adjusted to a fresh tmpdir). Assert the resulting
 * mcp-checkpoint.jsonl row has outcome=answered and result_count matching the
 * number of matches in the payload.
 *
 * If outcome is "skipped" or result_count is null, BUG-A is back.
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

function makeIsolatedCwd(orchestrationId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w2-smoke-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchestrationId })
  );
  return { dir, auditDir, stateDir };
}

function runHook(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
  return result;
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// W2 smoke tests — real payload shape from the W0 probe capture
// Payload structure mirrors the verbatim capture in:
//   .orchestray/kb/artifacts/2013-posttooluse-probe-record.md §"Captured payload"
// ---------------------------------------------------------------------------

describe('W2 smoke — BUG-A regression guard (real PostToolUse payload shape)', () => {

  test('pattern_find: real-shape payload → outcome=answered, result_count=1 (probe-verified shape)', () => {
    // This test uses the exact payload structure captured by the W0 probe against
    // Claude Code 2.1.59. The tool_response field is a JSON string (not an object).
    // Pre-fix: outcome="skipped", result_count=null (BUG-A — read undefined tool_result).
    // Post-fix: outcome="answered", result_count=1 (reads tool_response string correctly).
    const orchId = 'orch-w2-smoke-001';
    const { dir, stateDir } = makeIsolatedCwd(orchId);

    // Real payload shape from probe artifact (cwd adjusted to tmpdir):
    const payload = {
      session_id: '009a0415-6cec-4bf4-b280-141a8c15690e',
      transcript_path: '/home/palgin/.claude/projects/-home-palgin-orchestray/009a0415-6cec-4bf4-b280-141a8c15690e.jsonl',
      cwd: dir,  // adjusted from probe's /home/palgin/orchestray to the tmpdir
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__orchestray__pattern_find',
      tool_input: {
        task_summary: 'W0 probe call — investigate PostToolUse hook payload shape for mcp__orchestray__ tools in Claude Code 2.1.59. Single probe call, no result usage.',
        agent_role: 'pm',
        max_results: 1,
      },
      // tool_response is a JSON STRING — verbatim from the probe capture
      tool_response: '{"matches":[{"slug":"anti-pattern-reviewer-subagent-turncap-on-whole-codebase-scans","uri":"orchestray:pattern://anti-pattern-reviewer-subagent-turncap-on-whole-codebase-scans","confidence":0.8,"times_applied":2,"category":"anti-pattern","one_line":"Reviewer subagents hit maxTurns and stop with stop_reason=tool_use mid-investigation during broad grep-heavy whole-codebase audits, never writing their report file","match_reasons":["role=pm"]}],"considered":13,"filtered_out":0}',
      tool_use_id: 'toolu_019YdWGzxhYpi1vm5TX1yuKq',
      // Note: tool_result is NOT present — this is the real shape. The 2.0.12 hook
      // read event.tool_result (undefined) which caused BUG-A.
    };

    const result = runHook(payload);
    assert.equal(result.status, 0, 'Hook must exit 0 (fail-open discipline)');

    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows.length, 1, 'Hook must write exactly one checkpoint row');

    const row = rows[0];
    // The critical assertions — these would have FAILED under BUG-A:
    assert.equal(row.outcome, 'answered',
      'outcome must be "answered" — not "skipped" (BUG-A regression guard)');
    assert.equal(row.result_count, 1,
      'result_count must be 1 (one match in the probe payload) — not null (BUG-A regression guard)');

    // Sanity checks on other fields
    assert.equal(row.tool, 'pattern_find');
    assert.equal(row.orchestration_id, orchId);
    assert.ok(typeof row.timestamp === 'string', 'timestamp must be present');
  });

  test('pattern_find: real-shape payload with 3 matches → result_count=3', () => {
    const orchId = 'orch-w2-smoke-002';
    const { dir, stateDir } = makeIsolatedCwd(orchId);

    const payload = {
      session_id: 'test-smoke-session-2',
      transcript_path: '/tmp/smoke-transcript.jsonl',
      cwd: dir,
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__orchestray__pattern_find',
      tool_input: { task_summary: 'smoke test', agent_role: 'developer', max_results: 5 },
      tool_response: '{"matches":[{"slug":"pattern-a"},{"slug":"pattern-b"},{"slug":"pattern-c"}],"considered":20,"filtered_out":17}',
      tool_use_id: 'toolu_smoke_003',
    };

    runHook(payload);
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered');
    assert.equal(rows[0].result_count, 3,
      'result_count must match matches.length in tool_response');
  });

  test('kb_search: real-shape payload → outcome=answered, result_count=2 (uniform extractor)', () => {
    // kb_search uses the same RESULT_COUNT_EXTRACTORS table as pattern_find.
    // This verifies the table-driven approach works for all three retrieval tools.
    const orchId = 'orch-w2-smoke-003';
    const { dir, stateDir } = makeIsolatedCwd(orchId);

    const payload = {
      session_id: 'test-smoke-session-3',
      transcript_path: '/tmp/smoke-transcript.jsonl',
      cwd: dir,
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__orchestray__kb_search',
      tool_input: { query: 'mcp enforcement', kb_sections: ['facts'] },
      tool_response: '{"matches":[{"slug":"fact-a","excerpt":"..."},{"slug":"fact-b","excerpt":"..."}]}',
      tool_use_id: 'toolu_smoke_004',
    };

    runHook(payload);
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered');
    assert.equal(rows[0].result_count, 2,
      'kb_search must use the uniform matches extractor');
  });

  test('history_find_similar_tasks: real-shape payload → outcome=answered, result_count correct', () => {
    const orchId = 'orch-w2-smoke-004';
    const { dir, stateDir } = makeIsolatedCwd(orchId);

    const payload = {
      session_id: 'test-smoke-session-4',
      transcript_path: '/tmp/smoke-transcript.jsonl',
      cwd: dir,
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__orchestray__history_find_similar_tasks',
      tool_input: { description: 'add endpoint', limit: 5 },
      tool_response: '{"matches":[{"task_id":"t1","similarity":0.9},{"task_id":"t2","similarity":0.7}]}',
      tool_use_id: 'toolu_smoke_005',
    };

    runHook(payload);
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'answered');
    assert.equal(rows[0].result_count, 2,
      'history_find_similar_tasks must use the uniform matches extractor');
  });

  test('BUG-A regression: tool_result present but tool_response absent → outcome=skipped (not answered)', () => {
    // This test documents what would happen if someone passes the OLD (wrong) shape:
    // tool_result:{...} instead of tool_response:"...". The hook must ignore
    // tool_result and classify based on the absent tool_response → outcome=skipped.
    // This is the CORRECT behavior: the old fake shape never actually appears from
    // Claude Code — only tool_response is real.
    const orchId = 'orch-w2-smoke-005';
    const { dir, stateDir } = makeIsolatedCwd(orchId);

    const payload = {
      session_id: 'test-smoke-session-5',
      transcript_path: '/tmp/smoke-transcript.jsonl',
      cwd: dir,
      permission_mode: 'bypassPermissions',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__orchestray__pattern_find',
      tool_input: { task_summary: 'test', max_results: 5 },
      // OLD wrong shape: tool_result object, no tool_response string
      tool_result: { isError: false, structuredContent: { count: 5 } },
      tool_use_id: 'toolu_smoke_006',
    };

    runHook(payload);
    const rows = readJsonlFile(path.join(stateDir, 'mcp-checkpoint.jsonl'));
    assert.equal(rows[0].outcome, 'skipped',
      'Old mock shape (tool_result object, no tool_response) must produce skipped — ' +
      'only tool_response is the real field in Claude Code 2.1.59');
    assert.equal(rows[0].result_count, null,
      'Old mock shape must produce null result_count (no tool_response to parse)');
  });

});
