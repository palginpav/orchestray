#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-6-pattern-ack.test.js — validate-pattern-ack.js tests.
 *
 * Rewritten three times. The last rewrite is the one that matters: every
 * fixture here is now built from a payload CAPTURED FROM THE EVENT THE HOOK
 * IS REGISTERED ON, because each earlier fixture generation encoded a payload
 * shape that does not exist and therefore tested a world where the code works:
 *
 *   gen 1  `{matches: [...]}` full-mode grounding fixtures — a shape
 *          pattern_find stopped returning at the R-CAT-DEFAULT switch.
 *   gen 2  `tool_response` as a STRING containing a Structured Result — no
 *          real payload has ever set that.
 *   gen 3  `tool_name: 'Agent'` + `tool_input` + `last_assistant_message` on
 *          one object — half a PostToolUse:Agent payload, half a SubagentStop
 *          one. It passed while production recorded 0 ack rows from 6 offers,
 *          because PostToolUse:Agent (where the hook was registered) carries
 *          no agent output at all.
 *
 * The two builders below are the observed key sets, and `shape guards` fails
 * if either drifts back toward a fiction. See
 * .orchestray/kb/decisions/pattern-ack-wired-to-wrong-hook-event.md.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-pattern-ack.js');
const { resolveOfferedSlug, CATEGORY_PREFIXES } = require('../_lib/pattern-offer-scan.js');
const SCRIPT = path.resolve(__dirname, '..', 'validate-pattern-ack.js');
const OFFER_SCRIPT = path.resolve(__dirname, '..', 'record-pattern-offers.js');

const ORCH_ID    = 'orch-test-1';
const SESSION_ID = 'bed562d5-1f0e-4f2a-9c31-2b7a5e0d4c11';
const AGENT_NAME = 'dev-pe4-registry';

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-w2-6-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Captured payload builders — key sets verified against live 2026-08-08 runs
// ---------------------------------------------------------------------------

/**
 * PreToolUse:Agent. `agent_type` here is the CALLER's type; the spawned
 * agent's roster name is `tool_input.name`. The per-spawn id is the top-level
 * `tool_use_id` — nothing under tool_input carries one.
 */
function preToolUsePayload({ agentName = AGENT_NAME, prompt, toolUseId = 'toolu_01J39P95yRDBkU51umwnZTbZ',
                             subagentType = 'developer', sessionId = SESSION_ID } = {}) {
  return {
    session_id: sessionId,
    transcript_path: path.join(tmpDir, 'transcript.jsonl'),
    cwd: tmpDir,
    prompt_id: 'prompt-abc',
    permission_mode: 'acceptEdits',
    agent_type: 'pm',
    effort: 'high',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: 'W3 rewire ack capture',
      prompt,
      subagent_type: subagentType,
      model: 'opus',
      run_in_background: false,
      name: agentName,
    },
    tool_use_id: toolUseId,
  };
}

/**
 * SubagentStop. `agent_type` is the STOPPED agent's roster name (not the
 * caller's, not its subagent_type), `agent_id` is `a<roster>-<hash>`, and
 * `last_assistant_message` is the only field carrying the agent's output.
 * There is no tool_use_id, no tool_input and no tool_response.
 */
function subagentStopPayload({ agentName = AGENT_NAME, lastAssistantMessage = '',
                               sessionId = SESSION_ID } = {}) {
  return {
    session_id: sessionId,
    transcript_path: path.join(tmpDir, 'transcript.jsonl'),
    cwd: tmpDir,
    prompt_id: 'prompt-abc',
    permission_mode: 'acceptEdits',
    agent_id: 'a' + agentName + '-5d7d77c3ef4f1359',
    agent_type: agentName,
    effort: 'high',
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: path.join(tmpDir, 'agent-transcript.jsonl'),
    last_assistant_message: lastAssistantMessage,
    background_tasks: [],
    session_crons: [],
  };
}

