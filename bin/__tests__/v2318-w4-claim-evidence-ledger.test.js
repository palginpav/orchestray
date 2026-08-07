#!/usr/bin/env node
'use strict';

/**
 * v2318-w4-claim-evidence-ledger.test.js — Claim–Evidence Ledger (v2.3.18 W4, new).
 *
 * CEL replaces five hand-written point-gates with one engine over a rule table.
 * The tests are in three layers:
 *
 *   1. Table-driven over every rule in `claim-rules.js` — claiming+evidenced,
 *      claiming+unevidenced, weak-evidence. A rule with no fixture fails the
 *      suite, so coverage cannot silently rot as rules are added.
 *   2. Retirement proofs — each retired point-gate's original case, asserted
 *      caught by its ported rule. These exist so the deletions are provable.
 *   3. Gate behaviour — ramp, ledger, kill switches, fail-open.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/v2318-w4-claim-evidence-ledger.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'validate-claim-evidence.js');
const NODE      = process.execPath;

const {
  RULES,
  SR_ASSERTIONS,
  EXECUTION_ROLES,
  matchClaims,
  findEvidence,
  syntheticClaims,
  evaluateAssertions,
  toSentences,
  stripNonTestimony,
  stripStructuredResultSection,
  stripStructuredResultFences,
  subtractIssueLeaves,
  extractStructuredResult,
  rawOutputText,
  RAW_OUTPUT_FIELDS,
  SYNTHETIC_PREFIX,
} = require('../_lib/claim-rules');
const { extractToolCalls, callHaystack } = require('../_lib/transcript-tools');
const {
  evaluateSpawn,
  buildClaimText,
  loadClaimEvidenceConfig,
  bumpWarnCounts,
  rampKey,
  counterFilePath,
  readAuditEventTypes,
  resolveSpawnStart,
  scopeEvent,
  eventRole,
} = require('../validate-claim-evidence');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const call = (name, input) => ({ name, input, idx: 0 });

/**
 * One fixture per rule id. `weak: null` means the rule has no weak state by
 * construction (see mcp-grounded — a non-MCP tool is not partial evidence of
 * an MCP lookup, it is no evidence at all).
 */
const RULE_FIXTURES = {
  'tests-run': {
    role: 'tester',
    sentence: 'The full test suite passes after my change.',
    strong: call('Bash', { command: 'npm test' }),
    weak:   call('Bash', { command: 'ls -la bin/' }),
  },
  'no-regressions': {
    role: 'developer',
    sentence: 'There are no regressions in the existing behaviour.',
    strong: call('Bash', { command: 'node --test tests/' }),
    weak:   call('Bash', { command: 'git status' }),
  },
  'lint-run': {
    role: 'developer',
    sentence: 'Lint is clean on the changed files.',
    strong: call('Bash', { command: 'npm run lint' }),
    weak:   call('Bash', { command: 'echo done' }),
  },
  'build-clean': {
    role: 'developer',
    sentence: 'The build is clean with no type errors.',
    strong: call('Bash', { command: 'npx tsc --noEmit' }),
    weak:   call('Bash', { command: 'pwd' }),
  },
  'verified-behavior': {
    role: 'developer',
    sentence: 'I verified that the hook fires on SubagentStop.',
    strong: call('Bash', { command: 'node bin/validate-claim-evidence.js' }),
    weak:   call('Read', { file_path: '/repo/bin/validate-claim-evidence.js' }),
  },
  'all-call-sites': {
    role: 'refactorer',
    sentence: 'Updated all call sites of the renamed helper.',
    strong: call('Grep', { pattern: 'renamedHelper' }),
    weak:   call('Bash', { command: 'ls bin/' }),
  },
  'hook-registered': {
    role: 'developer',
    sentence: 'Wired it into hooks.json under SubagentStop.',
    strong: call('Edit', { file_path: '/repo/hooks/hooks.json' }),
    weak:   call('Edit', { file_path: '/repo/bin/foo.js' }),
  },
  'docs-updated': {
    role: 'documenter',
    sentence: 'Updated the README with the new configuration flag.',
    strong: call('Edit', { file_path: '/repo/README.md' }),
    weak:   call('Edit', { file_path: '/repo/bin/foo.js' }),
  },
  'measured-number': {
    role: 'developer',
    sentence: 'Measured the hook at 15 ms per invocation.',
    strong: call('Bash', { command: 'time node bin/validate-claim-evidence.js' }),
    weak:   call('Read', { file_path: '/repo/bin/foo.js' }),
  },
  'diff-reviewed': {
    role: 'reviewer',
    sentence: 'I reviewed the git diff for this change.',
    strong: call('Bash', { command: 'git diff HEAD' }),
    weak:   call('Bash', { command: 'ls bin/' }),
  },
  'pattern-applied': {
    role: 'developer',
    sentence: 'Applied the pattern from the catalog to this refactor.',
    strong: call('mcp__orchestray__pattern_record_application', { slug: 'mechanical-over-prose' }),
    weak:   call('Read', { file_path: '/repo/bin/foo.js' }),
  },
  'research-sourced': {
    role: 'researcher',
    sentence: 'Produced a decision-ready shortlist of three candidate libraries.',
    strong: call('WebFetch', { url: 'https://example.com/docs' }),
    weak:   call('Read', { file_path: '/repo/package.json' }),
  },
  'oracle-grounded': {
    role: 'platform-oracle',
    sentence: 'Each claim carries a stability_tier and a source_url.',
    strong: call('WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }),
    weak:   call('Read', { file_path: '/repo/CLAUDE.md' }),
  },
  'mcp-grounded': {
    role: 'architect',
    sentence: SYNTHETIC_PREFIX + 'result produced by a grounding-required role.',
    strong: call('mcp__orchestray__pattern_find', { task_summary: 'design a gate' }),
    weak:   null,
  },
};

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w4-cel-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function seedOrchestration(dir, orchId) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8',
  );
}

/**
 * @param {string} [at] ISO timestamp for every line — real transcript lines
 *                      carry one, and W6e's spawn window is derived from it.
 */
function writeTranscript(dir, lines, name, at) {
  const p = path.join(dir, name || 'transcript.jsonl');
  const timestamp = at || new Date().toISOString();
  fs.writeFileSync(
    p,
    lines.map(c => JSON.stringify({
      type: 'assistant',
      timestamp,
      message: { content: [{ type: 'tool_use', name: c.name, input: c.input }] },
    })).join('\n') + '\n',
    'utf8',
  );
  return p;
}

