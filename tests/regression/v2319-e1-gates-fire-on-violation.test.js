#!/usr/bin/env node
'use strict';

/**
 * v2319-e1-gates-fire-on-violation.test.js — E1: prove the v2.3.18 gates fire.
 *
 * v2.3.18 shipped the Claim–Evidence Ledger because two hand-written gates had
 * `total_fire_count: 0` after 98 days while the bug they guarded happened in
 * production. The replacement gates then ran 20+ times in this repo without a
 * single catch. A gate that never fires is indistinguishable from a gate that
 * cannot fire — unless something deliberately violates it and the gate is
 * watched.
 *
 * That is what this file is. Every test below constructs a DELIBERATE violation
 * and drives it through the gate's real wired entry point (the hook binary over
 * stdin, or the CLI), never an internal helper: the wiring is as much under test
 * as the logic. Their durable job is to fail if a future refactor silently
 * darkens a gate.
 *
 * Layout:
 *   1. CEL          bin/validate-claim-evidence.js       — unevidenced claims
 *   2. Co-change    bin/validate-companion-files.js      — half-done pair
 *   3. Tool grant   bin/detect-tool-grant-shortfall.js   — declared, never used
 *   4. BDG          bin/_tools/behavior-diff.js          — observable output moved
 *
 * Tests marked `{ skip: 'BUG(E1-n): ...' }` carry the CORRECT expectation for a
 * defect found while writing them — un-skip when the defect is fixed. They are
 * the finding, kept executable rather than written down somewhere.
 *
 * Runner: node --require ./tests/helpers/setup.js --test tests/regression/v2319-e1-gates-fire-on-violation.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const NODE        = process.execPath;
const CEL_HOOK    = path.join(REPO_ROOT, 'bin', 'validate-claim-evidence.js');
const COMPANION   = path.join(REPO_ROOT, 'bin', 'validate-companion-files.js');
const TOOLGRANT   = path.join(REPO_ROOT, 'bin', 'detect-tool-grant-shortfall.js');
const BDG         = path.join(REPO_ROOT, 'bin', '_tools', 'behavior-diff.js');

const { loadDeclaredTools } = require('../../bin/detect-tool-grant-shortfall');
const { coverage }          = require('../../bin/_tools/behavior-diff');

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

const trash = [];

function sandbox(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2319-e1-' + prefix + '-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  trash.push(dir);
  return dir;
}

function readEvents(dir) {
  try {
    return fs.readFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return {}; } });
  } catch (_e) { return []; }
}

function eventsOfType(dir, type) {
  return readEvents(dir).filter((e) => e.type === type);
}

/** Every gate-verdict event this run produced, for assertion messages. */
function verdictTypes(dir) {
  return readEvents(dir).map((e) => e.type).filter((t) => /^(claim_evidence|companion_file|tool_grant|behavior_diff)/.test(t));
}

/**
 * One transcript line per tool call. `timestamp` is fixed so the CEL spawn
 * window is deterministic (see resolveSpawnStart).
 */
function toolLine(name, input) {
  return {
    type: 'assistant',
    timestamp: '2026-08-07T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', name, input }] },
  };
}

function writeTranscript(dir, name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function writeOrchestration(dir, id) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id, phase: 'execute' }),
    'utf8',
  );
}

function runHook(hookPath, payload, cwd, extraEnv) {
  const r = cp.spawnSync(NODE, [hookPath], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP: '1' }, extraEnv || {}),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * A SubagentStop payload in the shape the gates were WRITTEN for: the agent's
 * text arrives on `output`. Kept separate from `realPayload` below because the
 * difference between the two is itself a finding.
 */
function assumedPayload(fields) {
  return Object.assign({
    hook_event_name: 'SubagentStop',
    session_id: 'sess-e1',
  }, fields);
}

/**
 * A SubagentStop payload with the key set Claude Code actually delivers,
 * transcribed from the captured hook inputs in `.orchestray/fixtures/
 * validate-claim-evidence/*.json` (harvested by bin/_lib/hook-stdin.js from
 * live spawns). Note what is NOT here: `result`, `output`, `agent_output`,
 * `structured_result`, `subagent_type`.
 */
function realPayload(fields) {
  return Object.assign({
    session_id: 'sess-e1',
    transcript_path: '',
    cwd: '',
    prompt_id: 'p-e1',
    permission_mode: 'bypassPermissions',
    agent_id: 'a-e1',
    agent_type: '',
    effort: { level: 'high' },
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: '',
    last_assistant_message: '',
    background_tasks: [],
    session_crons: [],
  }, fields);
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'e1', GIT_AUTHOR_EMAIL: 'e1@test',
  GIT_COMMITTER_NAME: 'e1', GIT_COMMITTER_EMAIL: 'e1@test',
};