/** A `## Structured Result` block as an agent emits it, wrapped in prose. */
function structuredResultText({ summary = 'ok', patternsUsed, patternsRejected, status = 'success' } = {}) {
  const sr = { status, summary, files_changed: [], files_read: [], issues: [], assumptions: [] };
  if (patternsUsed !== undefined) sr.patterns_used = patternsUsed;
  if (patternsRejected !== undefined) sr.patterns_rejected = patternsRejected;
  return ['Some reasoning.', '', '## Structured Result', '```json', JSON.stringify(sr), '```'].join('\n');
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

/** Marks ORCH_ID as the active orchestration — what peekOrchestrationId reads. */
function writeOrchMarker(orchId) {
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
}

/** An offer row exactly as bin/record-pattern-offers.js writes one. */
function offerRow({ orchestrationId = ORCH_ID, sessionId = SESSION_ID, agentName = AGENT_NAME,
                    spawnId = 'toolu_test_001', agentRole = 'developer', taskId = 'W1', offers }) {
  return {
    timestamp: '2026-08-07T09:00:00.000Z',
    orchestration_id: orchestrationId,
    session_id: sessionId,
    agent_name: agentName,
    spawn_id: spawnId,
    agent_role: agentRole,
    task_id: taskId,
    offers,
    shape_detected: 'uri_only',
    unresolved_slugs: [],
  };
}

function writeOfferRows(rows) {
  const offersPath = path.join(tmpDir, '.orchestray', 'state', 'pattern-offers.jsonl');
  fs.appendFileSync(offersPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function runScript(script, payload, extraEnv) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  if (result.error) throw result.error;
  let stdout = {};
  try { stdout = JSON.parse(result.stdout || '{}'); } catch (_) {}
  return { stdout, stderr: result.stderr || '' };
}

function runHook(payload, extraEnv) {
  const { stdout, stderr } = runScript(SCRIPT, payload, extraEnv);
  return {
    stdout,
    stderr,
    events: readJsonl(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl')),
    acks:   readJsonl(path.join(tmpDir, '.orchestray', 'state', 'pattern-acks.jsonl')),
    offers: readJsonl(path.join(tmpDir, '.orchestray', 'state', 'pattern-offers.jsonl')),
  };
}

/** Seeds one curated offer + runs the hook with a Structured Result. */
function seedAndRun({ offers, patternsUsed, patternsRejected, summary = 'ok', agentName = AGENT_NAME,
                      stopSessionId = SESSION_ID, stopAgentName: stopName, env } = {}) {
  writeOrchMarker(ORCH_ID);
  writeOfferRows([offerRow({ agentName, offers })]);
  return runHook(subagentStopPayload({
    agentName: stopName || agentName,
    sessionId: stopSessionId,
    lastAssistantMessage: structuredResultText({ summary, patternsUsed, patternsRejected }),
  }), env);
}

// ---------------------------------------------------------------------------
// Shape guards — the regression that all three fixture generations needed
// ---------------------------------------------------------------------------

describe('shape guards', () => {
  test('the SubagentStop fixture carries the captured key set and nothing invented', () => {
    setup();
    try {
      const p = subagentStopPayload({ lastAssistantMessage: 'x' });
      assert.deepEqual(Object.keys(p).sort(), [
        'agent_id', 'agent_transcript_path', 'agent_type', 'background_tasks', 'cwd', 'effort',
        'hook_event_name', 'last_assistant_message', 'permission_mode', 'prompt_id', 'session_crons',
        'session_id', 'stop_hook_active', 'transcript_path',
      ].sort());
      assert.equal('tool_response' in p, false, 'SubagentStop has no tool_response — the gen-2 fiction');
      assert.equal('tool_use_id' in p, false, 'SubagentStop has no tool_use_id — this is why the join key changed');
      assert.equal('tool_input' in p, false, 'SubagentStop has no tool_input — the gen-3 fiction');
    } finally { teardown(); }
  });

  test('the PreToolUse fixture carries the captured key set and no agent output', () => {
    setup();
    try {
      const p = preToolUsePayload({ prompt: 'x' });
      assert.deepEqual(Object.keys(p).sort(), [
        'agent_type', 'cwd', 'effort', 'hook_event_name', 'permission_mode', 'prompt_id',
        'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'transcript_path',
      ].sort());
      assert.equal('last_assistant_message' in p, false, 'output does not exist yet at spawn time');
      assert.deepEqual(Object.keys(p.tool_input).sort(), [
        'description', 'model', 'name', 'prompt', 'run_in_background', 'subagent_type',
      ]);
      assert.equal('agent_id' in p.tool_input, false);
      assert.equal('spawn_id' in p.tool_input, false);
    } finally { teardown(); }
  });
});

// ---------------------------------------------------------------------------
// THE acceptance test — real offer payload joins a real ack payload end to end
// ---------------------------------------------------------------------------

test('e2e: a real PreToolUse:Agent offer joins a real SubagentStop ack on (session_id, agent name) ' +
     'and produces ack_source=structured_fields plus an ack row carrying the offer row\'s spawn_id', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
    fs.mkdirSync(patternsDir, { recursive: true });
    for (const slug of ['decomposition-multi-pass-review', 'anti-pattern-verification-shares-blind-spot']) {
      fs.writeFileSync(path.join(patternsDir, slug + '.md'), '---\nslug: ' + slug + '\nconfidence: 0.8\n---\n# ' + slug + '\n');
    }

    const toolUseId = 'toolu_01J39P95yRDBkU51umwnZTbZ';
    const prompt = [
      'W3 — rewire the ack capture.',
      'Apply @orchestray:pattern://decomposition-multi-pass-review [core] conf 0.8.',
      'Avoid @orchestray:pattern://anti-pattern-verification-shares-blind-spot [core] conf 0.7.',
    ].join('\n');

    // Phase 1, unmodified script, real payload.
    runScript(OFFER_SCRIPT, preToolUsePayload({ prompt, toolUseId }));

    // Phase 2, unmodified script, real payload. The rejected entry uses the
    // live-observed malformed shape: key `name`, category prefix dropped.
    const { events, acks, offers } = runHook(subagentStopPayload({
      lastAssistantMessage: structuredResultText({
        summary: 'rewired it',
        patternsUsed: [{ slug: 'decomposition-multi-pass-review', how: 'drove the three-pass audit split' }],
        patternsRejected: [{ name: 'verification-shares-blind-spot', why: 'the verifier here is a separate hook' }],
      }),
    }));

    assert.equal(offers.length, 1, 'Phase 1 must have written exactly one offer row');
    assert.equal(offers[0].spawn_id, toolUseId);
    assert.equal(offers[0].session_id, SESSION_ID, 'offer producer must write the join key');
    assert.equal(offers[0].agent_name, AGENT_NAME, 'offer producer must write the join key');

    const captured = events.filter((e) => e.type === 'pattern_ack_captured');
    assert.equal(captured.length, 1, 'the ack must find the offer row across the two real payloads');
    assert.equal(captured[0].ack_source, 'structured_fields');
    assert.equal(captured[0].coverage_complete, true, 'both offered slugs were dispositioned');
    assert.deepEqual(captured[0].used_slugs, ['decomposition-multi-pass-review']);
    assert.deepEqual(captured[0].rejected_slugs, ['anti-pattern-verification-shares-blind-spot'],
      'the bare `name` must resolve back to the offered slug');
    assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);

    assert.equal(acks.length, 1, 'the structured-fields path must write the Phase-3 join row');
    assert.equal(acks[0].spawn_id, offers[0].spawn_id,
      'the ack row must carry the offer row spawn_id — this is what Phase 3 joins on');
    assert.equal(acks[0].orchestration_id, ORCH_ID);
    assert.equal(acks[0].agent_role, 'developer', 'agent_role comes off the offer row (SubagentStop has no subagent_type)');
    assert.equal(acks[0].task_id, 'W3');
    assert.equal(acks[0].source, 'structured_result');
    assert.ok(acks[0].used[0].how_len > 0);
    assert.ok(acks[0].rejected[0].why_len > 0);
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Corpus outlier — slug filename shortened, category+name reduction misses it
// (.orchestray/kb/decisions/pattern-ack-slug-fidelity-limit.md). The offered
// pattern's own frontmatter `name:` is the fallback.
// ---------------------------------------------------------------------------

test('e2e: an ack naming the frontmatter `name` of a shortened-filename outlier ' +
     '(anti-pattern-regex-false-positives / name: regex-false-positive-check) still credits', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
    fs.mkdirSync(patternsDir, { recursive: true });
    // Real corpus frontmatter shape (.orchestray/patterns/anti-pattern-regex-false-positives.md) —
    // category + '-' + name ('anti-pattern-regex-false-positive-check') does NOT reduce to the slug.
    fs.writeFileSync(
      path.join(patternsDir, 'anti-pattern-regex-false-positives.md'),
      '---\nname: regex-false-positive-check\ncategory: anti-pattern\nconfidence: 0.6\n---\n# regex false positive check\n'
    );

    const toolUseId = 'toolu_01J39P95yRDBkU51umwnZTc0';
    const prompt = 'W4 — tighten the lookahead regex.\n' +
      'Apply @orchestray:pattern://anti-pattern-regex-false-positives [core] conf 0.6.';

    runScript(OFFER_SCRIPT, preToolUsePayload({ prompt, toolUseId }));

    const { events, acks } = runHook(subagentStopPayload({
      lastAssistantMessage: structuredResultText({
        summary: 'tightened the alternation',
        patternsUsed: [{ name: 'regex-false-positive-check', how: 'tested each lookahead alternative independently before merging' }],
        patternsRejected: [],
      }),
    }));

    const captured = events.filter((e) => e.type === 'pattern_ack_captured');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].coverage_complete, true,
      'the frontmatter-name ack must resolve to the offered slug, not fall through as uncovered');
    assert.deepEqual(captured[0].used_slugs, ['anti-pattern-regex-false-positives'],
      'credit lands on the offered slug, not the frontmatter name the agent wrote');
    assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);

    assert.equal(acks.length, 1);
    assert.equal(acks[0].used[0].slug, 'anti-pattern-regex-false-positives');
    assert.ok(acks[0].used[0].how_len > 0);
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Join negatives — an ack must not attach to an offer that is not its own
// ---------------------------------------------------------------------------

describe('join', () => {
  test('different session_id → no join, no check', () => {
    setup();
    try {
      const { events } = seedAndRun({
        offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
        stopSessionId: 'some-other-session',
        summary: 'irrelevant',
      });
      assert.equal(events.length, 0, 'a sibling session must not leak its offers');
    } finally { teardown(); }
  });

  test('different agent name → no join, no check', () => {
    setup();
    try {
      const { events } = seedAndRun({
        offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
        agentName: 'dev-other',
        stopAgentName: 'dev-mine',
        summary: 'irrelevant',
      });
      assert.equal(events.length, 0, 'a sibling spawn must not leak its offers');
    } finally { teardown(); }
  });

  test('runtime collision suffix (requested `foo`, registered `foo-2`) still joins', () => {
    setup();
    try {
      const { events } = seedAndRun({
        offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
        agentName: 'curate-runner',
        stopAgentName: 'curate-runner-2',
        patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
        patternsRejected: [],
      });
      const captured = events.filter((e) => e.type === 'pattern_ack_captured');
      assert.equal(captured.length, 1, 'auto-suffixing a roster name must not break the join');
      assert.equal(captured[0].coverage_complete, true);
    } finally { teardown(); }
  });

  test('two rows share a base name → suffix fallback refuses to guess', () => {
    setup();
    try {
      writeOrchMarker(ORCH_ID);
      writeOfferRows([
        offerRow({ agentName: 'curate-runner', spawnId: 'toolu_a', offers: [{ slug: 'a', offer_kind: 'curated', confidence: 0.8 }] }),
        offerRow({ agentName: 'curate-runner-2', spawnId: 'toolu_b', offers: [{ slug: 'b', offer_kind: 'curated', confidence: 0.8 }] }),
      ]);
      const { events } = runHook(subagentStopPayload({
        agentName: 'curate-runner-3',
        lastAssistantMessage: structuredResultText({ summary: 'ok' }),
      }));
      assert.equal(events.length, 0, 'ambiguous base name must be left unjoined, not guessed');
    } finally { teardown(); }
  });

  test('no offer row at all → no check, 0 emits (safe-on-missing)', () => {
    setup();
    try {
      writeOrchMarker(ORCH_ID);
      const { stdout, events } = runHook(subagentStopPayload({
        lastAssistantMessage: structuredResultText({ summary: 'nothing offered' }),
      }));
      assert.deepEqual(stdout, { continue: true });
      assert.equal(events.length, 0);
    } finally { teardown(); }
  });

  test('non-SubagentStop payload is ignored even with a matching offer row', () => {
    setup();
    try {
      writeOrchMarker(ORCH_ID);
      writeOfferRows([offerRow({ offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }] })]);
      const stop = subagentStopPayload({ lastAssistantMessage: structuredResultText({ summary: 'ok' }) });
      const { events } = runHook(Object.assign({}, stop, { hook_event_name: 'PostToolUse' }));
      assert.equal(events.length, 0, 'only the event this hook is registered on may drive a check');
    } finally { teardown(); }
  });
});