function readEvents(root) {
  try {
    return fs.readFileSync(path.join(root, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function readLedger(root, orchId) {
  try {
    return fs.readFileSync(path.join(root, '.orchestray', 'state', 'claim-ledger-' + orchId + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function runHook(payload, cwd, extraEnv) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Layer 1 — table-driven rule coverage
// ---------------------------------------------------------------------------

describe('claim-rules: table-driven coverage', () => {
  test('every rule has a fixture (coverage cannot rot)', () => {
    const missing = RULES.map(r => r.id).filter(id => !RULE_FIXTURES[id]);
    assert.deepEqual(missing, [], 'rules without a test fixture: ' + missing.join(', '));
    const orphaned = Object.keys(RULE_FIXTURES).filter(id => !RULES.some(r => r.id === id));
    assert.deepEqual(orphaned, [], 'fixtures for rules that no longer exist: ' + orphaned.join(', '));
  });

  test('rule ids are unique', () => {
    const ids = RULES.map(r => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const rule of RULES) {
    const fx = RULE_FIXTURES[rule.id];
    if (!fx) continue;

    test(`[${rule.id}] claiming sentence is matched for role ${fx.role}`, () => {
      const matched = matchClaims(fx.sentence, fx.role).map(m => m.rule.id);
      assert.ok(matched.includes(rule.id), `expected ${rule.id} in [${matched.join(', ')}]`);
    });

    test(`[${rule.id}] claiming + evidenced → strong`, () => {
      const ev = findEvidence(rule, [fx.strong]);
      assert.ok(ev, 'expected evidence');
      assert.equal(ev.strength, 'strong');
      assert.equal(ev.tool, fx.strong.name);
    });

    test(`[${rule.id}] claiming + unevidenced → null`, () => {
      assert.equal(findEvidence(rule, []), null);
      // An unrelated tool call is not evidence either.
      const ev = findEvidence(rule, [call('TodoWrite', { todos: [] })]);
      assert.ok(!ev || ev.strength !== 'strong', 'TodoWrite must not satisfy any rule');
    });

    if (fx.weak) {
      test(`[${rule.id}] weak evidence is graded weak, not strong`, () => {
        const ev = findEvidence(rule, [fx.weak]);
        assert.ok(ev, 'expected weak evidence record');
        assert.equal(ev.strength, 'weak');
      });
    }

    test(`[${rule.id}] does not apply outside its declared roles`, () => {
      if (rule.roles.includes('*')) return;
      const outsider = ['pm', 'ux-critic', 'release-manager', 'inventor']
        .find(r => !rule.roles.includes(r));
      const matched = matchClaims(fx.sentence, outsider).map(m => m.rule.id);
      assert.ok(!matched.includes(rule.id), `${rule.id} leaked to role ${outsider}`);
    });
  }
});

describe('claim-rules: table hygiene', () => {
  test('every rule declares severity, remedy and a role list', () => {
    for (const r of RULES) {
      assert.ok(['block', 'warn'].includes(r.severity), `${r.id} severity`);
      assert.ok(typeof r.remedy === 'string' && r.remedy.length > 10, `${r.id} remedy`);
      assert.ok(Array.isArray(r.roles) && r.roles.length > 0, `${r.id} roles`);
      assert.ok(r.claim instanceof RegExp, `${r.id} claim regex`);
      assert.ok(r.evidence && Array.isArray(r.evidence.tools), `${r.id} evidence.tools`);
    }
  });

  test('every claim-triggered remedy offers a downgrade path, so the gate cannot wedge a spawn', () => {
    // The two-remedy contract: produce evidence, OR restate the claim.
    // `role_critical` rules are exempt — their trigger is the role, not a
    // claim, so there is nothing to downgrade (see mcp-grounded).
    for (const r of RULES) {
      if (r.role_critical) continue;
      assert.match(r.remedy, /\bor\b/i, `${r.id} must offer an "or ..." downgrade`);
    }
  });

  test('an oracle that asserts nothing is not forced to have fetched', () => {
    assert.deepEqual(syntheticClaims({ summary: 'No documented behaviour found.' }, 'platform-oracle', []), []);
    assert.deepEqual(
      syntheticClaims({ claims: [{ answer: 'yes' }] }, 'platform-oracle', []),
      [SYNTHETIC_PREFIX + 'platform claims asserted with stability_tier and source_url grounding.'],
    );
  });

  test('rules that replace a point-gate record their provenance', () => {
    const ported = RULES.filter(r => r.ported_from).map(r => r.ported_from);
    for (const gate of [
      'validate-tester-runs-tests.js',
      'validate-pattern-application.js',
      'validate-researcher-citations.js',
      'validate-platform-oracle-grounding.js',
      'validate-mcp-grounding.js',
    ]) {
      assert.ok(ported.some(p => p.startsWith(gate)), `no rule claims to replace ${gate}`);
    }
  });

  test('retired point-gate scripts are gone from bin/', () => {
    for (const gate of [
      'validate-tester-runs-tests.js',
      'validate-pattern-application.js',
      'validate-researcher-citations.js',
      'validate-platform-oracle-grounding.js',
      'validate-mcp-grounding.js',
    ]) {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, 'bin', gate)), false, `${gate} still present`);
    }
    // validate-reviewer-git-diff.js is deliberately KEPT: it provisions the
    // diff at PreToolUse, which CEL's claim→evidence model cannot express.
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'bin', 'validate-reviewer-git-diff.js')));
  });

  test('hooks.json registers CEL on SubagentStop and no retired gate', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const cmds = (hooks.hooks.SubagentStop || []).flatMap(g => (g.hooks || []).map(h => h.command));
    assert.ok(cmds.some(c => c.endsWith('validate-claim-evidence.js')), 'CEL registered');
    for (const gate of [
      'validate-tester-runs-tests.js',
      'validate-pattern-application.js',
      'validate-researcher-citations.js',
      'validate-platform-oracle-grounding.js',
      'validate-mcp-grounding.js',
    ]) {
      assert.ok(!cmds.some(c => c.endsWith(gate)), `${gate} still wired`);
    }
    // Ordering: CEL runs after metrics collection, before the auto-commit hook
    // (which would otherwise commit work the gate is about to reject).
    const idx = (name) => cmds.findIndex(c => c.endsWith(name));
    assert.ok(idx('collect-agent-metrics.js') < idx('validate-claim-evidence.js'), 'CEL after metrics');
    assert.ok(idx('validate-claim-evidence.js') < idx('auto-commit-worktree-on-subagent-stop.js'), 'CEL before auto-commit');
  });

  test('SR assertions cover the oracle single-claim mode', () => {
    // No claims[]/findings[] array — top-level fields are checked instead.
    const fails = evaluateAssertions({ stability_tier: 'stable', source_url: 'https://x' }, 'platform-oracle');
    assert.deepEqual(fails, []);
    const bad = evaluateAssertions({ stability_tier: 'stable' }, 'platform-oracle');
    assert.equal(bad.length, 1);
    assert.match(bad[0].violations[0], /source_url/);
  });

  test('syntheticClaims is empty for an unremarkable developer spawn', () => {
    assert.deepEqual(syntheticClaims(null, 'developer', []), []);
    assert.deepEqual(syntheticClaims({ summary: 'renamed a variable' }, 'developer', []), []);
  });

  test('a throwing SR assertion check cannot take the gate down', () => {
    const rogue = { id: 'rogue', roles: ['developer'], severity: 'block', remedy: 'x or y',
      ported_from: 'n/a', check() { throw new Error('boom'); } };
    SR_ASSERTIONS.push(rogue);
    try {
      assert.deepEqual(evaluateAssertions({ summary: 's' }, 'developer'), []);
    } finally {
      SR_ASSERTIONS.pop();
    }
  });
});

describe('claim-rules: engine primitives', () => {
  test('toSentences drops over-long paragraphs', () => {
    assert.deepEqual(toSentences('x'.repeat(500)), []);
  });

  test('toSentences strips bullets and drops fragments', () => {
    const s = toSentences('- Tests pass.\n* Lint is clean.\nok\n');
    assert.ok(s.includes('Tests pass.'));
    assert.ok(s.includes('Lint is clean.'));
    assert.ok(!s.includes('ok'), 'fragments under 9 chars are dropped');
  });

  test('argRe matches toolName + JSON.stringify(input) — Grep satisfies a grep rule', () => {
    // Prototype finding #1: matching input alone makes the Grep tool fail a
    // rule that requires grepping, because its input carries no "grep" token.
    const grepCall = call('Grep', { pattern: 'foo' });
    assert.ok(!/grep|rg\b|Grep/.test(JSON.stringify(grepCall.input)), 'precondition: input alone has no token');
    assert.ok(/grep|rg\b|Grep/.test(callHaystack(grepCall)), 'name+input haystack matches');
    const rule = RULES.find(r => r.id === 'all-call-sites');
    assert.equal(findEvidence(rule, [grepCall]).strength, 'strong');
  });

  test('callHaystack truncates oversized inputs without throwing', () => {
    const hay = callHaystack(call('Bash', { command: 'x'.repeat(100000) }));
    assert.ok(hay.length < 20000);
    assert.ok(hay.startsWith('Bash '));
  });

  test('findEvidence tolerates a null/empty call list', () => {
    assert.equal(findEvidence(RULES[0], null), null);
    assert.equal(findEvidence(RULES[0], []), null);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — retirement proofs
// ---------------------------------------------------------------------------

describe('retirement proofs: each retired point-gate\'s case is caught by CEL', () => {
  test('validate-tester-runs-tests: tests_passing:true with no runner → gap', () => {
    const sr = { status: 'complete', summary: 'Wrote the tests.', tests_passing: true };
    const synth = syntheticClaims(sr, 'tester', []);
    const matched = matchClaims(synth.join('\n'), 'tester').map(m => m.rule.id);
    assert.ok(matched.includes('tests-run'), 'synthetic claim from tests_passing must match tests-run');
    assert.equal(findEvidence(RULES.find(r => r.id === 'tests-run'), [call('Read', { file_path: '/x' })]).strength, 'weak');
    // And it passes when a runner really ran.
    assert.equal(
      findEvidence(RULES.find(r => r.id === 'tests-run'), [call('Bash', { command: 'npm test' })]).strength,
      'strong',
    );
  });

  test('validate-pattern-application: pattern_find called, never acked → gap', () => {
    const calls = [call('mcp__orchestray__pattern_find', { task_summary: 'x' })];
    const synth = syntheticClaims({ summary: 'done' }, 'developer', calls);
    const matched = matchClaims(synth.join('\n'), 'developer').map(m => m.rule.id);
    assert.ok(matched.includes('pattern-applied'), 'pattern_find in the transcript creates the ack obligation');
    assert.equal(findEvidence(RULES.find(r => r.id === 'pattern-applied'), calls), null, 'pattern_find alone is not an ack');
    const acked = calls.concat([call('mcp__orchestray__pattern_record_application', { slug: 's' })]);
    assert.equal(findEvidence(RULES.find(r => r.id === 'pattern-applied'), acked).strength, 'strong');
  });

  test('validate-researcher-citations: verdict with too few sources → assertion violation', () => {
    const sr = { verdict: 'use zod', sources: ['https://a'] };
    const fails = evaluateAssertions(sr, 'researcher').map(f => f.assertion.id);
    assert.ok(fails.includes('researcher-min-sources'));
    assert.deepEqual(evaluateAssertions({ verdict: 'no_clear_fit' }, 'researcher'), [], 'no_clear_fit passes through');
    assert.deepEqual(
      evaluateAssertions({ verdict: 'use zod', sources: ['a', 'b', 'c'] }, 'researcher'), [],
      '3 sources satisfies the minimum',
    );
  });

  test('validate-researcher-citations: researcher verdict with zero fetches → gap (the case the old gate missed)', () => {
    // Live corroboration 2026-08-06: the researcher ran with zero WebFetch and
    // the old gate — which only counted the self-reported `sources` array —
    // did not fire. CEL checks the transcript instead.
    const sr = { verdict: 'use zod', sources: ['https://a', 'https://b', 'https://c'] };
    assert.deepEqual(evaluateAssertions(sr, 'researcher'), [], 'old gate is satisfied by the array alone');
    const synth = syntheticClaims(sr, 'researcher', []);
    const matched = matchClaims(synth.join('\n'), 'researcher').map(m => m.rule.id);
    assert.ok(matched.includes('research-sourced'), 'CEL raises the claim from the verdict');
    assert.equal(findEvidence(RULES.find(r => r.id === 'research-sourced'), []), null, 'zero fetches → no evidence');
  });

  test('validate-platform-oracle-grounding: missing tier/url → assertion violation', () => {
    const fails = evaluateAssertions({ claims: [{ answer: 'yes' }] }, 'platform-oracle');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].assertion.id, 'oracle-claim-grounding');
    assert.equal(fails[0].violations.length, 2, 'both stability_tier and source_url reported');
    assert.deepEqual(
      evaluateAssertions({ claims: [{ stability_tier: 'stable', source_url: 'https://x' }] }, 'platform-oracle'),
      [],
    );
    assert.deepEqual(
      evaluateAssertions({ claims: [{ stability_tier: 'rumour', source_url: 'https://x' }] }, 'platform-oracle')[0].violations.length,
      1,
      'invalid tier value is still a violation',
    );
  });

  test('validate-platform-oracle-grounding: oracle answer with zero WebFetch → gap', () => {
    const sr = { claims: [{ stability_tier: 'stable', source_url: 'https://x' }] };
    assert.deepEqual(evaluateAssertions(sr, 'platform-oracle'), [], 'schema check alone is satisfied');
    const synth = syntheticClaims(sr, 'platform-oracle', []);
    const matched = matchClaims(synth.join('\n'), 'platform-oracle').map(m => m.rule.id);
    assert.ok(matched.includes('oracle-grounded'));
    assert.equal(findEvidence(RULES.find(r => r.id === 'oracle-grounded'), []), null);
  });

  test('validate-mcp-grounding: allowlisted role with zero MCP calls → gap; any mcp__ call satisfies', () => {
    for (const role of ['pm', 'researcher', 'debugger', 'architect']) {
      const synth = syntheticClaims({ summary: 'done' }, role, []);
      const matched = matchClaims(synth.join('\n'), role).map(m => m.rule.id);
      assert.ok(matched.includes('mcp-grounded'), `mcp-grounded must apply to ${role}`);
    }
    const rule = RULES.find(r => r.id === 'mcp-grounded');
    assert.equal(findEvidence(rule, [call('Bash', { command: 'ls' })]), null);
    assert.equal(findEvidence(rule, [call('mcp__orchestray__kb_search', { query: 'x' })]).strength, 'strong');
    // Non-allowlisted roles are untouched.
    const synth = syntheticClaims({ summary: 'done' }, 'developer', []);
    assert.ok(!synth.some(s => /grounding-required/.test(s)));
  });

  test('SR assertions are scoped to their roles', () => {
    assert.deepEqual(evaluateAssertions({ verdict: 'x', sources: [] }, 'developer'), []);
    assert.deepEqual(evaluateAssertions({ claims: [{}] }, 'developer'), []);
  });

  test('every SR assertion declares a ported_from provenance', () => {
    for (const a of SR_ASSERTIONS) {
      assert.ok(a.ported_from, `${a.id} must record which gate it came from`);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — transcript reader
// ---------------------------------------------------------------------------

describe('transcript-tools', () => {
  let dir;
  beforeEach(() => { dir = makeFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('extracts tool_use blocks in order', () => {
    const p = writeTranscript(dir, [
      call('Read', { file_path: '/a' }),
      call('Bash', { command: 'npm test' }),
    ]);
    const calls = extractToolCalls(p, { cwd: dir });
    assert.deepEqual(calls.map(c => c.name), ['Read', 'Bash']);
    assert.deepEqual(calls.map(c => c.idx), [0, 1]);
  });

  test('malformed transcript lines are skipped, not fatal', () => {
    const p = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(p, 'not json\n{"broken\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n', 'utf8');
    const calls = extractToolCalls(p, { cwd: dir });
    assert.deepEqual(calls.map(c => c.name), ['Bash']);
  });

  test('missing / empty / non-contained transcript → []', () => {
    assert.deepEqual(extractToolCalls(path.join(dir, 'nope.jsonl'), { cwd: dir }), []);
    assert.deepEqual(extractToolCalls('', { cwd: dir }), []);
    assert.deepEqual(extractToolCalls(undefined, { cwd: dir }), []);
    assert.deepEqual(extractToolCalls('../../etc/passwd', { cwd: dir }), []);
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '', 'utf8');
    assert.deepEqual(extractToolCalls(empty, { cwd: dir }), []);
  });

  test('bounded tail read: only the last maxBytes are scanned', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Filler', input: { pad: 'x'.repeat(200) } }] } }));
    }
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }));
    const p = path.join(dir, 'big.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    const calls = extractToolCalls(p, { cwd: dir, maxBytes: 2048 });
    assert.ok(calls.length < 200, 'tail bound applied');
    assert.ok(calls.some(c => c.name === 'Bash'), 'most recent calls are retained');
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — gate behaviour
// ---------------------------------------------------------------------------

describe('validate-claim-evidence gate', () => {
  let dir;
  const ORCH = 'orch-w4-test';
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const payloadFor = (over) => Object.assign({
    hook_event_name: 'SubagentStop',
    subagent_type: 'developer',
    cwd: dir,
  }, over);

  test('no claims → exit 0 with claim_evidence_ok', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stdout } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"status":"complete","summary":"Renamed a local variable.","files_changed":[],"files_read":["/a"],"issues":[],"assumptions":[]}\n```',
    }), dir);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), { continue: true });
    const evts = readEvents(dir).filter(e => e.type === 'claim_evidence_ok');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].gap_count, 0);
  });

  test('evidenced claim → exit 0 with claim_evidence_ok', () => {
    const p = writeTranscript(dir, [call('Bash', { command: 'npm test' })]);
    const { status } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"status":"complete","summary":"Added the gate. The test suite passes.","files_changed":["bin/x.js"],"files_read":["bin/y.js"],"issues":[],"assumptions":[]}\n```',
    }), dir);
    assert.equal(status, 0);
    const evts = readEvents(dir).filter(e => e.type === 'claim_evidence_ok');
    assert.equal(evts.length, 1);
    assert.ok(evts[0].claims_count >= 1, 'the claim was seen and satisfied');
  });

  test('ramp not exhausted → exit 0 with claim_evidence_gap', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"status":"complete","summary":"Added the hook, wired it into hooks.json, lint + tests green.","files_changed":["bin/x.js"],"files_read":["bin/y.js"],"issues":[],"assumptions":[]}\n```',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '3' });
    assert.equal(status, 0, 'ramp window is warn-only');
    assert.match(stderr, /WARN \(1\/3\)/);
    const evts = readEvents(dir).filter(e => e.type === 'claim_evidence_gap');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].ramp_state, 'warn');
    assert.ok(evts[0].rule_ids.includes('tests-run'));
    assert.ok(evts[0].rule_ids.includes('hook-registered'));
  });

  test('ramp exhausted → exit 2 with a two-remedy message and claim_evidence_blocked', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const payload = payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"status":"complete","summary":"Lint is clean and the test suite passes.","files_changed":["bin/x.js"],"files_read":["bin/y.js"],"issues":[],"assumptions":[]}\n```',
    });
    const env = { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' };
    const { status, stdout, stderr } = runHook(payload, dir, env);
    assert.equal(status, 2);
    assert.match(stderr, /BLOCKED/);
    assert.match(stderr, /Either produce the evidence,/);
    assert.match(stderr, /rewrite the claim to match what you actually did/);
    assert.match(stderr, /-> Run the test suite, or restate as/);
    assert.equal(JSON.parse(stdout).continue, false);
    const evts = readEvents(dir).filter(e => e.type === 'claim_evidence_blocked');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].ramp_state, 'blocked');
  });

  test('ledger rows are appended per spawn', () => {
    const p = writeTranscript(dir, [call('Bash', { command: 'npm test' })]);
    runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"status":"complete","summary":"The test suite passes but lint is clean was not checked.","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '9' });
    const rows = readLedger(dir, ORCH);
    assert.ok(rows.length >= 1, 'ledger written');
    const testsRow = rows.find(r => r.rule_id === 'tests-run');
    assert.ok(testsRow, 'tests-run recorded');
    assert.equal(testsRow.evidenced, true);
    assert.equal(testsRow.evidence_tool, 'Bash');
    assert.equal(testsRow.orchestration_id, ORCH);
    assert.ok(testsRow.ts, 'timestamped');
  });

  test('malformed transcript → fail-open exit 0', () => {
    const p = path.join(dir, 'garbage.jsonl');
    fs.writeFileSync(p, '\\u0000\\u0000not-json-at-all\n{{{\n', 'utf8');
    const { status } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"status":"complete","summary":"Nothing claimed here.","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'a broken transcript must never wedge an orchestration');
  });

  test('malformed stdin → fail-open exit 0', () => {
    const r = cp.spawnSync(NODE, [HOOK_PATH], { input: '{not json', cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0);
  });

  test('non-SubagentStop event → exit 0, no events', () => {
    const { status } = runHook(payloadFor({ hook_event_name: 'Stop' }), dir);
    assert.equal(status, 0);
    assert.equal(readEvents(dir).filter(e => String(e.type || '').startsWith('claim_evidence')).length, 0);
  });

  test('env kill switch → exit 0, no events', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"summary":"Lint is clean and the test suite passes."}\n```',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_DISABLED: '1', ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0);
    assert.equal(readEvents(dir).filter(e => String(e.type || '').startsWith('claim_evidence')).length, 0);
  });

  test('config enabled:false → exit 0, no events', () => {
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ claim_evidence_ledger: { enabled: false } }), 'utf8');
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"summary":"Lint is clean and the test suite passes."}\n```',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0);
    assert.equal(readEvents(dir).filter(e => String(e.type || '').startsWith('claim_evidence')).length, 0);
  });

  test('config block:false → telemetry only, ledger still written', () => {
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ claim_evidence_ledger: { enabled: true, block: false } }), 'utf8');
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status } = runHook(payloadFor({
      transcript_path: p,
      output: '## Structured Result\n```json\n{"summary":"Lint is clean and the test suite passes."}\n```',
    }), dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'block:false never exits 2');
    const evts = readEvents(dir).filter(e => e.type === 'claim_evidence_gap');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].ramp_state, 'telemetry_only');
    assert.ok(readLedger(dir, ORCH).length >= 1, 'ledger survives block:false');
  });

  test('loadClaimEvidenceConfig defaults and coercion', () => {
    assert.deepEqual(loadClaimEvidenceConfig(dir), { enabled: true, ramp: 3, block: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ claim_evidence_ledger: { ramp: 'nope', block: 'nope' } }), 'utf8');
    assert.deepEqual(loadClaimEvidenceConfig(dir), { enabled: true, ramp: 3, block: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), 'not json', 'utf8');
    assert.deepEqual(loadClaimEvidenceConfig(dir), { enabled: true, ramp: 3, block: true });
  });
});