function git(cwd, args) {
  return cp.execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: Object.assign({}, process.env, GIT_ENV),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A sandbox that is also a git repo with one commit. */
function gitSandbox(prefix, files) {
  const dir = sandbox(prefix);
  git(dir, ['init', '-q']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

afterEach(() => {
  while (trash.length) {
    try { fs.rmSync(trash.pop(), { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
});

// ===========================================================================
// 1. Claim–Evidence Ledger — bin/validate-claim-evidence.js
// ===========================================================================

describe('CEL fires on a deliberately unevidenced claim', () => {
  /**
   * Drive one violation through the hook binary.
   *
   * @param {object} o
   * @param {string} o.role
   * @param {string} o.output      the agent's prose testimony
   * @param {object[]} o.calls     transcript tool calls (the evidence, or its absence)
   * @param {object} [o.sr]        structured_result, when the rule keys on shape
   * @returns {{dir:string, status:number, stderr:string, gap:object}}
   */
  function violate(o) {
    const dir = sandbox('cel');
    const transcript = writeTranscript(dir, 'agent.jsonl', o.calls);
    const payload = assumedPayload({
      subagent_type: o.role,
      cwd: dir,
      agent_transcript_path: transcript,
      output: o.output,
    });
    if (o.sr) payload.structured_result = o.sr;
    const r = runHook(CEL_HOOK, payload, dir);
    const gaps = eventsOfType(dir, 'claim_evidence_gap');
    return { dir, status: r.status, stderr: r.stderr, gap: gaps[0], gapCount: gaps.length };
  }

  test('developer claiming a green suite with zero Bash calls produces a tests-run gap', () => {
    const r = violate({
      role: 'developer',
      output: 'Implemented the change. The test suite passes after my change.',
      calls: [toolLine('Read', { file_path: '/repo/bin/foo.js' }), toolLine('Edit', { file_path: '/repo/bin/foo.js' })],
    });
    assert.equal(r.status, 0, 'ramp window is open, so the gate warns rather than blocks');
    assert.equal(r.gapCount, 1, 'expected exactly one claim_evidence_gap, saw: ' + verdictTypes(r.dir).join(','));
    assert.ok(r.gap.rule_ids.includes('tests-run'), 'rule_ids=' + JSON.stringify(r.gap.rule_ids));
    assert.equal(r.gap.agent_role, 'developer');
    assert.equal(r.gap.gap_count, r.gap.rule_ids.length);
    assert.match(r.stderr, /unevidenced claim/i);
  });

  test('documenter claiming a README sweep with no .md edit produces a docs-updated gap', () => {
    const r = violate({
      role: 'documenter',
      output: 'Updated the README with the new configuration flag.',
      calls: [toolLine('Edit', { file_path: '/repo/bin/foo.js' })],
    });
    assert.equal(r.gapCount, 1, 'saw: ' + verdictTypes(r.dir).join(','));
    assert.deepEqual(r.gap.rule_ids, ['docs-updated']);
  });

  test('refactorer claiming every call site with no Grep produces an all-call-sites gap', () => {
    const r = violate({
      role: 'refactorer',
      output: 'Renamed the helper and updated all call sites of resolveThing.',
      calls: [toolLine('Edit', { file_path: '/repo/bin/foo.js' })],
    });
    assert.equal(r.gapCount, 1, 'saw: ' + verdictTypes(r.dir).join(','));
    assert.ok(r.gap.rule_ids.includes('all-call-sites'), 'rule_ids=' + JSON.stringify(r.gap.rule_ids));
  });

  test('architect spawn with no MCP call produces an mcp-grounded gap from the synthetic claim', () => {
    // No prose claim at all — the obligation comes from the role, which is the
    // path the retired validate-mcp-grounding.js owned.
    const r = violate({
      role: 'architect',
      output: 'Here is the design. Component A talks to component B over a queue.',
      calls: [toolLine('Read', { file_path: '/repo/bin/foo.js' })],
    });
    assert.equal(r.gapCount, 1, 'saw: ' + verdictTypes(r.dir).join(','));
    assert.ok(r.gap.rule_ids.includes('mcp-grounded'), 'rule_ids=' + JSON.stringify(r.gap.rule_ids));
  });

  test('researcher citing one source produces a researcher-min-sources assertion gap', () => {
    const r = violate({
      role: 'researcher',
      output: 'Here is the decision-ready shortlist for the queue library question.',
      calls: [toolLine('WebFetch', { url: 'https://example.com/a' })],
      sr: { status: 'complete', verdict: 'adopt', sources: ['https://example.com/a'] },
    });
    assert.equal(r.gapCount, 1, 'saw: ' + verdictTypes(r.dir).join(','));
    assert.ok(r.gap.rule_ids.includes('researcher-min-sources'), 'rule_ids=' + JSON.stringify(r.gap.rule_ids));
  });

  test('the same claim WITH a matching Bash call is passed, not blocked', () => {
    // The control. Without it, every assertion above would also hold for a gate
    // that flagged unconditionally.
    const dir = sandbox('cel-ok');
    const transcript = writeTranscript(dir, 'agent.jsonl', [
      toolLine('Bash', { command: 'npm test' }),
    ]);
    const r = runHook(CEL_HOOK, assumedPayload({
      subagent_type: 'developer',
      cwd: dir,
      agent_transcript_path: transcript,
      output: 'The test suite passes after my change.',
    }), dir);
    assert.equal(r.status, 0);
    assert.equal(eventsOfType(dir, 'claim_evidence_gap').length, 0, 'saw: ' + verdictTypes(dir).join(','));
    const ok = eventsOfType(dir, 'claim_evidence_ok');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].claims_count, 1, 'the claim was matched — and then evidenced');
    assert.equal(ok[0].tool_call_count, 1);
  });

  test('a gap is recorded in the ledger with the unevidenced verdict', () => {
    const r = violate({
      role: 'tester',
      // Glob, not Read: a Read is *weak* corroboration and would land the row
      // at strength 'weak'. Nothing here even resembles running a suite.
      output: 'The full test suite passes; lint is clean too.',
      calls: [toolLine('Glob', { pattern: 'tests/**/*.test.js' })],
    });
    const ledger = fs.readFileSync(
      path.join(r.dir, '.orchestray', 'state', 'claim-ledger-no-orch.jsonl'), 'utf8',
    ).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const testsRun = ledger.find((row) => row.rule_id === 'tests-run');
    assert.ok(testsRun, 'ledger rule_ids=' + JSON.stringify(ledger.map((x) => x.rule_id)));
    assert.equal(testsRun.evidenced, false);
    assert.equal(testsRun.strength, 'none');
    assert.equal(testsRun.severity, 'block');
    assert.equal(testsRun.role, 'tester');
  });

  test('an exhausted ramp turns the gap into an exit-2 block with a machine-readable reason', () => {
    const dir = sandbox('cel-block');
    writeOrchestration(dir, 'orch-e1-cel');
    const transcript = writeTranscript(dir, 'agent.jsonl', [toolLine('Read', { file_path: '/repo/x.js' })]);
    const r = runHook(CEL_HOOK, assumedPayload({
      subagent_type: 'developer',
      cwd: dir,
      agent_transcript_path: transcript,
      output: 'The test suite passes after my change.',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });

    assert.equal(r.status, 2, 'stderr=' + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      continue: false,
      reason: 'claim_evidence_blocked:tests-run',
    });
    const blocked = eventsOfType(dir, 'claim_evidence_blocked');
    assert.equal(blocked.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(blocked[0].ramp_state, 'blocked');
    assert.equal(blocked[0].orchestration_id, 'orch-e1-cel');
    assert.match(r.stderr, /BLOCKED — unevidenced claims/);
  });

  test('the subagent transcript is read for evidence when it is the only one supplied', () => {
    // Isolates the transcript-selection defect below: reading the agent's own
    // transcript works; preferring the session transcript over it is the bug.
    const dir = sandbox('cel-agent-transcript');
    const transcript = writeTranscript(dir, 'agent.jsonl', [toolLine('Bash', { command: 'npm test' })]);
    const r = runHook(CEL_HOOK, assumedPayload({
      subagent_type: 'developer',
      cwd: dir,
      agent_transcript_path: transcript,
      output: 'The test suite passes after my change.',
    }), dir);
    assert.equal(r.status, 0);
    const ok = eventsOfType(dir, 'claim_evidence_ok');
    assert.equal(ok.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(ok[0].tool_call_count, 1, 'the agent transcript was the one read');
  });
});

describe('CEL against the payload Claude Code actually delivers', () => {
  test('harvested SubagentStop payloads carry last_assistant_message and no result/output field', (t) => {
    // The provenance anchor for the two skipped tests below: this is not a
    // guess about the payload shape, it is the shape bin/_lib/hook-stdin.js
    // recorded from live spawns. `.orchestray/` is gitignored, so a checkout
    // without a harvested corpus skips rather than fails.
    const dir = path.join(REPO_ROOT, '.orchestray', 'fixtures', 'validate-claim-evidence');
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_e) { names = []; }
    if (names.length === 0) {
      t.skip('no harvested SubagentStop corpus in this checkout');
      return;
    }
    for (const name of names) {
      const stdin = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).stdin || {};
      if (stdin.hook_event_name !== 'SubagentStop') continue;
      assert.ok(Object.prototype.hasOwnProperty.call(stdin, 'last_assistant_message'),
        name + ' keys=' + Object.keys(stdin).join(','));
      for (const field of ['result', 'output', 'agent_output', 'structured_result']) {
        assert.equal(stdin[field], undefined,
          name + ' unexpectedly carries `' + field + '` — the claim-text plumbing may now be reachable');
      }
    }
  });

  // FIXED(E1-1, v2.3.19 W1): `last_assistant_message` now leads
  // RAW_OUTPUT_FIELDS (bin/_lib/claim-rules.js). Before that, claim text was
  // read via result|output|agent_output only — fields no live payload carries —
  // so the corpus was empty on every production spawn and all 28 shipped
  // `claim_evidence_ok` rows carry `claims_count: 0`.
  test('claim text is found in last_assistant_message', () => {
    const dir = sandbox('cel-real');
    const transcript = writeTranscript(dir, 'agent.jsonl', [toolLine('Read', { file_path: '/repo/x.js' })]);
    const r = runHook(CEL_HOOK, realPayload({
      cwd: dir,
      agent_type: 'developer',
      agent_transcript_path: transcript,
      last_assistant_message: 'Done. The test suite passes after my change.\n\n## Structured Result\n\n```json\n{"status":"complete","summary":"The test suite passes after my change.","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```\n',
    }), dir);

    assert.equal(r.status, 0);
    const gaps = eventsOfType(dir, 'claim_evidence_gap');
    assert.equal(gaps.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.ok(gaps[0].rule_ids.includes('tests-run'));
  });

  // FIXED(E1-2, v2.3.19 W1): resolution moved to
  // `transcript-tools.js:resolveSpawnTranscript`, which prefers
  // `agent_transcript_path` (the spawn) over `transcript_path` (the parent
  // session). Both are present in a real payload and they are different files,
  // so the old order let any tool call the PM made discharge a subagent claim.
  test('the subagent transcript outranks the session transcript for evidence', () => {
    const dir = sandbox('cel-launder');
    const session = writeTranscript(dir, 'session.jsonl', [toolLine('Bash', { command: 'npm test' })]);
    const agent   = writeTranscript(dir, 'agent.jsonl', [toolLine('Read', { file_path: '/repo/x.js' })]);
    const r = runHook(CEL_HOOK, assumedPayload({
      subagent_type: 'developer',
      cwd: dir,
      transcript_path: session,
      agent_transcript_path: agent,
      output: 'The test suite passes after my change.',
    }), dir);

    assert.equal(r.status, 0);
    const gaps = eventsOfType(dir, 'claim_evidence_gap');
    assert.equal(gaps.length, 1, 'the agent ran no test command; the PM did — saw: ' + verdictTypes(dir).join(','));
    assert.ok(gaps[0].rule_ids.includes('tests-run'));
  });
});

// ===========================================================================
// 2. Co-change Oracle — bin/validate-companion-files.js
// ===========================================================================

describe('Co-change gate fires on a half-done companion pair', () => {
  const BLOCK_RULE = {
    schema_version: 1,
    built_at: '2026-08-07T00:00:00.000Z',
    head: 'deadbeef',
    head_count: 100,
    commits_scanned: 400,
    rule_count: 1,
    block_count: 1,
    rules: {
      'src/a.js': [{ companion: 'src/a.schema.json', conf: 1, support: 20, enforcement: 'block' }],
    },
  };

  const ADVISORY_RULE = JSON.parse(JSON.stringify(BLOCK_RULE));
  ADVISORY_RULE.rules['src/a.js'][0].enforcement = 'advisory';
  ADVISORY_RULE.block_count = 0;

  /**
   * Sandbox git repo where `src/a.js` is dirty and its companion is untouched.
   * @param {object} graph  cochange cache to install
   */
  function halfDoneRepo(graph) {
    const dir = gitSandbox('cochange', {
      'src/a.js': 'module.exports = 1;\n',
      'src/a.schema.json': '{"v":1}\n',
    });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 2;\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'cochange-graph.json'),
      JSON.stringify(graph), 'utf8',
    );
    return dir;
  }

  function stopPayload(dir, extra) {
    return assumedPayload(Object.assign({
      subagent_type: 'developer',
      cwd: dir,
      structured_result: {
        status: 'complete',
        summary: 'Changed a.js.',
        files_changed: [{ path: 'src/a.js', description: 'behaviour change' }],
        files_read: [], issues: [], assumptions: [],
      },
    }, extra || {}));
  }

  test('a block-enforcement rule with the companion missing warns while the ramp is open', () => {
    const dir = halfDoneRepo(BLOCK_RULE);
    const r = runHook(COMPANION, stopPayload(dir), dir);
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    const missing = eventsOfType(dir, 'companion_file_missing');
    assert.equal(missing.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(missing[0].missing_count, 1);
    assert.equal(missing[0].missing[0].file, 'src/a.js');
    assert.equal(missing[0].missing[0].companion, 'src/a.schema.json');
    assert.match(r.stderr, /companion file\(s\) not updated/);
  });

  test('an exhausted ramp turns the missing companion into an exit-2 block', () => {
    const dir = halfDoneRepo(BLOCK_RULE);
    writeOrchestration(dir, 'orch-e1-cochange');
    const r = runHook(COMPANION, stopPayload(dir), dir, { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' });

    assert.equal(r.status, 2, 'stderr=' + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      continue: false,
      reason: 'companion_files_blocked:src/a.js->src/a.schema.json',
    });
    const blocked = eventsOfType(dir, 'companion_files_blocked');
    assert.equal(blocked.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(blocked[0].ramp_state, 'blocked');
    assert.equal(blocked[0].missing_count, 1);
    assert.match(r.stderr, /BLOCKED — companion files not updated/);
  });

  test('an advisory-enforcement rule is reported and never blocks', () => {
    // Establishes which side of the threshold blocks: `enforcement: 'block'`
    // (mined on the oldest 2/3 of history AND re-confirmed on the newest 1/3)
    // is the only kind that can exit 2, whatever the ramp says.
    const dir = halfDoneRepo(ADVISORY_RULE);
    writeOrchestration(dir, 'orch-e1-advisory');
    const r = runHook(COMPANION, stopPayload(dir), dir, { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' });
    assert.equal(r.status, 0);
    const advisory = eventsOfType(dir, 'companion_files_advisory');
    assert.equal(advisory.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(advisory[0].advisory[0].companion, 'src/a.schema.json');
    assert.equal(eventsOfType(dir, 'companion_files_blocked').length, 0);
  });

  test('naming the companion in assumptions waives the block', () => {
    const dir = halfDoneRepo(BLOCK_RULE);
    writeOrchestration(dir, 'orch-e1-waived');
    const payload = stopPayload(dir);
    payload.structured_result.assumptions = ['src/a.schema.json is generated downstream, not updated here'];
    const r = runHook(COMPANION, payload, dir, { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' });
    assert.equal(r.status, 0, 'a stated exception is a decision, not a miss');
    const ok = eventsOfType(dir, 'companion_files_ok');
    assert.equal(ok.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(ok[0].waived_count, 1);
  });

  test('a spawn that updated both sides is clean', () => {
    const dir = halfDoneRepo(BLOCK_RULE);
    fs.writeFileSync(path.join(dir, 'src', 'a.schema.json'), '{"v":2}\n', 'utf8');
    const payload = stopPayload(dir);
    payload.structured_result.files_changed.push({ path: 'src/a.schema.json', description: 'companion' });
    const r = runHook(COMPANION, payload, dir);
    assert.equal(r.status, 0);
    const ok = eventsOfType(dir, 'companion_files_ok');
    assert.equal(ok.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(ok[0].missing_count, 0);
    assert.equal(ok[0].changed_count, 2);
  });

  // FIXED(E1-3, v2.3.19 W1): a consequence of the E1-1 fix — the shared
  // `extractStructuredResult` falls through to `rawOutputText`, so teaching
  // that one field list about `last_assistant_message` revives attribution
  // here too. Until then `owned` was always null, `attributed` always false,
  // and the gate degraded to advisory on every live spawn.
  test('attribution comes from the Structured Result of the real payload', () => {
    const dir = halfDoneRepo(BLOCK_RULE);
    writeOrchestration(dir, 'orch-e1-real');
    const r = runHook(COMPANION, realPayload({
      cwd: dir,
      agent_type: 'developer',
      last_assistant_message: 'Done.\n\n## Structured Result\n\n```json\n{"status":"complete","summary":"Changed a.js.","files_changed":[{"path":"src/a.js","description":"behaviour change"}],"files_read":[],"issues":[],"assumptions":[]}\n```\n',
    }), dir, { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' });

    assert.equal(r.status, 2, 'stderr=' + r.stderr);
    assert.equal(eventsOfType(dir, 'companion_files_blocked').length, 1,
      'saw: ' + verdictTypes(dir).join(','));
  });
});

// ===========================================================================
// 3. Tool-grant shortfall — bin/detect-tool-grant-shortfall.js
// ===========================================================================

describe('tool-grant shortfall fires on a declared-but-unused capability tool', () => {
  function withAgent(role, toolsLine) {
    const dir = sandbox('toolgrant');
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agents', role + '.md'),
      '---\nname: ' + role + '\ntools: ' + toolsLine + '\nmodel: inherit\n---\n\n# ' + role + '\n',
      'utf8',
    );
    return dir;
  }

  /**
   * `resolveAgentDefinitionPath` also checks `~/.claude/agents/` (user-tier
   * install) as a legitimate resolution candidate — real behavior for anyone
   * with Orchestray installed globally. That makes the real `os.homedir()`
   * unsafe to run these "nothing is resolvable" tests against: on any machine
   * that HAS a global install (e.g. this repo's own dev/test box), the
   * detector would correctly find the real `~/.claude/agents/<role>.md` and
   * the test would stop proving what its name says. Point HOME at an empty
   * sandbox dir so "no definition anywhere" is actually true, independent of
   * the host machine's install state.
   */
  function fakeHome(dir) {
    const home = path.join(dir, '.fakehome');
    fs.mkdirSync(home, { recursive: true });
    return home;
  }

  test('a researcher that curled instead of using WebFetch is reported, on the real payload shape', () => {
    // The exact bug that motivated v2.3.18, driven through the payload keys
    // Claude Code actually sends (`agent_type`, not `subagent_type`).
    const dir = withAgent('researcher', 'Read, Glob, Grep, Bash, Write, WebFetch, WebSearch');
    const transcript = writeTranscript(dir, 'agent.jsonl', [
      toolLine('Bash', { command: 'curl -s https://example.com/docs' }),
      toolLine('Write', { file_path: '/repo/notes.md' }),
    ]);
    const r = runHook(TOOLGRANT, realPayload({
      cwd: dir,
      agent_type: 'researcher',
      agent_transcript_path: transcript,
      last_assistant_message: 'Shortlist below, sourced from the official docs.',
    }), dir);

    assert.equal(r.status, 0, 'telemetry-only gate never blocks; stderr=' + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { continue: true });
    const ev = eventsOfType(dir, 'tool_grant_shortfall');
    assert.equal(ev.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.deepEqual(ev[0].declared_but_unused, ['WebFetch', 'WebSearch']);
    assert.equal(ev[0].substituted_via, 'bash_curl');
    assert.equal(ev[0].agent_role, 'researcher');
    assert.equal(ev[0].spawn_id, 'a-e1');
  });

  test('a partial shortfall names only the unused tool', () => {
    const dir = withAgent('researcher', 'Read, Bash, WebFetch, WebSearch');
    const transcript = writeTranscript(dir, 'agent.jsonl', [
      toolLine('WebSearch', { query: 'queue libraries' }),
      toolLine('Bash', { command: 'curl -s https://example.com' }),
    ]);
    const r = runHook(TOOLGRANT, realPayload({
      cwd: dir, agent_type: 'researcher', agent_transcript_path: transcript,
    }), dir);
    assert.equal(r.status, 0);
    const ev = eventsOfType(dir, 'tool_grant_shortfall');
    assert.equal(ev.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.deepEqual(ev[0].declared_but_unused, ['WebFetch']);
  });

  test('the shipped researcher and platform-oracle definitions still parse into a declared tool list', () => {
    // The detector's silent-death condition: `tools:` must stay a flat
    // comma-separated frontmatter line (bin/detect-tool-grant-shortfall.js:88-92).
    // Converting either file to a YAML list makes loadDeclaredTools return []
    // and the detector a permanent no-op, with no error anywhere.
    const researcher = loadDeclaredTools(REPO_ROOT, 'researcher');
    assert.ok(researcher.includes('WebFetch'), 'researcher tools=' + JSON.stringify(researcher));
    assert.ok(researcher.includes('WebSearch'), 'researcher tools=' + JSON.stringify(researcher));
    const oracle = loadDeclaredTools(REPO_ROOT, 'platform-oracle');
    assert.ok(oracle.includes('WebFetch'), 'platform-oracle tools=' + JSON.stringify(oracle));
  });

  test('a dynamic specialist role has no agents/<role>.md, so nothing is detectable', () => {
    // Not a defect in the hook — a coverage hole worth pinning. Every spawn in
    // the v2.3.18 telemetry window carried a dynamic `agent_type`
    // (`dev-d5-ttl`, `curate-runner`), and none of those has a definition file
    // to compare a transcript against.
    const dir = sandbox('toolgrant-dynamic');
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    const transcript = writeTranscript(dir, 'agent.jsonl', [
      toolLine('Bash', { command: 'curl -s https://example.com' }),
    ]);
    const r = runHook(TOOLGRANT, realPayload({
      cwd: dir, agent_type: 'dev-d5-ttl', agent_transcript_path: transcript,
    }), dir, { HOME: fakeHome(dir) });
    assert.equal(r.status, 0);
    assert.equal(eventsOfType(dir, 'tool_grant_shortfall').length, 0);
  });

  test('a project without an agents/ directory yields no detection', () => {
    // `agents/<role>.md` is resolved under the payload cwd first, then under
    // `~/.claude/agents/` (real behavior for a global install — see
    // `fakeHome` above). HOME is isolated here so the case under test is
    // truly "no definition anywhere", not "no definition under cwd but one
    // happens to live in this machine's real global install".
    const dir = sandbox('toolgrant-noagents');
    const transcript = writeTranscript(dir, 'agent.jsonl', [
      toolLine('Bash', { command: 'curl -s https://example.com' }),
    ]);
    const r = runHook(TOOLGRANT, realPayload({
      cwd: dir, agent_type: 'researcher', agent_transcript_path: transcript,
    }), dir, { HOME: fakeHome(dir) });
    assert.equal(r.status, 0);
    assert.equal(eventsOfType(dir, 'tool_grant_shortfall').length, 0,
      'no agents/ dir under cwd, and HOME isolated from any real install — declared tools are unknowable');
  });

  test('an agent that used its declared tools produces no shortfall', () => {
    const dir = withAgent('platform-oracle', 'Read, Glob, Grep, Bash, Write, WebFetch');
    const transcript = writeTranscript(dir, 'agent.jsonl', [
      toolLine('WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }),
    ]);
    const r = runHook(TOOLGRANT, realPayload({
      cwd: dir, agent_type: 'platform-oracle', agent_transcript_path: transcript,
    }), dir);
    assert.equal(r.status, 0);
    assert.equal(eventsOfType(dir, 'tool_grant_shortfall').length, 0);
  });
});

// ===========================================================================
// 4. Behavior Diff Gate — bin/_tools/behavior-diff.js
// ===========================================================================

describe('BDG fires when a script\'s observable output changes', () => {
  /**
   * A hook-shaped probe: reads stdin, emits one audit event, exits.
   *
   * It must emit something on BOTH sides — an observation of `{0, [], ''}` is
   * the trivial one, and a script whose every fixture is trivial is reported
   * `uncovered`, not "no deltas". That distinction is the gate's own guard
   * against being a false-negative machine, so the corpus has to exercise it.
   *
   * @param {string} type  audit event type it writes
   * @param {number} code  exit code
   */
  const probeScript = (type, code) => [
    "'use strict';",
    'const fs = require("fs");',
    'const path = require("path");',
    'let raw = ""; try { raw = String(fs.readFileSync(0, "utf8") || ""); } catch (_e) { raw = ""; }',
    'const payload = raw.length > 0 ? raw : "{}";',
    'const dir = path.join(process.cwd(), ".orchestray", "audit");',
    'fs.mkdirSync(dir, { recursive: true });',
    'fs.appendFileSync(path.join(dir, "events.jsonl"),',
    '  JSON.stringify({ type: ' + JSON.stringify(type) + ', bytes: payload.length }) + "\\n");',
    'process.stdout.write(JSON.stringify({ continue: ' + (code === 0) + ' }));',
    'process.exit(' + code + ');',
    '',
  ].join('\n');

  const BASELINE_SCRIPT = probeScript('e1_probe_before', 0);

  /** Same input, different exit code AND a different audit event — a real delta. */
  const CHANGED_SCRIPT = probeScript('e1_probe_after', 2);

  const FIXTURE = JSON.stringify({
    stdin: { hook_event_name: 'SubagentStop', agent_type: 'developer', session_id: 's' },
    state: { 'current-orchestration.json': '{"orchestration_id":"orch-e1-bdg"}' },
  });

  function bdgRepo(fixtureBody) {
    const dir = gitSandbox('bdg', {
      'bin/e1-probe.js': BASELINE_SCRIPT,
      '.orchestray-keep': 'x\n',
    });
    const fixDir = path.join(dir, '.orchestray', 'fixtures', 'e1-probe');
    fs.mkdirSync(fixDir, { recursive: true });
    fs.writeFileSync(path.join(fixDir, 'a1.json'), fixtureBody === undefined ? FIXTURE : fixtureBody, 'utf8');
    return dir;
  }

  function runBdg(dir, args) {
    const r = cp.spawnSync(NODE, [BDG].concat(args), {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120000,
      env: Object.assign({}, process.env, GIT_ENV, { CLAUDE_PROJECT_DIR: dir }),
    });
    let report = null;
    try { report = JSON.parse(r.stdout); } catch (_e) { /* text mode or failure */ }
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', report };
  }

  test('a changed exit code and a new event are reported as a delta and exit 1', () => {
    const dir = bdgRepo();
    fs.writeFileSync(path.join(dir, 'bin', 'e1-probe.js'), CHANGED_SCRIPT, 'utf8');

    const r = runBdg(dir, ['--json', '--only', 'bin/e1-probe.js']);
    assert.ok(r.report, 'no JSON report; stdout=' + r.stdout.slice(0, 400) + ' stderr=' + r.stderr.slice(0, 400));
    assert.equal(r.report.delta_count, 1, JSON.stringify(r.report.scripts));
    assert.equal(r.report.blocked, true);
    assert.equal(r.status, 1, 'a delta with block=true exits 1');

    const script = r.report.scripts[0];
    assert.equal(script.uncovered, false);
    assert.equal(script.deltas[0].before.code, 0);
    assert.equal(script.deltas[0].after.code, 2);
    assert.deepEqual(script.deltas[0].before.events, ['e1_probe_before']);
    assert.deepEqual(script.deltas[0].after.events, ['e1_probe_after']);

    const ev = eventsOfType(dir, 'behavior_diff_unexpected');
    assert.equal(ev.length, 1, 'saw: ' + verdictTypes(dir).join(','));
    assert.equal(ev[0].delta_count, 1);
    assert.deepEqual(ev[0].scripts, ['bin/e1-probe.js']);
  });

  test('an unchanged script produces no delta and a behavior_diff_clean event', () => {
    const dir = bdgRepo();
    // Touch the file without changing behaviour: a comment-only edit.
    fs.writeFileSync(path.join(dir, 'bin', 'e1-probe.js'), '// comment only\n' + BASELINE_SCRIPT, 'utf8');

    const r = runBdg(dir, ['--json', '--only', 'bin/e1-probe.js']);
    assert.ok(r.report, 'stdout=' + r.stdout.slice(0, 400) + ' stderr=' + r.stderr.slice(0, 400));
    assert.equal(r.report.delta_count, 0, JSON.stringify(r.report.scripts));
    assert.equal(r.status, 0);
    assert.equal(r.report.scripts[0].uncovered, false, 'the fixture DID exercise the script');
    assert.equal(eventsOfType(dir, 'behavior_diff_clean').length, 1, 'saw: ' + verdictTypes(dir).join(','));
  });

  test('a fixture with no state snapshot is counted invalid and the script reported uncovered', () => {
    // The false-negative guard: a stdin-only corpus makes every observation
    // trivial, which must never be reported as "no deltas".
    const dir = bdgRepo(JSON.stringify({ stdin: { hook_event_name: 'SubagentStop' } }));
    fs.writeFileSync(path.join(dir, 'bin', 'e1-probe.js'), CHANGED_SCRIPT, 'utf8');

    const r = runBdg(dir, ['--json', '--only', 'bin/e1-probe.js']);
    assert.ok(r.report, 'stdout=' + r.stdout.slice(0, 400));
    assert.equal(r.report.scripts[0].uncovered, true);
    assert.equal(r.report.scripts[0].reason, 'fixtures_invalid');
    assert.equal(r.report.delta_count, 0);
    assert.equal(r.report.coverage.covered_scripts, 0, 'corpus health must report the hole');
    assert.equal(r.report.coverage.invalid_fixtures, 1);
  });

  test('the live fixture corpus is not empty of well-formed fixtures', (t) => {
    // `.orchestray/` is gitignored, so a fresh clone legitimately has no corpus
    // — but a corpus that exists and is 0% covered is the failure mode a prior
    // review measured (`covered_scripts: 0`, fixture `state` redacted away).
    const cov = coverage(REPO_ROOT);
    if (cov.scripts_with_fixtures === 0) {
      t.skip('no harvested corpus in this checkout');
      return;
    }
    assert.ok(cov.covered_scripts > 0,
      'every harvested fixture is malformed: ' + JSON.stringify(cov));
    assert.ok(cov.ratio > 0.5, 'corpus coverage collapsed: ' + JSON.stringify(cov));
  });
});