// ---------------------------------------------------------------------------
// Coverage semantics
// ---------------------------------------------------------------------------

describe('role generalization', () => {
  for (const role of ['developer', 'tester', 'reviewer', 'architect']) {
    test('role=' + role + ': curated offer with full coverage → coverage_complete=true', () => {
      setup();
      try {
        writeOrchMarker(ORCH_ID);
        writeOfferRows([offerRow({
          agentRole: role,
          offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
        })]);
        const { events } = runHook(subagentStopPayload({
          lastAssistantMessage: structuredResultText({
            patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
            patternsRejected: [],
          }),
        }));
        const captured = events.filter((e) => e.type === 'pattern_ack_captured');
        assert.equal(captured.length, 1);
        assert.equal(captured[0].agent_role, role, 'role is read off the offer row');
        assert.equal(captured[0].coverage_complete, true);
        assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);
      } finally { teardown(); }
    });
  }
});

test('ambient-only offer row → no check at all (curated is the only signal this hook reasons about)', () => {
  setup();
  try {
    const { stdout, events } = seedAndRun({
      offers: [{ slug: 'ambient-only-slug', offer_kind: 'ambient', confidence: 0.75 }],
      summary: 'Design completed without any pattern references.',
    });
    assert.deepEqual(stdout, { continue: true });
    assert.equal(events.length, 0);
  } finally { teardown(); }
});

