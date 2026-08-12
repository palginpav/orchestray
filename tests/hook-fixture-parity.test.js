#!/usr/bin/env node
'use strict';

/**
 * Fixture-realism gate.
 *
 * v2.3.20 shipped a feature that had never once executed — nine stacked defects,
 * every one invisible to a 7,600-test suite, because the fixtures fed each hook
 * a payload shape production never sends. The invariant that would have caught
 * all of them: a hook consumer must be validated against a payload captured
 * from its own event type.
 *
 * Two guards, both anchored in bin/_lib/hook-fixture-parity.js:
 *   PARITY — every `(script, event, matcher)` in hooks.json has a same-event
 *            capture, or is a frozen, non-growing, non-stale known gap.
 *   SHAPE  — a fixture may not claim one event while carrying another event's
 *            fields. A fixture that lies is worse than no fixture.
 *
 * Run: node --require ./tests/helpers/setup.js --test tests/hook-fixture-parity.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const P = require('../bin/_lib/hook-fixture-parity.js');

const repoRoot = path.join(__dirname, '..');
const corpus   = P.loadFixtureCorpus(repoRoot);
const declared = P.declaredPairs(repoRoot);

const allowKey     = (a) => a.script + '|' + a.event;
const allowSet     = new Set(P.UNCOVERED_ALLOWLIST.map(allowKey));
const describePair = (p) => p.script + '.js @ ' + p.event + (p.matcher ? '[' + p.matcher + ']' : '');

// Corpus-dependent assertions only — the rest of this file's tests are
// either pure (hooks.json/EVENT_SHAPES/UNCOVERED_ALLOWLIST structure) or
// degrade gracefully (loop over an empty corpus, assert nothing). Only
// these two actually require a non-empty corpus to hold.
const HAS_FIXTURE_CORPUS = corpus.size > 0;
const SKIP_NO_FIXTURES = HAS_FIXTURE_CORPUS ? false :
  '.orchestray/fixtures/ is harvested local telemetry (ORCHESTRAY_FIXTURE_HARVEST=1), ' +
  'accumulated from real hook invocations during actual product usage. It is gitignored ' +
  'and never shipped — a fresh clone or CI checkout has no history to harvest from.';

describe('hook fixture parity — declared consumers vs captured payloads', () => {
  test('the fixture corpus is loadable and non-trivial', { skip: SKIP_NO_FIXTURES }, () => {
    assert.ok(corpus.size > 0, 'no fixture directories under .orchestray/fixtures');
    const bad = [];
    let total = 0;
    for (const list of corpus.values()) {
      for (const f of list) { total++; if (f.unparseable) bad.push(f.file); }
    }
    assert.deepEqual(bad, [], 'unparseable fixtures');
    assert.ok(total > 500, 'corpus suspiciously small (' + total + ') — harvest may be broken');
  });

  test('hooks.json declares consumers this guard can key', () => {
    assert.ok(declared.length > 0, 'no command hooks parsed from hooks.json');
    for (const p of declared) {
      assert.ok(p.script, 'unparseable command: ' + p.command);
      assert.ok(p.event, 'missing event for ' + p.command);
    }
  });

  // Rollout: an anti-growth ledger, not a mute button. A NEW gap fails here.
  // With an empty corpus every declared pair is "uncovered" — not a real
  // parity gap, just the absence of the corpus itself (see test above).
  test('every uncovered (script, event, matcher) pair is a known, frozen gap',
    { skip: SKIP_NO_FIXTURES }, () => {
      const uncovered = P.uncoveredPairs(repoRoot, corpus);
      const novel = uncovered.filter((p) => !allowSet.has(allowKey(p)));
      assert.deepEqual(
        novel.map(describePair), [],
        'new fixture-parity gap(s). Either capture a real payload for this event ' +
        '(ORCHESTRAY_FIXTURE_HARVEST=1) or add an entry to UNCOVERED_ALLOWLIST in ' +
        'bin/_lib/hook-fixture-parity.js and raise FROZEN_UNCOVERED_COUNT — the ' +
        'latter needs a reviewer.'
      );
    });

  test('the known-gap ledger cannot grow', () => {
    assert.ok(
      P.UNCOVERED_ALLOWLIST.length <= P.FROZEN_UNCOVERED_COUNT,
      'UNCOVERED_ALLOWLIST grew to ' + P.UNCOVERED_ALLOWLIST.length +
      ' past the frozen stop of ' + P.FROZEN_UNCOVERED_COUNT
    );
    const seen = new Set();
    for (const a of P.UNCOVERED_ALLOWLIST) {
      const k = allowKey(a);
      assert.ok(!seen.has(k), 'duplicate allowlist entry: ' + k);
      seen.add(k);
      assert.ok(
        ['no-harvest-seam', 'event-not-yet-observed'].includes(a.reason),
        'allowlist entry ' + k + ' has unclassified reason "' + a.reason + '"'
      );
    }
  });

  // The ratchet only tightens: once a fixture lands AND its shape has been
  // derived, the waiver must be deleted. This subsumes the old "no stale
  // entries" check — see lifecycleIssues() doc for why a covered-but-unshaped
  // entry needs a different instruction than a covered-and-shaped one, and
  // why conflating them produced contradictory instructions across two runs
  // (v2.3.27 V8: "delete the waiver" vs "add the waiver" for the same pair).
  test('the known-gap ledger has no stale entries — and never gives contradictory next steps', () => {
    const issues = P.lifecycleIssues(repoRoot, corpus);
    // A covered pair whose event still has no derived shape is a distinct,
    // actionable state (do steps 1-2 before step 3) — never bare "stale".
    const pendingShape = issues.filter((i) => i.kind === 'pending_shape');
    const staleComplete = issues.filter((i) => i.kind === 'stale_complete');
    assert.deepEqual(
      staleComplete.map((i) => i.message), [],
      'these pairs are covered AND already shaped — delete them from UNCOVERED_ALLOWLIST'
    );
    assert.deepEqual(
      pendingShape.map((i) => i.message), [],
      'a real capture landed but the shape has not been derived yet — see message for the ' +
      'full 3-step order (this is NOT the same instruction as "delete the entry")'
    );
  });

  // Acceptance: constructs the exact V8 failure mode (a real capture landing
  // for an allowlisted pair with evidence.n still 0) and proves lifecycleIssues
  // gives ONE coherent instruction, never two contradictory ones from separate
  // tests. This must hold structurally, independent of the live corpus state.
  test('lifecycleIssues gives one coherent instruction for a capture that landed before its shape was derived', () => {
    const fakeCorpus = new Map([
      ['worktree-remove', [{ file: 'f', stdin: { hook_event_name: 'WorktreeRemove', session_id: 's', cwd: '/w' } }]],
    ]);
    const issues = P.lifecycleIssues(repoRoot, fakeCorpus);
    const forPair = issues.filter((i) => i.key === 'worktree-remove|WorktreeRemove');
    assert.equal(forPair.length, 1, 'exactly one instruction for this pair, not zero and not two conflicting ones');
    assert.equal(forPair[0].kind, 'pending_shape');
    assert.match(forPair[0].message, /derive required\/forbidden\/types/);
    assert.match(forPair[0].message, /THEN delete this UNCOVERED_ALLOWLIST entry/);
    assert.match(forPair[0].message, /not a flip-flopping test/);
  });

  // Every allowlist entry must name a consumer that actually exists.
  test('the known-gap ledger references only declared consumers', () => {
    const declaredKeys = new Set(declared.map((p) => p.script + '|' + p.event));
    const orphans = P.UNCOVERED_ALLOWLIST.map(allowKey).filter((k) => !declaredKeys.has(k));
    assert.deepEqual(orphans, [], 'allowlist entries no longer declared in hooks.json');
  });

  // CLI args (`collect-context-telemetry.js pre-spawn`) are NOT a separate
  // fixture dimension: hook-stdin.js keys the harvest on script basename, and
  // today every arg variant is fully determined by its event. This test is the
  // tripwire on that reasoning — if one (script, event) ever carries two
  // different arg strings, the args become a real consumer dimension and the
  // parity key must widen to include them.
  test('no (script, event) pair carries two distinct CLI arg strings', () => {
    const byPair = new Map();
    for (const p of declared) {
      const k = p.script + '|' + p.event;
      if (!byPair.has(k)) byPair.set(k, new Set());
      byPair.get(k).add(p.args);
    }
    const ambiguous = [...byPair].filter(([, v]) => v.size > 1)
      .map(([k, v]) => k + ' => ' + JSON.stringify([...v]));
    assert.deepEqual(
      ambiguous, [],
      'args now distinguish consumers on the same event — widen pairKey() to include args'
    );
  });
});

describe('hook fixture shape — a fixture must not lie about its event', () => {
  test('every captured fixture matches the shape of the event it declares', () => {
    const failures = [];
    for (const [dir, list] of corpus) {
      for (const { file, stdin } of list) {
        if (!stdin) continue;
        const { ok, errors } = P.checkShape(stdin);
        if (!ok) failures.push(dir + '/' + path.basename(file) + ': ' + errors.join('; '));
      }
    }
    assert.deepEqual(failures.slice(0, 20), [], failures.length + ' fixture(s) contradict their declared event');
  });

  test('fixtures without hook_event_name come only from non-hook producers', () => {
    const strays = [];
    for (const [dir, list] of corpus) {
      if (P.NON_HOOK_PRODUCERS.includes(dir)) continue;
      for (const { file, stdin } of list) {
        if (!stdin) continue;
        // An empty capture carries no claim to contradict; anything else must
        // declare its event or it cannot be validated at all.
        if (Object.keys(stdin).length === 0) continue;
        if (!stdin.hook_event_name) strays.push(dir + '/' + path.basename(file));
      }
    }
    assert.deepEqual(strays, [], 'fixtures with payload but no hook_event_name');
  });

  // Ties the two mechanisms together: no shape may be asserted for an event we
  // have never captured (that would be hand-authoring), and any event we cannot
  // shape-check must be visible in the gap ledger.
  test('events with zero captures assert no shape and are tracked as gaps', () => {
    const allowedEvents = new Set(P.UNCOVERED_ALLOWLIST.map((a) => a.event));
    for (const [event, shape] of Object.entries(P.EVENT_SHAPES)) {
      if (shape.evidence.n !== 0) {
        assert.ok(shape.required.length > 0 || shape.forbidden.length > 0,
          event + ' has captures but asserts nothing');
        continue;
      }
      assert.deepEqual(shape.required, [], event + ' has no captures but claims required fields');
      assert.deepEqual(shape.forbidden, [], event + ' has no captures but claims forbidden fields');
      assert.ok(allowedEvents.has(event),
        event + ' is uncheckable (no captures) and untracked — add it to UNCOVERED_ALLOWLIST');
    }
  });

  test('every declared event has an EVENT_SHAPES entry', () => {
    const missing = [...new Set(declared.map((p) => p.event))].filter((e) => !P.EVENT_SHAPES[e]);
    assert.deepEqual(missing, [], 'hooks.json declares events with no shape entry');
  });
});

describe('the guard itself fires', () => {
  const stdinFor = (over) => Object.assign({ session_id: 's', cwd: '/w' }, over);

  test('checkShape rejects a PostToolUse fixture carrying SubagentStop fields', () => {
    // The exact v2.3.20 defect: precedence copied from a SubagentStop consumer
    // into a PostToolUse one, and a fixture built to match.
    const { ok, errors } = P.checkShape(stdinFor({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {},
      tool_use_id: 'toolu_1', tool_response: {}, duration_ms: 5,
      last_assistant_message: '## Structured Result\n{}',
    }));
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('last_assistant_message')), errors.join('; '));
  });

  test('checkShape rejects PostToolUse:Agent tool_response typed as a string', () => {
    const { ok, errors } = P.checkShape(stdinFor({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {},
      tool_use_id: 'toolu_1', tool_response: '## Structured Result', duration_ms: 5,
    }));
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('tool_response must be object')), errors.join('; '));
  });

  test('checkShape accepts a real PostToolUse:Agent dispatch payload', () => {
    const { ok, errors } = P.checkShape(stdinFor({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'developer' },
      tool_use_id: 'toolu_1', tool_response: { status: 'dispatched', teammate_id: 't1' }, duration_ms: 5,
    }));
    assert.equal(ok, true, errors.join('; '));
  });

  test('checkShape rejects a PreToolUse fixture missing tool_use_id', () => {
    // The other v2.3.20 defect: a consumer read tool_input.agent_id because the
    // fixture injected it; the real identifier is top-level tool_use_id.
    const { ok, errors } = P.checkShape(stdinFor({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { agent_id: 'a1' },
    }));
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('tool_use_id')), errors.join('; '));
  });

  test('checkShape rejects an unknown event name', () => {
    const { ok, errors } = P.checkShape(stdinFor({ hook_event_name: 'NotAnEvent' }));
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('unknown hook_event_name')), errors.join('; '));
  });

  test('isCovered demands a capture from the consumer\'s own event type', () => {
    const fake = new Map([['x', [{ file: 'f', stdin: { hook_event_name: 'SubagentStop' } }]]]);
    assert.equal(P.isCovered(fake, { script: 'x', event: 'SubagentStop', matcher: '' }), true);
    assert.equal(P.isCovered(fake, { script: 'x', event: 'TaskCompleted', matcher: '' }), false,
      'a SubagentStop capture must not satisfy a TaskCompleted consumer');
    assert.equal(P.isCovered(fake, { script: 'y', event: 'SubagentStop', matcher: '' }), false);
  });

  test('matcher subjects are event-correct, not always tool_name', () => {
    const ss = { hook_event_name: 'SessionStart', source: 'compact' };
    assert.equal(P.matcherMatches('SessionStart', 'compact|resume', ss), true);
    assert.equal(P.matcherMatches('SessionStart', 'startup', ss), false);
    const pt = { hook_event_name: 'PostToolUse', tool_name: 'Bash' };
    assert.equal(P.matcherMatches('PostToolUse', 'Agent|Explore|Task', pt), false);
    assert.equal(P.matcherMatches('PostToolUse', 'Bash', pt), true);
    // Events with no matcher subject: matcher is inert, never a false gap.
    assert.equal(P.matcherMatches('SubagentStop', 'anything', { hook_event_name: 'SubagentStop' }), true);
  });
});