describe('validate-claim-evidence: evaluateSpawn unit', () => {
  let dir;
  beforeEach(() => { dir = makeFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('one verdict per rule even when several sentences claim it', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const res = evaluateSpawn({
      subagent_type: 'developer',
      transcript_path: p,
      structured_result: { summary: 'The tests pass. Also the suite passes. And the spec passes.' },
    }, dir);
    assert.ok(res.claimsCount >= 3, 'claim density counts every claiming sentence');
    assert.equal(res.rows.filter(r => r.rule_id === 'tests-run').length, 1, 'one ledger row per rule');
  });

  test('buildClaimText pulls summary and assumptions, never issues[]', () => {
    const text = buildClaimText(
      { output: 'trailing prose about the diff' },
      { summary: 'S1', issues: [{ detail: 'D1' }, { description: 'D2' }], assumptions: ['A1'] },
    );
    for (const frag of ['S1', 'A1', 'trailing prose']) {
      assert.ok(text.includes(frag), `missing ${frag}`);
    }
    // E2: an issue is a finding about someone else's work, not testimony.
    assert.ok(!text.includes('D1'), 'issues[].detail must not enter the claim corpus');
    assert.ok(!text.includes('D2'), 'issues[].description must not enter the claim corpus');
  });

  test('agent_transcript_path is accepted as well as transcript_path', () => {
    const p = writeTranscript(dir, [call('Bash', { command: 'npm test' })]);
    const res = evaluateSpawn({
      subagent_type: 'developer',
      agent_transcript_path: p,
      structured_result: { summary: 'The test suite passes.' },
    }, dir);
    assert.equal(res.tool_call_count, 1);
    assert.equal(res.gaps.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — false-positive regressions found in review (E1-E5)
//
// Every case below was reproduced end-to-end against the pre-fix gate. They are
// the reason the ramp existed at all: without them the "telemetry-first" budget
// was spent on claims nobody made.
// ---------------------------------------------------------------------------

/** The rubric an architect is REQUIRED to emit by rubric-format.md §2-3. */
const RUBRIC_SECTION = [
  '## Acceptance Rubric',
  '```yaml',
  '# criteria derive from the design spec',
  '- id: AC-01',
  '  criterion: "The existing bin/__tests__ suite passes with the new logic."',
  '  category: correctness',
  '- id: AC-02',
  '  criterion: "npm run build is clean after the change."',
  '  category: correctness',
  '- id: AC-03',
  '  criterion: "No regressions in the sibling gates."',
  '  category: correctness',
  '```',
].join('\n');

const srBlock = (sr) => '## Structured Result\n```json\n' + JSON.stringify(sr) + '\n```';

describe('E1: the architect\'s own mandated rubric is not testimony', () => {
  let dir;
  const ORCH = 'orch-e1';
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('execution rules are scoped to roles that can actually execute', () => {
    for (const id of ['tests-run', 'no-regressions', 'build-clean', 'lint-run']) {
      const rule = RULES.find(r => r.id === id);
      assert.ok(rule, id + ' exists');
      assert.deepEqual(rule.roles, EXECUTION_ROLES, id + ' must not be roles: ["*"]');
      for (const role of ['architect', 'reviewer', 'pm', 'documenter']) {
        assert.ok(!rule.roles.includes(role), id + ' must not apply to ' + role);
      }
    }
  });

  test('rubric sections are stripped from the claim corpus, heading and fence alike', () => {
    const stripped = stripNonTestimony('Prose before.\n' + RUBRIC_SECTION + '\n## After\nProse after.');
    assert.ok(!stripped.includes('suite passes'), 'criterion text survived the strip');
    assert.ok(!stripped.includes('build is clean'));
    assert.ok(stripped.includes('Prose before.'));
    assert.ok(stripped.includes('Prose after.'), 'a YAML comment must not end the section early');
  });

  test('buildClaimText drops the rubric even when the tail cuts through it', () => {
    const payload = { output: 'x'.repeat(20000) + '\n' + RUBRIC_SECTION };
    const text = buildClaimText(payload, null);
    assert.ok(!text.includes('suite passes'), 'rubric must be stripped before the 8KB tail slice');
  });

  test('architect emitting a rubric → exit 0, even with the ramp fully closed', () => {
    // Reviewer repro: 4 rules fired and the hook exited 2 on this exact shape.
    // kb_search, not pattern_find — the latter raises its own ack obligation.
    const p = writeTranscript(dir, [call('mcp__orchestray__kb_search', { query: 'gates' })]);
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'architect',
      cwd: dir,
      transcript_path: p,
      output: 'Design complete.\n\n' + RUBRIC_SECTION + '\n\n' + srBlock({
        status: 'complete', summary: 'Designed the gate.',
        files_changed: [], files_read: ['bin/x.js'], issues: [], assumptions: [],
      }),
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'architect blocked by its own mandated rubric: ' + stderr);
  });

  test('the strip does not blind the gate to real claims outside the rubric', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      cwd: dir,
      transcript_path: p,
      output: RUBRIC_SECTION + '\n\n' + srBlock({
        status: 'complete', summary: 'Implemented it and the test suite passes.',
        files_changed: [{ path: 'bin/x.js', description: 'd' }], files_read: ['bin/y.js'],
        issues: [], assumptions: [],
      }),
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2, 'a developer claiming a green suite with no runner must still block');
    assert.match(stderr, /tests-run/);
  });
});

describe('E2: reported and quoted claim language is not the reporter\'s claim', () => {
  let dir;
  const ORCH = 'orch-e2';
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('a reviewer quoting the developer\'s "tests pass" is not blocked', () => {
    const p = writeTranscript(dir, [call('Bash', { command: 'git diff HEAD' })]);
    const sr = {
      status: 'complete',
      summary: 'Reviewed the change set and filed two findings.',
      files_changed: [], files_read: ['bin/x.js'],
      issues: [{
        severity: 'error',
        detail: 'The developer reported "lint + tests pass" but the transcript shows no Bash call.',
      }],
      assumptions: [],
    };
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'reviewer',
      cwd: dir,
      transcript_path: p,
      output: 'Findings below.\n\n' + srBlock(sr),
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'reviewer charged for the developer\'s evidence: ' + stderr);
  });

  test('the parsed Structured Result fence is not re-scanned as prose', () => {
    const sr = { status: 'complete', summary: 'S1', issues: [{ detail: 'they said tests pass' }] };
    const text = buildClaimText({ output: 'Prose.\n' + srBlock(sr) }, sr);
    assert.ok(text.includes('S1'), 'summary still counts');
    assert.ok(!text.includes('they said tests pass'), 'issues[] must not return via the raw tail');
  });

  test('an unparsed Structured Result block is left in the corpus', () => {
    // sr === null means nothing was harvested structurally; dropping the raw
    // block too would leave the spawn with no corpus at all.
    const raw = 'Prose.\n## Structured Result\n```json\n{broken json, tests pass\n```';
    assert.ok(buildClaimText({ output: raw }, null).includes('tests pass'));
    assert.ok(!stripStructuredResultSection(raw).includes('tests pass'));
  });
});

describe('E3: prefetch-delivered MCP grounding is still grounding', () => {
  let dir;
  const ORCH = 'orch-e3';
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // `timestamp` is not decoration: event-schemas.md declares it on both
  // grounding events and the writer autofills it, so every production row has
  // one. W6e's probe scopes on it, and a fixture that omitted it was asserting
  // against a shape the emitter cannot produce.
  //
  // Attribution is the same story. `mcp_grounding_prefetched` has always carried
  // `role`, and since W7c `prefetch-mcp-grounding.js` stamps `grounded_for` on
  // every `mcp_tool_call` row it writes — because a row that names nobody is
  // indistinguishable from a sibling agent's MCP call (W6e/O-5). Fixtures below
  // carry the stamp the emitter actually writes; `v2210-mcp-prefetch.test.js`
  // holds the emitter to it.
  const seedEvent = (type, orchId, over) => fs.appendFileSync(
    path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
    JSON.stringify(Object.assign({
      type,
      orchestration_id: orchId === undefined ? ORCH : orchId,
      timestamp: new Date().toISOString(),
    }, over)) + '\n',
    'utf8',
  );

  const groundingPayload = (p) => ({
    hook_event_name: 'SubagentStop',
    subagent_type: 'pm',
    cwd: dir,
    transcript_path: p,
    output: srBlock({
      status: 'complete', summary: 'Planned the work.',
      files_changed: [], files_read: [], issues: [], assumptions: [],
    }),
  });

  test('the rule declares the audit events the retired gate counted', () => {
    const rule = RULES.find(r => r.id === 'mcp-grounded');
    assert.deepEqual(rule.evidence.events, ['mcp_grounding_prefetched', 'mcp_tool_call']);
  });

  test('findEvidence accepts an audit event, but only when the transcript is silent', () => {
    const rule = RULES.find(r => r.id === 'mcp-grounded');
    const probe = (wanted) => (wanted.includes('mcp_grounding_prefetched') ? 'mcp_grounding_prefetched' : false);
    const viaEvent = findEvidence(rule, [], { hasAuditEvent: probe });
    assert.equal(viaEvent.strength, 'strong');
    assert.equal(viaEvent.tool, 'audit:mcp_grounding_prefetched');
    const viaCall = findEvidence(rule, [call('mcp__orchestray__kb_search', { query: 'x' })], { hasAuditEvent: probe });
    assert.equal(viaCall.tool, 'mcp__orchestray__kb_search', 'a real call still wins');
    assert.equal(findEvidence(rule, [], { hasAuditEvent: () => false }), null);
    assert.equal(findEvidence(rule, [], { hasAuditEvent: () => { throw new Error('boom'); } }), null);
  });

  test('a prefetch-grounded spawn with zero MCP tool calls → exit 0', () => {
    seedEvent('mcp_grounding_prefetched', undefined, { role: 'pm' });
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook(groundingPayload(p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'prefetch grounding rejected: ' + stderr);
  });

  test('an mcp_tool_call audit event grounds the spawn too', () => {
    seedEvent('mcp_tool_call', undefined, { tool: 'pattern_find', source: 'prefetch', grounded_for: 'pm' });
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    assert.equal(runHook(groundingPayload(p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' }).status, 0);
  });

  test('an ungrounded spawn still blocks — and another orchestration\'s event does not rescue it', () => {
    seedEvent('mcp_grounding_prefetched', 'some-other-orchestration', { role: 'pm' });
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook(groundingPayload(p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2);
    assert.match(stderr, /mcp-grounded/);
  });
});

describe('E5: the ramp budget is per failure mode, not per orchestration', () => {
  let dir;
  const ORCH = 'orch-e5';
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const gapPayload = (role, summary, p) => ({
    hook_event_name: 'SubagentStop',
    subagent_type: role,
    cwd: dir,
    transcript_path: p,
    output: srBlock({
      status: 'complete', summary,
      files_changed: [], files_read: [], issues: [], assumptions: [],
    }),
  });

  test('a different rule keeps its own warn budget', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const env = { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '1' };

    assert.equal(runHook(gapPayload('developer', 'The test suite passes.', p), dir, env).status, 0,
      'tests-run 1/1 → warn');
    assert.equal(runHook(gapPayload('developer', 'Updated the README for the new flag.', p), dir, env).status, 0,
      'docs-updated is a fresh failure mode and must warn, not block');
    assert.equal(runHook(gapPayload('developer', 'The test suite passes.', p), dir, env).status, 2,
      'tests-run 2/1 → its own budget is spent');
  });

  test('a different role keeps its own warn budget', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const env = { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '1' };
    assert.equal(runHook(gapPayload('developer', 'The test suite passes.', p), dir, env).status, 0);
    assert.equal(runHook(gapPayload('tester', 'The test suite passes.', p), dir, env).status, 0,
      'the tester never warned before and must not inherit the developer\'s spent budget');
  });

  test('only the exhausted rules appear in the block message and event', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const env = { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '1' };
    runHook(gapPayload('developer', 'The test suite passes.', p), dir, env);
    const { status, stderr } = runHook(
      gapPayload('developer', 'The test suite passes. Also updated the README.', p), dir, env);
    assert.equal(status, 2);
    assert.match(stderr, /tests-run/);
    assert.ok(!/docs-updated/.test(stderr), 'a rule still inside its ramp must not ride along on a block');
    const blocked = readEvents(dir).filter(e => e.type === 'claim_evidence_blocked');
    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0].rule_ids, ['tests-run']);
  });

  test('counters are stored per key and survive a corrupt file', () => {
    assert.equal(rampKey({ role: 'developer', rule_id: 'tests-run' }), 'developer|tests-run');
    assert.deepEqual(
      bumpWarnCounts(dir, ORCH, ['developer|tests-run', 'tester|tests-run']),
      { 'developer|tests-run': 1, 'tester|tests-run': 1 },
    );
    assert.deepEqual(bumpWarnCounts(dir, ORCH, ['developer|tests-run']), { 'developer|tests-run': 2 });
    const onDisk = JSON.parse(fs.readFileSync(counterFilePath(dir, ORCH), 'utf8'));
    assert.deepEqual(onDisk, { 'developer|tests-run': 2, 'tester|tests-run': 1 });

    fs.writeFileSync(counterFilePath(dir, ORCH), 'not json', 'utf8');
    assert.deepEqual(bumpWarnCounts(dir, ORCH, ['developer|tests-run']), { 'developer|tests-run': 1 });
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — W6e. Three loopholes a re-review proved by execution: a third path
// that re-admitted `issues[]`, an evidence probe scoped to the orchestration
// rather than the spawn, and a self-report that could switch a gate off. Each
// test below was run against the pre-fix sources and failed there.
// ---------------------------------------------------------------------------

describe('W6e/E-01: no path re-admits issues[] into the claim corpus', () => {
  let dir;
  const ORCH = 'orch-w6e';
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** The reviewer's own findings, in the claim language a reviewer must use. */
  const REVIEW_SR = {
    status: 'blocked',
    summary: 'Reviewed the change set and filed two findings.',
    files_changed: [],
    files_read: ['bin/x.js'],
    issues: [
      { severity: 'error', detail: 'The developer said they updated the README, but no Edit exists.' },
      { severity: 'error', detail: 'They claimed they verified that the gate blocks, with no Bash call.' },
    ],
    assumptions: [],
  };

  test('a headingless fence plus an object Structured Result leaks nothing', () => {
    // The exact divergence: extraction prefers `event.structured_result` and
    // never looks at a heading, while the section strip is heading-anchored. A
    // spawn with both therefore had `sr` truthy and no heading to strip.
    const output = 'Findings below.\n\n```json\n' + JSON.stringify(REVIEW_SR, null, 2) + '\n```\n';
    const event = { subagent_type: 'reviewer', structured_result: REVIEW_SR, output };
    const text = buildClaimText(event, extractStructuredResult(event));
    assert.ok(text.includes('Reviewed the change set'), 'the summary is still testimony');
    assert.ok(!text.includes('updated the README'), 'issues[] returned via a headingless fence');
    assert.deepEqual(matchClaims(text, 'reviewer').map(m => m.rule.id), [],
      'a reviewer cannot Edit a doc or run Bash — these rules are a wedge, not a gate');
  });

  test('the same spawn exits 0 end-to-end with the ramp fully closed', () => {
    const p = writeTranscript(dir, [call('Bash', { command: 'git diff HEAD' })]);
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'reviewer',
      cwd: dir,
      transcript_path: p,
      structured_result: REVIEW_SR,
      output: 'Findings below.\n\n```json\n' + JSON.stringify(REVIEW_SR) + '\n```\n',
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'reviewer wedged by its own findings: ' + stderr);
  });

  test('a fence with no info string is judged by its payload', () => {
    const fenced = 'Prose.\n```\n' + JSON.stringify({ issues: [{ detail: 'they updated the README' }] }) + '\n```\nAfter.';
    const stripped = stripStructuredResultFences(fenced);
    assert.ok(!stripped.includes('updated the README'));
    assert.ok(stripped.includes('Prose.') && stripped.includes('After.'));
  });

  test('a fenced block that is not a Structured Result payload survives', () => {
    const fenced = 'Prose.\n```js\nconst x = 1; // I verified that it works\n```\nAfter.';
    assert.equal(stripStructuredResultFences(fenced), fenced, 'only JSON payloads are dropped');
  });

  test('an unclosed json fence swallows the rest, so the strip does too', () => {
    const raw = 'Prose.\n```json\n{"issues":[{"detail":"they updated the README"}]';
    const stripped = stripStructuredResultFences(raw);
    assert.ok(stripped.includes('Prose.'));
    assert.ok(!stripped.includes('updated the README'));
  });

  test('an unparsed Structured Result is still left in the corpus', () => {
    // Unchanged from E2: with sr === null nothing was harvested structurally,
    // and dropping the raw block too would leave the spawn with no corpus.
    const raw = 'Prose.\n## Structured Result\n```json\n{broken json, tests pass\n```';
    assert.ok(buildClaimText({ output: raw }, null).includes('tests pass'));
  });

  test('the strip does not blind the gate to claims made outside the fence', () => {
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const sr = {
      status: 'complete', summary: 'Implemented it and the test suite passes.',
      files_changed: [{ path: 'bin/x.js', description: 'd' }], files_read: ['bin/y.js'],
      issues: [], assumptions: [],
    };
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      cwd: dir,
      transcript_path: p,
      structured_result: sr,
      output: 'Lint is clean too.\n\n```json\n' + JSON.stringify(sr) + '\n```\n',
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2, 'a developer claiming a green suite with no runner must still block');
    assert.match(stderr, /tests-run/);
    assert.match(stderr, /lint-run/, 'prose outside the fence is still testimony');
  });
});

describe('W6e/W-01: both accessors read the output fields in one order', () => {
  test('buildClaimText cannot pick a different field than extractStructuredResult', () => {
    const event = {
      result: 'RESULT-FIELD-MARKER',
      output: 'OUTPUT-FIELD-MARKER',
      agent_output: 'AGENT-OUTPUT-MARKER',
    };
    assert.deepEqual(RAW_OUTPUT_FIELDS,
      ['last_assistant_message', 'result', 'output', 'agent_output']);
    assert.equal(rawOutputText(event), 'RESULT-FIELD-MARKER');
    const text = buildClaimText(event, null);
    assert.ok(text.includes('RESULT-FIELD-MARKER'));
    assert.ok(!text.includes('OUTPUT-FIELD-MARKER'),
      'divergent precedence is what let the strip run against the wrong field');
  });

  test('the divergence itself: sr from `result`, corpus from `output`', () => {
    // Pre-fix, extraction read `result` and the corpus was built from `output`,
    // so the strip ran on text that never held the block and the JSON in
    // `output` — issues[] included — stayed in the corpus.
    const sr = { status: 'complete', summary: 'S', issues: [{ detail: 'they updated the README' }] };
    const event = {
      result: '## Structured Result\n```json\n' + JSON.stringify(sr) + '\n```',
      output: 'Loose dump:\n```json\n' + JSON.stringify(sr) + '\n```',
    };
    const text = buildClaimText(event, extractStructuredResult(event));
    assert.ok(!text.includes('updated the README'));
  });

  test('rawOutputText ignores non-strings and empty strings', () => {
    assert.equal(rawOutputText({ result: '', output: 'X' }), 'X');
    assert.equal(rawOutputText({ result: { a: 1 }, agent_output: 'Y' }), 'Y');
    assert.equal(rawOutputText({}), null);
    assert.equal(rawOutputText(null), null);
  });

  test('last_assistant_message is read, and outranks the legacy field names', () => {
    // The v2.3.19 W1 defect: a live SubagentStop carries this field and no
    // other, so reading only result|output|agent_output emptied the corpus on
    // every production spawn.
    assert.equal(rawOutputText({ last_assistant_message: 'LAM' }), 'LAM');
    assert.equal(rawOutputText({ last_assistant_message: 'LAM', result: 'R' }), 'LAM');
    // Empty is still absent — `realPayload` always sets the key, often to ''.
    assert.equal(rawOutputText({ last_assistant_message: '', result: 'R' }), 'R');
  });

  test('a Structured Result is extracted from last_assistant_message', () => {
    const sr = { status: 'complete', summary: 'S', files_changed: [{ path: 'a.js' }] };
    const event = {
      last_assistant_message: 'Done.\n\n## Structured Result\n\n```json\n' +
        JSON.stringify(sr) + '\n```\n',
    };
    assert.deepEqual(extractStructuredResult(event), sr);
  });
});

describe('W6e/W-02: audit-event evidence is scoped to the spawn', () => {
  let dir;
  const ORCH = 'orch-w6e-scope';
  const GROUNDING = ['mcp_grounding_prefetched', 'mcp_tool_call'];
  beforeEach(() => { dir = makeFixture(); seedOrchestration(dir, ORCH); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const seed = (rows) => fs.appendFileSync(
    path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8',
  );
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  test('another agent\'s mcp_tool_call from an earlier turn does not ground this spawn', () => {
    seed([{
      type: 'mcp_tool_call', tool: 'pattern_record_skip_reason',
      orchestration_id: ORCH, timestamp: ago(3600e3),
    }]);
    const since = Date.now() - 1000;
    assert.deepEqual([...readAuditEventTypes(dir, ORCH, { role: 'pm', since })], []);
    assert.deepEqual([...readAuditEventTypes(dir, ORCH, {})], ['mcp_tool_call'],
      'without a window the row is indistinguishable — that was the whole bug');
  });

  test('a sibling role\'s prefetch does not ground this spawn, however recent', () => {
    seed([{
      type: 'mcp_grounding_prefetched', role: 'documenter',
      orchestration_id: ORCH, timestamp: new Date().toISOString(),
    }]);
    const since = Date.now() - 60e3;
    assert.deepEqual([...readAuditEventTypes(dir, ORCH, { role: 'pm', since })], []);
    assert.deepEqual([...readAuditEventTypes(dir, ORCH, { role: 'documenter', since })],
      ['mcp_grounding_prefetched'], 'the role it names is the role it grounds');
  });

  test('an id-less row is no longer admitted once an orchestration is known', () => {
    seed([{ type: 'mcp_tool_call', timestamp: new Date().toISOString() }]);
    assert.deepEqual([...readAuditEventTypes(dir, ORCH, { role: 'pm', since: Date.now() - 60e3 })], []);
  });

  test('with no orchestration and no window, nothing is attributable', () => {
    seed([{ type: 'mcp_tool_call', orchestration_id: 'someone-else', timestamp: new Date().toISOString() }]);
    assert.deepEqual([...readAuditEventTypes(dir, null, {})], [],
      'a null orchestration id used to mean "every row in the 4MB tail counts"');
  });

  test('the spawn\'s own prefetch still grounds it — the window covers the hook', () => {
    // The prefetch runs in PreToolUse:Agent, before the transcript exists, so
    // its events are always older than the transcript's first line.
    seed([{ type: 'mcp_grounding_prefetched', role: 'pm', orchestration_id: ORCH, timestamp: ago(5000) }]);
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop', subagent_type: 'pm', cwd: dir, transcript_path: p,
      output: srBlock({
        status: 'complete', summary: 'Planned the work.',
        files_changed: [], files_read: [], issues: [], assumptions: [],
      }),
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'prefetch grounding rejected by the window: ' + stderr);
  });

  test('a stale prefetch outside the window no longer grounds the spawn', () => {
    seed([{ type: 'mcp_grounding_prefetched', role: 'pm', orchestration_id: ORCH, timestamp: ago(3600e3) }]);
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook({
      hook_event_name: 'SubagentStop', subagent_type: 'pm', cwd: dir, transcript_path: p,
      output: srBlock({
        status: 'complete', summary: 'Planned the work.',
        files_changed: [], files_read: [], issues: [], assumptions: [],
      }),
    }, dir, { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2);
    assert.match(stderr, /mcp-grounded/);
  });

  // --- W7c: the emitter stamp is the discriminator, not the role ------------
  // Requirement A (E3) and requirement B (O-5) pull in opposite directions on
  // the *same* row shape: the prefetch grounds a spawn that does not exist yet,
  // so its `mcp_tool_call` rows are roleless — exactly like a sibling agent's.
  // Both cases below are the same event type, same orchestration, same grace
  // window; only the stamp differs, and only the stamp decides.

  const pmSpawn = (p) => ({
    hook_event_name: 'SubagentStop', subagent_type: 'pm', cwd: dir, transcript_path: p,
    output: srBlock({
      status: 'complete', summary: 'Planned the work.',
      files_changed: [], files_read: [], issues: [], assumptions: [],
    }),
  });

  test('a sibling\'s unstamped mcp_tool_call inside the grace window does not discharge this spawn', () => {
    // `pattern_record_skip_reason` is not a grounding tool at all, but every
    // Orchestray MCP call writes `mcp_tool_call`. Emitted 5s ago by a
    // concurrently-running agent, it lands inside this spawn's window.
    seed([{
      type: 'mcp_tool_call', tool: 'pattern_record_skip_reason',
      orchestration_id: ORCH, timestamp: ago(5000),
    }]);
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook(pmSpawn(p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2, 'a sibling\'s MCP call discharged this spawn\'s grounding obligation');
    assert.match(stderr, /mcp-grounded/);
  });

  test('the same row stamped for this spawn does discharge it', () => {
    seed([{
      type: 'mcp_tool_call', tool: 'pattern_find', source: 'prefetch',
      grounded_for: 'pm', orchestration_id: ORCH, timestamp: ago(5000),
    }]);
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook(pmSpawn(p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'prefetch-stamped grounding rejected: ' + stderr);
  });

  test('a prefetch stamped for a sibling role does not discharge this spawn', () => {
    seed([{
      type: 'mcp_tool_call', tool: 'pattern_find', source: 'prefetch',
      grounded_for: 'debugger', orchestration_id: ORCH, timestamp: ago(5000),
    }]);
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status } = runHook(pmSpawn(p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2, 'the debugger\'s prefetch grounded the pm');
  });

  test('scopeEvent: each filter in isolation', () => {
    const now = Date.now();
    const ev = (over) => Object.assign({
      type: 'mcp_tool_call', orchestration_id: ORCH, timestamp: new Date(now).toISOString(),
    }, over);
    const mine = (over) => ev(Object.assign({ grounded_for: 'pm' }, over));

    assert.equal(scopeEvent(mine(), ORCH, 'pm', now - 1000), true);
    assert.equal(scopeEvent(mine({ orchestration_id: 'other' }), ORCH, 'pm', now - 1000), false);
    assert.equal(scopeEvent(mine({ orchestration_id: undefined }), ORCH, 'pm', now - 1000), false);
    assert.equal(scopeEvent(ev({ subagent_type: 'developer' }), ORCH, 'pm', now - 1000), false);
    assert.equal(scopeEvent(ev({ grounded_for: 'developer' }), ORCH, 'pm', now - 1000), false,
      'a prefetch stamped for a sibling grounds the sibling, not this spawn');
    assert.equal(scopeEvent(ev({ subagent_type: 'developer' }), ORCH, '', now - 1000), true,
      'an unknown spawn role cannot conflict with anything');
    assert.equal(scopeEvent(mine(), ORCH, 'pm', now + 1000), false, 'before the window');
    assert.equal(scopeEvent(mine({ timestamp: undefined }), ORCH, 'pm', now - 1000), false,
      'an undated event cannot show it is ours');
    assert.equal(scopeEvent(mine({ timestamp: undefined }), ORCH, 'pm', null), true,
      'with no window, orchestration and attribution still decide');

    // The row that used to leak: names nobody, so it belongs to nobody. Before
    // the emitter stamp this returned true and any concurrent agent's MCP call
    // — `pattern_record_skip_reason` included — discharged this spawn's
    // grounding obligation.
    assert.equal(scopeEvent(ev({}), ORCH, 'pm', now - 1000), false,
      'an unattributed row is ambient activity, not this spawn\'s evidence');
  });

  test('eventRole: every attribution field, and silence when there is none', () => {
    assert.equal(eventRole({ agent_role: 'PM' }), 'pm', 'normalised');
    assert.equal(eventRole({ role: ' documenter ' }), 'documenter');
    assert.equal(eventRole({ subagent_type: 'developer' }), 'developer');
    assert.equal(eventRole({ grounded_for: 'architect' }), 'architect');
    assert.equal(eventRole({ role: '', grounded_for: 'pm' }), 'pm', 'an empty field is not attribution');
    assert.equal(eventRole({ tool: 'pattern_find' }), '');
    assert.equal(eventRole({ grounded_for: 42 }), '', 'a non-string names nobody');
    assert.equal(eventRole(null), '');
  });

  test('resolveSpawnStart reads the transcript clock, not the filesystem', () => {
    const at = '2026-08-06T12:00:00.000Z';
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })], 'stamped.jsonl', at);
    assert.equal(resolveSpawnStart(p, dir), Date.parse(at) - 60000, 'grace covers the prefetch hook');

    // No clock in the transcript → no window, rather than a birthtime guess.
    const bare = path.join(dir, 'bare.jsonl');
    fs.writeFileSync(bare, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n', 'utf8');
    assert.equal(resolveSpawnStart(bare, dir), null);
    assert.equal(resolveSpawnStart(path.join(dir, 'missing.jsonl'), dir), null);
    assert.equal(resolveSpawnStart(undefined, dir), null);
  });
});

describe('W7c: the prefetch emitter and this gate agree on the stamp', () => {
  // Every other test in this file seeds events.jsonl by hand, so the emitter and
  // the gate could drift apart without a single assertion failing — and the
  // failure mode is silent: a real prefetch-grounded spawn blocks in production
  // while the suite stays green. Here the rows come from
  // `bin/prefetch-mcp-grounding.js` itself, autofilled orchestration id and all.
  const PREFETCH = path.join(REPO_ROOT, 'bin', 'prefetch-mcp-grounding.js');

  let dir;
  const ORCH = 'orch-w7c-wiring';
  beforeEach(() => {
    dir = makeFixture();
    seedOrchestration(dir, ORCH);
    for (const d of ['patterns', 'history', 'kb/facts', 'kb/decisions', 'kb/artifacts']) {
      fs.mkdirSync(path.join(dir, '.orchestray', ...d.split('/')), { recursive: true });
    }
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const runPrefetch = (role) => cp.spawnSync(NODE, [PREFETCH], {
    input: JSON.stringify({ cwd: dir, tool_input: { subagent_type: role, prompt: 'x' }, tool_name: 'Agent' }),
    encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { ORCHESTRAY_PLUGIN_ROOT: REPO_ROOT }),
  });

  const stopPayload = (role, p) => ({
    hook_event_name: 'SubagentStop', subagent_type: role, cwd: dir, transcript_path: p,
    output: srBlock({
      status: 'complete', summary: 'Planned the work.',
      files_changed: [], files_read: [], issues: [], assumptions: [],
    }),
  });

  test('a real prefetch grounds the spawn it ran for', () => {
    runPrefetch('pm');
    const stamped = readEvents(dir).filter(e => e.type === 'mcp_tool_call' && e.grounded_for);
    assert.ok(stamped.length > 0, 'the emitter wrote no attributable row');
    for (const row of stamped) {
      assert.equal(row.orchestration_id, ORCH, 'scopeEvent filter 1 needs this');
      assert.ok(row.timestamp, 'scopeEvent filter 3 needs this');
    }
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status, stderr } = runHook(stopPayload('pm', p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 0, 'the gate rejected what the emitter wrote: ' + stderr);
  });

  test('a real prefetch for a sibling role does not ground this spawn', () => {
    runPrefetch('debugger');
    const p = writeTranscript(dir, [call('Read', { file_path: '/a' })]);
    const { status } = runHook(stopPayload('pm', p), dir,
      { ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2, 'the debugger\'s prefetch grounded the pm');
  });

  test('the handlers\' own phase:entry rows are not attribution', () => {
    // `_lib/mcp-handler-entry.js` emits one row per handler invocation and knows
    // nothing about the spawn. Those rows are what a sibling's MCP call looks
    // like, so they must not carry a stamp — only this hook's completion rows do.
    runPrefetch('pm');
    const entry = readEvents(dir).filter(e => e.type === 'mcp_tool_call' && e.phase === 'entry');
    assert.ok(entry.length > 0, 'no entry rows — this test is asserting against nothing');
    for (const row of entry) assert.equal(row.grounded_for, undefined);
  });
});

// ---------------------------------------------------------------------------
// W8 C-3: the residual bypasses were the CAPS, not the algorithm
//
// Probing `subtractIssueLeaves` with 15 payload shapes left 2 clean bypasses,
// both of them a bound rather than a miss: a findings list past 500 leaves, and
// a finding nested past 8 levels. Both are reachable by an ordinary large
// review, and both leak another agent's quoted claim into the corpus of a spawn
// that cannot evidence it — a false BLOCK, not a missed one.
// ---------------------------------------------------------------------------

describe('W8/C-3: the leaf-walk bounds do not leak issues[] text', () => {
  /** `n` findings, each carrying prose a claim rule would fire on. */
  const manyIssues = (n) => {
    const issues = [];
    for (let i = 0; i < n; i++) {
      issues.push({
        severity: 'error',
        detail: 'they claimed the test suite passes for case ' + String(i).padStart(6, '0'),
      });
    }
    return { status: 'blocked', summary: 'Filed findings.', issues, assumptions: [] };
  };

  const asProse = (sr) => sr.issues.map((i) => i.detail).join('\n');

  test('a findings list past the OLD 500-leaf cap is fully subtracted', () => {
    for (const n of [600, 1200, 3000]) {
      const sr = manyIssues(n);
      const out = subtractIssueLeaves(asProse(sr), sr);
      const leaked = sr.issues.filter((i) => out.includes(i.detail));
      assert.deepEqual(leaked.map((i) => i.detail), [],
        n + ' findings: the tail past the old cap stayed in the corpus');
    }
  });

  test('a finding nested past the OLD depth-8 cap is subtracted', () => {
    let node = { detail: 'they claimed the test suite passes at depth twelve' };
    for (let i = 0; i < 12; i++) node = { nested: node };
    const sr = { status: 'blocked', summary: 's', issues: [node] };
    assert.ok(!subtractIssueLeaves('they claimed the test suite passes at depth twelve', sr)
      .includes('depth twelve'), 'a deeply nested finding leaked');
  });

  test('past the bound the prose is dropped, never partly scrubbed', () => {
    // The bound cannot go away — subtraction is O(leaves × |src|) and |src| is
    // the 256 KB tail. What it can do is fail toward silence: a corpus scrubbed
    // of the first 3 000 findings and carrying the rest is the leak itself.
    const sr = manyIssues(3100);
    const out = subtractIssueLeaves(asProse(sr) + '\nUnrelated prose.', sr);
    assert.equal(out, '', 'a truncated walk must discard the prose, not ship its tail');
  });

  test('ordinary testimony is untouched — the caps are not a blanket drop', () => {
    const sr = { status: 'complete', summary: 's', issues: [{ detail: 'they said tests pass here' }] };
    const out = subtractIssueLeaves('The test suite passes. Extra prose.', sr);
    assert.equal(out, 'The test suite passes. Extra prose.');
  });

  test('buildClaimText keeps the spawn\'s own words when the walk truncates', () => {
    // The degradation costs claim-gating of raw prose, not the whole corpus:
    // summary and assumptions are harvested structurally, before any strip.
    const sr = manyIssues(3100);
    sr.summary = 'Implemented the gate and the test suite passes.';
    const text = buildClaimText({ subagent_type: 'reviewer', structured_result: sr, output: asProse(sr) }, sr);
    assert.ok(text.includes('the test suite passes'), 'the spawn\'s own summary is still testimony');
    assert.ok(!text.includes('case 000001'), 'no finding text survived');
  });
});

describe('E6: the CEL suite stays discoverable', () => {
  test('this file is plain text, so grep and git can see it', () => {
    // The suite existed but carried two raw NUL bytes in a fail-open fixture,
    // which made grep and `git diff` classify it as binary — a review reported
    // "zero tests reference claim-rules" off a grep that silently skipped it.
    const self = fs.readFileSync(__filename);
    assert.equal(self.filter(b => b === 0).length, 0, 'raw NUL bytes make this file invisible to grep');
    const text = self.toString('utf8');
    for (const mod of ['claim-rules', 'validate-claim-evidence', 'transcript-tools']) {
      assert.ok(text.includes(mod), 'suite must name ' + mod + ' so a grep finds it');
    }
  });
});