test('mixed offer row (curated + ambient) → only the curated slug enters the offered set', () => {
  setup();
  try {
    const { events } = seedAndRun({
      offers: [
        { slug: 'curated-slug', offer_kind: 'curated', confidence: 0.9 },
        { slug: 'ambient-slug', offer_kind: 'ambient', confidence: 0.6 },
      ],
      summary: 'no mentions',
    });
    const withheld = events.filter((e) => e.type === 'pattern_application_withheld');
    assert.equal(withheld.length, 1);
    assert.equal(withheld[0].slug, 'curated-slug');
  } finally { teardown(); }
});

test('no patterns_used/patterns_rejected → legacy text scan, and NO ack row (unreliable signal)', () => {
  setup();
  try {
    const { events, acks } = seedAndRun({
      offers: [{ slug: 'decomposition-audit-fix-verify-cycle', offer_kind: 'curated', confidence: 0.9 }],
      summary: 'did it',
    });
    const captured = events.filter((e) => e.type === 'pattern_ack_captured');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].ack_source, 'legacy_text_scan');
    const withheld = events.filter((e) => e.type === 'pattern_application_withheld');
    assert.equal(withheld.length, 1);
    assert.equal(withheld[0].slug, 'decomposition-audit-fix-verify-cycle');
    assert.equal(acks.length, 0, 'the legacy path must never feed the Phase-3 join');
  } finally { teardown(); }
});

test('structured fields: full coverage (1 used, 1 rejected) → ack row with both dispositions', () => {
  setup();
  try {
    const { events, acks } = seedAndRun({
      offers: [
        { slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 },
        { slug: 'event-schema-declare', offer_kind: 'curated', confidence: 0.9 },
      ],
      patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
      patternsRejected: [{ slug: 'event-schema-declare', why: 'no new event types in this change' }],
    });
    const captured = events.filter((e) => e.type === 'pattern_ack_captured')[0];
    assert.equal(captured.coverage_complete, true);
    assert.equal(captured.ack_source, 'structured_fields');
    assert.deepEqual(captured.used_slugs, ['decompose-parallel']);
    assert.deepEqual(captured.rejected_slugs, ['event-schema-declare']);
    assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);

    assert.equal(acks.length, 1);
    assert.equal(acks[0].used[0].slug, 'decompose-parallel');
    assert.ok(acks[0].used[0].how_len > 0);
    assert.ok(acks[0].rejected[0].why_len > 0);
  } finally { teardown(); }
});

test('structured fields: only 1 of 2 offered slugs covered → 1 withheld', () => {
  setup();
  try {
    const { events } = seedAndRun({
      offers: [
        { slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 },
        { slug: 'event-schema-declare', offer_kind: 'curated', confidence: 0.9 },
      ],
      patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
      patternsRejected: [],
    });
    assert.equal(events.filter((e) => e.type === 'pattern_ack_captured')[0].coverage_complete, false);
    const withheld = events.filter((e) => e.type === 'pattern_application_withheld');
    assert.equal(withheld.length, 1);
    assert.equal(withheld[0].slug, 'event-schema-declare');
  } finally { teardown(); }
});

test('structured fields present but empty → still the structured path (an agent that used nothing)', () => {
  setup();
  try {
    const { events } = seedAndRun({
      offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
      summary: 'mentions decompose-parallel by name but explicitly rejected it below',
      patternsUsed: [],
      patternsRejected: [{ slug: 'decompose-parallel', why: 'considered but not a fit for this task shape' }],
    });
    const captured = events.filter((e) => e.type === 'pattern_ack_captured')[0];
    assert.equal(captured.ack_source, 'structured_fields');
    assert.equal(captured.coverage_complete, true);
    assert.deepEqual(captured.used_slugs, []);
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test('kill switch ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → 0 emits', () => {
  setup();
  try {
    const { stdout, events } = seedAndRun({
      offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.85 }],
      summary: 'Design with no slug reference.',
      env: { ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED: '1' },
    });
    assert.deepEqual(stdout, { continue: true });
    assert.equal(events.length, 0);
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Event-schema shadow allowlist — the superseded event type is retained
// ---------------------------------------------------------------------------

test('schema validation: architect_pattern_ack_missing is retained in the shadow allowlist', () => {
  const shadowPath = path.resolve(__dirname, '..', '..', 'agents', 'pm-reference', 'event-schemas.shadow.json');
  assert.ok(fs.existsSync(shadowPath), 'shadow file must exist');
  const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
  assert.ok('architect_pattern_ack_missing' in shadow,
    'architect_pattern_ack_missing entry must be retained (dark-event auditor still resolves it)');
});

// ---------------------------------------------------------------------------
// Unit coverage — offered-set extraction, ack-entry shapes, slug resolution
// ---------------------------------------------------------------------------

describe('curatedSlugsFromRow (unit)', () => {
  test('null row → []', () => {
    assert.deepEqual(mod.curatedSlugsFromRow(null), []);
  });

  test('dedupes curated slugs and drops ambient ones', () => {
    const slugs = mod.curatedSlugsFromRow({ offers: [
      { slug: 'a', offer_kind: 'curated' },
      { slug: 'a', offer_kind: 'curated' },
      { slug: 'b', offer_kind: 'curated' },
      { slug: 'c', offer_kind: 'ambient' },
    ] }).sort();
    assert.deepEqual(slugs, ['a', 'b']);
  });
});

describe('normalizeAckEntries (unit)', () => {
  const offered = ['anti-pattern-verification-shares-blind-spot', 'decomposition-multi-pass-review'];

  test('accepts `name` as an alias for `slug` and restores the dropped prefix', () => {
    const out = mod.normalizeAckEntries(
      [{ name: 'verification-shares-blind-spot', why: 'the verifier is a separate hook here' }], 'why', offered);
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'anti-pattern-verification-shares-blind-spot');
    assert.ok(out[0].why_len > 0);
    assert.equal(out[0].why_valid, true);
  });

  test('`slug` wins when both keys are present', () => {
    const out = mod.normalizeAckEntries(
      [{ slug: 'decomposition-multi-pass-review', name: 'verification-shares-blind-spot', how: 'drove the split' }], 'how', offered);
    assert.equal(out[0].slug, 'decomposition-multi-pass-review');
  });

  test('bare string entries still resolve (advisory hook tolerates what T15 rejects)', () => {
    const out = mod.normalizeAckEntries(['verification-shares-blind-spot'], 'how', offered);
    assert.deepEqual(out, [{ slug: 'anti-pattern-verification-shares-blind-spot', how_len: 0, how_valid: false }]);
  });

  test('entries with neither slug nor name are dropped, not thrown on', () => {
    assert.deepEqual(mod.normalizeAckEntries([{ how: 'no identifier at all' }, null, 42], 'how', offered), []);
  });

  // Prose-key flexibility: array membership (patterns_used vs
  // patterns_rejected) already encodes the semantics, so the exact prose
  // key must not gate whether reasoning is recorded.
  test('a patterns_rejected entry carrying `how` still records a non-zero why_len', () => {
    const out = mod.normalizeAckEntries(
      [{ slug: 'decomposition-multi-pass-review', how: 'directly analogous but not the same shape here' }],
      'why', offered);
    assert.equal(out.length, 1);
    assert.ok(out[0].why_len > 0, 'prose under `how` must not be discarded when normalizing patterns_rejected');
  });

  test('a patterns_used entry carrying `why` still records a non-zero how_len', () => {
    const out = mod.normalizeAckEntries(
      [{ slug: 'decomposition-multi-pass-review', why: 'this is why it applied, written under the wrong key' }],
      'how', offered);
    assert.equal(out.length, 1);
    assert.ok(out[0].how_len > 0, 'prose under `why` must not be discarded when normalizing patterns_used');
  });

  test('an entry with genuinely no prose under any accepted key stays at len 0', () => {
    const out = mod.normalizeAckEntries(
      [{ slug: 'decomposition-multi-pass-review' }], 'why', offered);
    assert.equal(out.length, 1);
    assert.equal(out[0].why_len, 0, 'no prose anywhere must still normalize to length 0');
    assert.equal(out[0].why_valid, false);
  });

  // Length-bound parity with the T15 gate (bin/validate-task-completion.js
  // #isValidPatternAckEntry) — both consumers now call the same
  // handoff-contract-text.js#isPatternAckProseLenValid predicate.
  describe('*_valid length-bound parity with the T15 gate', () => {
    test('below the 10-char minimum: recorded, flagged invalid', () => {
      const out = mod.normalizeAckEntries(
        [{ slug: 'decomposition-multi-pass-review', how: 'x'.repeat(9) }], 'how', offered);
      assert.equal(out[0].how_len, 9);
      assert.equal(out[0].how_valid, false);
    });

    test('exactly the 10-char minimum: valid', () => {
      const out = mod.normalizeAckEntries(
        [{ slug: 'decomposition-multi-pass-review', how: 'x'.repeat(10) }], 'how', offered);
      assert.equal(out[0].how_len, 10);
      assert.equal(out[0].how_valid, true);
    });

    test('exactly the 300-char maximum: valid', () => {
      const out = mod.normalizeAckEntries(
        [{ slug: 'decomposition-multi-pass-review', how: 'x'.repeat(300) }], 'how', offered);
      assert.equal(out[0].how_len, 300);
      assert.equal(out[0].how_valid, true);
    });

    test('over the 300-char maximum: recorded UNCAPPED (not truncated), flagged invalid', () => {
      const out = mod.normalizeAckEntries(
        [{ slug: 'decomposition-multi-pass-review', how: 'x'.repeat(301) }], 'how', offered);
      assert.equal(out[0].how_len, 301, 'the true length is preserved — this is a length-only row, no prose text to truncate');
      assert.equal(out[0].how_valid, false, 'still flagged so the ledger and the T15 gate never silently disagree');
    });
  });
});

describe('resolveOfferedSlug (unit)', () => {
  test('exact match wins and returns the offered spelling', () => {
    assert.equal(resolveOfferedSlug('Decomposition-Multi-Pass-Review', ['decomposition-multi-pass-review']),
      'decomposition-multi-pass-review');
  });

  test('a bare name resolves when exactly one offered slug carries a category prefix', () => {
    assert.equal(resolveOfferedSlug('verification-shares-blind-spot', ['anti-pattern-verification-shares-blind-spot']),
      'anti-pattern-verification-shares-blind-spot');
  });

  test('an ambiguous bare name is returned unchanged — never guessed', () => {
    const offered = ['routing-model-tiering', 'roi-model-tiering'];
    assert.equal(resolveOfferedSlug('model-tiering', offered), 'model-tiering',
      'two prefixed candidates must leave the name unmatched');
    assert.equal(offered.includes(resolveOfferedSlug('model-tiering', offered)), false,
      'an unmatched name must fail the offered-set intersection, i.e. count as unacknowledged');
  });

  test('an unrelated name is returned unchanged', () => {
    assert.equal(resolveOfferedSlug('something-else', ['decomposition-multi-pass-review']), 'something-else');
  });

  test('non-string and empty input are safe', () => {
    assert.equal(resolveOfferedSlug(null, ['a']), '');
    assert.equal(resolveOfferedSlug('   ', ['a']), '');
  });

  // The prefix list is copied out of schemas/pattern.schema.js rather than
  // imported (zod on a SubagentStop hot path). This is the guard on that copy.
  test('CATEGORY_PREFIXES stays in parity with schemas/pattern.schema.js CATEGORIES', () => {
    const { CATEGORIES } = require(path.resolve(__dirname, '..', '..', 'schemas', 'pattern.schema.js'));
    assert.deepEqual([...CATEGORY_PREFIXES].sort(), [...CATEGORIES].sort());
  });

  describe('frontmatter-name fallback (cwd-bounded)', () => {
    function writePattern(dir, slug, frontmatterName) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, slug + '.md'), '---\nname: ' + frontmatterName + '\ncategory: anti-pattern\n---\n# ' + slug + '\n');
    }

    test('no cwd → prefix reduction still misses the outlier, name returned unchanged', () => {
      setup();
      try {
        const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
        writePattern(patternsDir, 'anti-pattern-regex-false-positives', 'regex-false-positive-check');
        assert.equal(
          resolveOfferedSlug('regex-false-positive-check', ['anti-pattern-regex-false-positives']),
          'regex-false-positive-check',
          'without cwd the fallback must not fire — same behaviour as before this change'
        );
      } finally { teardown(); }
    });

    test('with cwd → resolves via the offered pattern\'s own frontmatter `name:`', () => {
      setup();
      try {
        const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
        writePattern(patternsDir, 'anti-pattern-regex-false-positives', 'regex-false-positive-check');
        assert.equal(
          resolveOfferedSlug('regex-false-positive-check', ['anti-pattern-regex-false-positives'], tmpDir),
          'anti-pattern-regex-false-positives'
        );
      } finally { teardown(); }
    });

    test('a name only found on a slug outside the offered set is never read, and never resolves', () => {
      setup();
      try {
        const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
        writePattern(patternsDir, 'anti-pattern-not-offered', 'unoffered-pattern-name');
        assert.equal(
          resolveOfferedSlug('unoffered-pattern-name', ['anti-pattern-regex-false-positives'], tmpDir),
          'unoffered-pattern-name',
          'the file exists on disk but is not in the offered set, so it must not be considered'
        );
      } finally { teardown(); }
    });

    test('two offered slugs whose frontmatter share the same `name` → ambiguous, unresolved', () => {
      setup();
      try {
        const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
        writePattern(patternsDir, 'anti-pattern-a', 'shared-name');
        writePattern(patternsDir, 'anti-pattern-b', 'shared-name');
        const resolved = resolveOfferedSlug('shared-name', ['anti-pattern-a', 'anti-pattern-b'], tmpDir);
        assert.equal(resolved, 'shared-name');
        assert.equal(['anti-pattern-a', 'anti-pattern-b'].includes(resolved), false,
          'two frontmatter-name candidates must leave the ack unmatched, never guessed');
      } finally { teardown(); }
    });

    test('a prefix-path hit and a frontmatter-name hit resolving to the SAME slug is not ambiguous', () => {
      setup();
      try {
        const patternsDir = path.join(tmpDir, '.orchestray', 'patterns');
        // slug reduces cleanly (category + '-' + name) AND its own frontmatter
        // `name` happens to be the identical string — both mechanisms agree.
        writePattern(patternsDir, 'anti-pattern-shared-name', 'shared-name');
        assert.equal(
          resolveOfferedSlug('shared-name', ['anti-pattern-shared-name'], tmpDir),
          'anti-pattern-shared-name'
        );
      } finally { teardown(); }
    });

    test('missing pattern file on disk → fallback fails open, name returned unchanged', () => {
      setup();
      try {
        assert.equal(
          resolveOfferedSlug('nonexistent-name', ['anti-pattern-nonexistent-file'], tmpDir),
          'nonexistent-name'
        );
      } finally { teardown(); }
    });
  });
});
