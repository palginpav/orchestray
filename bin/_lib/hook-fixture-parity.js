'use strict';

/**
 * hook-fixture-parity.js — the fixture-realism seam.
 *
 * v2.3.20 shipped a feature that had never once executed. Nine defects stacked
 * behind each other, all invisible to a 7,600-test suite, because every fixture
 * fed the hook a payload shape production never sends:
 *
 *   - a `PreToolUse:Agent` consumer read `tool_input.agent_id`; no real payload
 *     carries that (the identifier is `tool_use_id`, top-level). The fixture
 *     injected the field, so the test proved resolution worked on input that
 *     never arrives.
 *   - a `PostToolUse:Agent` consumer read agent output from `tool_response`.
 *     That field is dispatch metadata (an object: status/teammate_id/tmux_*),
 *     with no output field at all. Its tests passed because fixtures built
 *     `tool_response` as a *string* holding a Structured Result.
 *   - field precedence for reading agent output was copied from a
 *     `SubagentStop` consumer into a `PostToolUse` one — correct at its origin,
 *     meaningless at its destination.
 *
 * The invariant all three violate: **a hook consumer must be validated against
 * a payload captured from its own event type.**
 *
 * This module supplies the two halves of that invariant:
 *   1. PARITY — for every `(script, event, matcher)` declared in hooks.json,
 *      a captured fixture exists whose `hook_event_name` equals that event
 *      (and whose matcher subject matches).
 *   2. SHAPE — a fixture claiming an event must not carry fields that event
 *      never provides. A fixture that lies is worse than no fixture.
 *
 * Everything in EVENT_SHAPES is derived from the captured corpus
 * (1760 fixtures at time of writing), never hand-authored. A hand-authored
 * fixture is precisely the disease.
 */

const fs   = require('node:fs');
const path = require('node:path');

const FIXTURES_DIR = path.join('.orchestray', 'fixtures');

// hooks.json matchers test a different payload field per event. Getting this
// wrong makes SessionStart[compact|resume] look uncovered when it is not.
const MATCHER_SUBJECT = Object.freeze({
  PreToolUse:  'tool_name',
  PostToolUse: 'tool_name',
  SessionStart: 'source',
  SessionEnd:  'reason',
});

// Fixture dirs that hold non-hook payloads (no hook_event_name by design).
// `statusline` is Claude Code's status-line contract, not a hook event.
const NON_HOOK_PRODUCERS = Object.freeze(['statusline']);

/**
 * Event-defining payload shape, derived from the captured corpus.
 *
 * `required`   — fields whose absence means "this is not that event".
 *                Deliberately narrow: only true discriminators, so a legitimate
 *                new capture with a conditional field missing does not fail.
 * `forbidden`  — fields the event never provides. This is what catches the
 *                v2.3.20 disease: a fixture labelled PostToolUse carrying
 *                SubagentStop-only fields.
 * `types`      — expected JS type for a field when present.
 * `toolTypes`  — matcher-scoped type refinement (PreToolUse/PostToolUse only).
 * `evidence`   — corpus support. `n: 0` means we have never captured this
 *                event; asserting a shape for it would be hand-authoring.
 */
const EVENT_SHAPES = Object.freeze({
  SubagentStop: {
    required:  ['session_id', 'cwd', 'last_assistant_message'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms', 'prompt', 'task_id'],
    types:     { last_assistant_message: 'string', agent_id: 'string', agent_type: 'string', stop_hook_active: 'boolean' },
    evidence:  { n: 579 },
  },
  SubagentStart: {
    required:  ['session_id', 'cwd', 'agent_id', 'agent_type'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms', 'last_assistant_message', 'prompt'],
    types:     { agent_id: 'string', agent_type: 'string' },
    evidence:  { n: 97 },
  },
  PreToolUse: {
    required:  ['session_id', 'cwd', 'tool_name', 'tool_input', 'tool_use_id'],
    forbidden: ['tool_response', 'duration_ms', 'last_assistant_message', 'prompt', 'stop_hook_active'],
    types:     { tool_name: 'string', tool_input: 'object', tool_use_id: 'string' },
    evidence:  { n: 656 },
  },
  PostToolUse: {
    required:  ['session_id', 'cwd', 'tool_name', 'tool_input', 'tool_use_id', 'tool_response', 'duration_ms'],
    forbidden: ['last_assistant_message', 'prompt', 'stop_hook_active'],
    types:     { tool_name: 'string', tool_input: 'object', tool_use_id: 'string', duration_ms: 'number' },
    // `tool_response` is an object for native tools and a string for MCP tools.
    // Agent dispatch metadata is ALWAYS an object — the v2.3.20 defect was a
    // fixture that made it a string holding a Structured Result.
    toolTypes: { Agent: { tool_response: 'object' } },
    evidence:  { n: 369 },
  },
  Stop: {
    required:  ['session_id', 'cwd', 'stop_hook_active', 'last_assistant_message'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms', 'agent_id', 'prompt'],
    types:     { stop_hook_active: 'boolean', last_assistant_message: 'string' },
    evidence:  { n: 10 },
  },
  UserPromptSubmit: {
    required:  ['session_id', 'cwd', 'prompt'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms', 'last_assistant_message'],
    types:     { prompt: 'string' },
    evidence:  { n: 17 },
  },
  SessionStart: {
    // `source` is absent in 1/21 captures — optional, not a discriminator.
    required:  ['cwd'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms', 'last_assistant_message', 'prompt'],
    types:     { source: 'string' },
    evidence:  { n: 21 },
  },
  SessionEnd: {
    required:  ['session_id', 'cwd', 'reason'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'last_assistant_message', 'prompt'],
    types:     { reason: 'string' },
    evidence:  { n: 1 },
  },
  PreCompact: {
    required:  ['session_id', 'cwd', 'trigger'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'last_assistant_message', 'prompt'],
    types:     { trigger: 'string' },
    evidence:  { n: 3 },
  },
  TeammateIdle: {
    required:  ['session_id', 'cwd', 'teammate_name', 'team_name'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'last_assistant_message'],
    types:     { teammate_name: 'string', team_name: 'string' },
    evidence:  { n: 1 },
  },

  // ── Events declared in hooks.json but NEVER captured. No shape is asserted:
  // writing one would be inventing the payload, which is the failure mode this
  // module exists to prevent. Each must appear in UNCOVERED_ALLOWLIST; the
  // cross-check in the test suite enforces that pairing both ways.
  TaskCompleted:  { required: [], forbidden: [], types: {}, evidence: { n: 0 } },
  TaskCreated:    { required: [], forbidden: [], types: {}, evidence: { n: 0 } },
  // Derived from the first real capture (v2.3.26). Single sample, so `required` is
  // held to true discriminators only — `agent_type` + `name` are what distinguish a
  // WorktreeCreate payload; `prompt_id`/`transcript_path` are present but not asserted
  // on n=1 evidence. `forbidden` is the tool/message field set no lifecycle event
  // carries. Precedent for shaping at n=1: SessionEnd and TeammateIdle.
  WorktreeCreate: {
    required:  ['session_id', 'cwd', 'agent_type', 'name'],
    forbidden: ['tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'duration_ms', 'last_assistant_message', 'prompt', 'stop_hook_active'],
    types:     { agent_type: 'string', name: 'string' },
    evidence:  { n: 1 },
  },
  WorktreeRemove: { required: [], forbidden: [], types: {}, evidence: { n: 0 } },
});

/**
 * Known-uncovered `(script, event)` pairs, frozen at the ratchet's first turn.
 *
 * Rollout choice: this is an anti-growth ledger, not a mute button. The test
 * asserts three things at once —
 *   (a) every uncovered pair is listed here      → a NEW gap fails immediately;
 *   (b) the list never grows past FROZEN_COUNT   → gaps cannot be bulk-waived;
 *   (c) every listed pair is still uncovered     → once a fixture lands, the
 *       entry must be deleted, so the ratchet only ever tightens.
 *
 * `reason` is a measured classification, not a guess:
 *   no-harvest-seam       — the script never routes stdin through
 *                           bin/_lib/hook-stdin.js, so no invocation of it can
 *                           ever produce a fixture. Closing the gap requires
 *                           changing the script, not running it more.
 *   event-not-yet-observed — the script does use the harvest seam; this repo's
 *                           runs have simply never triggered the event.
 */
const UNCOVERED_ALLOWLIST = Object.freeze([
  // v2.3.26 (W2/W4): register-agent-spawn.js is a brand-new script this
  // release. It DOES route stdin through the harvest seam (readHookInputRaw),
  // so this is event-not-yet-observed, not no-harvest-seam -- expected to
  // retire organically once real PreToolUse[Agent|Explore|Task] and
  // SubagentStart spawns are captured during normal use.
  // register-agent-spawn|PreToolUse retired 2026-08-12 (v2.3.27 V8): two real
  // captures landed (tool_name=Agent) and PreToolUse already carries a derived
  // shape (evidence.n=656) — the lifecycle-complete case. Surfaced by
  // lifecycleIssues() as a single coherent instruction; under the previous
  // two-assertion scheme this pair would have produced contradictory advice.
  // register-agent-spawn|SubagentStart retired 2026-08-12 (v2.3.27 V8): a real
  // SubagentStart capture landed AND SubagentStart already carries a derived
  // shape (evidence.n=97, present since before this pair existed) — lifecycle
  // complete in one step, exactly the case lifecycleIssues() calls
  // 'stale_complete'. Discovered via the full suite, not the isolated file:
  // this worktree's corpus already held the capture.
  { script: 'audit-team-event',             event: 'TaskCreated',    reason: 'no-harvest-seam' },
  { script: 'boot-validate-config',         event: 'SessionStart',   reason: 'no-harvest-seam' },
  { script: 'calibrate-role-budgets',       event: 'SessionStart',   reason: 'no-harvest-seam' },
  { script: 'seed-archetype-cache',         event: 'SessionStart',   reason: 'no-harvest-seam' },
  { script: 'sentinel-probe',               event: 'SessionStart',   reason: 'no-harvest-seam' },
  { script: 'session-feature-gate',         event: 'SessionStart',   reason: 'no-harvest-seam' },
  { script: 'collect-agent-metrics',        event: 'TaskCompleted',  reason: 'event-not-yet-observed' },
  { script: 'validate-task-completion',     event: 'TaskCompleted',  reason: 'event-not-yet-observed' },
  // worktree-create|WorktreeCreate retired 2026-08-12 (v2.3.26): a real capture landed
  // during normal use — verified via stdin.hook_event_name === 'WorktreeCreate', the
  // same field uncoveredPairs() reads. This is the ratchet closing a gap as designed.
  // Retained, but NOT because no capture is possible — the PM deleted a real one.
  //
  // During v2.3.26 W15 a genuine WorktreeRemove capture landed here. The PM inspected it,
  // checked for `hook_event_name` at the TOP level of the fixture, found none, and
  // concluded it was synthetic — then deleted it. That check was wrong: every fixture in
  // this corpus is `{stdin, state}` and the event lives at `stdin.hook_event_name`, which
  // is exactly where uncoveredPairs() reads it (see below). 0 of 2219 fixtures carry the
  // field at top level; the probe could not have succeeded for any file.
  //
  // The waiver is therefore accurate *today* (no capture exists) but only as a result of
  // that deletion. It will retire itself the next time a real WorktreeRemove fires.
  { script: 'worktree-remove',              event: 'WorktreeRemove', reason: 'event-not-yet-observed' },
  // emit-schema-redirect-followed|PostToolUse retired 2026-08-08: a real capture
  // landed during normal use, which is how gaps are meant to close.
  { script: 'validate-companion-files',     event: 'SessionStart',   reason: 'event-not-yet-observed' },
  // dark-event-banner|SessionStart retired 2026-08-10: a real capture landed during
  // normal use, which is how gaps are meant to close.
]);

// The ratchet stop. Lowering this is progress; raising it needs a reviewer.
const FROZEN_UNCOVERED_COUNT = UNCOVERED_ALLOWLIST.length;

/** Repo-relative script basename from a hooks.json command string. */
function scriptBasename(command) {
  const m = String(command || '').match(/([A-Za-z0-9_.-]+)\.js(?![A-Za-z0-9_.-])/);
  return m ? m[1] : null;
}

/** CLI args trailing the script path in a hooks.json command string. */
function commandArgs(command) {
  const s = String(command || '');
  const m = s.match(/[A-Za-z0-9_.-]+\.js(.*)$/);
  return m ? m[1].trim() : '';
}

/**
 * Every distinct hook consumer declared in hooks.json.
 * @returns {Array<{script:string,event:string,matcher:string,args:string,command:string}>}
 */
function declaredPairs(repoRoot) {
  const raw   = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'hooks.json'), 'utf8'));
  const hooks = raw.hooks || raw;
  const out   = [];
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      for (const hk of (m.hooks || [])) {
        if (hk.type !== 'command') continue;
        const script = scriptBasename(hk.command);
        if (!script) continue;
        out.push({ script, event, matcher: m.matcher || '', args: commandArgs(hk.command), command: hk.command });
      }
    }
  }
  return out;
}

/** Load the captured fixture corpus, indexed by script basename. */
function loadFixtureCorpus(repoRoot) {
  const root = path.join(repoRoot, FIXTURES_DIR);
  const idx  = new Map();
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_e) { return idx; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const list = [];
    for (const f of fs.readdirSync(path.join(root, d.name))) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(root, d.name, f);
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (_e) { list.push({ file, stdin: null, unparseable: true }); continue; }
      list.push({ file, stdin: parsed && parsed.stdin, unparseable: false });
    }
    idx.set(d.name, list);
  }
  return idx;
}

/** Does a hooks.json matcher select this payload? Matchers are regex alternations. */
function matcherMatches(event, matcher, stdin) {
  if (!matcher) return true;
  const subject = MATCHER_SUBJECT[event];
  if (!subject) return true; // event carries no matcher subject; matcher is inert
  const value = stdin && stdin[subject];
  if (typeof value !== 'string') return false;
  let re;
  try { re = new RegExp('^(?:' + matcher + ')$'); }
  catch (_e) { return true; } // malformed matcher is hooks-json.test.js's problem
  return re.test(value);
}

/** Is there a captured payload from this consumer's own event type? */
function isCovered(corpus, pair) {
  const list = corpus.get(pair.script) || [];
  return list.some(({ stdin }) =>
    stdin && stdin.hook_event_name === pair.event && matcherMatches(pair.event, pair.matcher, stdin));
}

/** Declared consumers with no same-event capture. */
function uncoveredPairs(repoRoot, corpus) {
  const c    = corpus || loadFixtureCorpus(repoRoot);
  const seen = new Set();
  const out  = [];
  for (const p of declaredPairs(repoRoot)) {
    const key = pairKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isCovered(c, p)) out.push(p);
  }
  return out;
}

function pairKey(p) { return p.script + '|' + p.event + '|' + p.matcher; }

/**
 * The capture->shape->retire lifecycle, in one place, so a reader hits it at
 * the point of failure rather than in a header comment nobody re-reads.
 *
 * v2.3.27 V8: two coverage notions exist over this same corpus —
 * `uncoveredPairs()` (real-time, "is there a same-event capture on disk for
 * this (script, event) pair?") and `EVENT_SHAPES[event].evidence.n`
 * (hand-maintained, "have we derived a shape assertion for this event?").
 * They answer different questions, so updating one without the other is not
 * a contradiction in the code — it IS a contradiction in what the two tests
 * tell an operator to do next: "delete the waiver, it's covered now" vs "this
 * event has zero evidence, keep it in the waiver list or add it back".
 *
 * The correct order when a real capture lands for an allowlisted pair is all
 * three steps, in sequence:
 *   1. derive the shape (`required`/`forbidden`/`types`) from the real payload
 *   2. set `EVENT_SHAPES[event].evidence.n` to the capture count
 *   3. THEN delete the UNCOVERED_ALLOWLIST entry
 *
 * Doing only step 3 (what happened twice on 2026-08-12, on `worktree-remove`
 * then `worktree-create`) leaves the entry gone but `evidence.n` still 0 —
 * the very next run, "events with zero captures... tracked as gaps" fails and
 * demands the entry be re-added, which looks like a flip-flopping tooling bug
 * but is actually a half-finished lifecycle.
 *
 * @param {string} repoRoot
 * @param {Map} [corpus]
 * @returns {Array<{key:string, message:string, kind:'pending_shape'|'stale_complete'}>}
 */
function lifecycleIssues(repoRoot, corpus) {
  const c = corpus || loadFixtureCorpus(repoRoot);
  const uncovered = new Set(uncoveredPairs(repoRoot, c).map(pairKeyFromPair));
  const out = [];
  for (const a of UNCOVERED_ALLOWLIST) {
    const key = a.script + '|' + a.event;
    const isCoveredNow = !uncovered.has(key);
    if (!isCoveredNow) continue;   // still a real gap, nothing to do
    const shape = EVENT_SHAPES[a.event];
    const hasEvidence = shape && shape.evidence && shape.evidence.n > 0;
    if (!hasEvidence) {
      out.push({
        key, kind: 'pending_shape',
        message: key + ': a real capture landed for "' + a.event + '" but EVENT_SHAPES["' + a.event +
          '"].evidence.n is still 0. Do all three steps, in order, before touching this file again: ' +
          '(1) derive required/forbidden/types for "' + a.event + '" from the real captured payload, ' +
          '(2) set EVENT_SHAPES["' + a.event + '"].evidence.n to the capture count, ' +
          '(3) THEN delete this UNCOVERED_ALLOWLIST entry and lower FROZEN_UNCOVERED_COUNT. ' +
          'Deleting the entry before (1)-(2) makes the next run demand you re-add it — that is ' +
          'this exact half-finished lifecycle, not a flip-flopping test.',
      });
    } else {
      out.push({
        key, kind: 'stale_complete',
        message: key + ': covered by a real capture AND ' + a.event + ' already has a derived shape ' +
          '(evidence.n=' + shape.evidence.n + '). Lifecycle complete — delete this UNCOVERED_ALLOWLIST ' +
          'entry and lower FROZEN_UNCOVERED_COUNT.',
      });
    }
  }
  return out;
}

function pairKeyFromPair(p) { return p.script + '|' + p.event; }

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * Does this fixture's body match the event it claims?
 *
 * Catches the exact v2.3.20 class: a payload labelled with one event whose
 * fields only another event provides.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
function checkShape(stdin) {
  const errors = [];
  if (!stdin || typeof stdin !== 'object') return { ok: true, errors };
  const event = stdin.hook_event_name;
  if (!event) return { ok: true, errors }; // non-hook producer; caller vets these
  const shape = EVENT_SHAPES[event];
  if (!shape) { errors.push('unknown hook_event_name "' + event + '" — add it to EVENT_SHAPES'); return { ok: false, errors }; }
  if (shape.evidence.n === 0) return { ok: true, errors }; // no capture, no invented shape

  for (const f of shape.required) {
    if (!(f in stdin)) errors.push(event + ' fixture missing required field "' + f + '"');
  }
  for (const f of shape.forbidden) {
    if (f in stdin) errors.push(event + ' fixture carries "' + f + '", which ' + event + ' never provides');
  }
  for (const [f, want] of Object.entries(shape.types)) {
    if (f in stdin && typeOf(stdin[f]) !== want) {
      errors.push(event + '.' + f + ' must be ' + want + ', got ' + typeOf(stdin[f]));
    }
  }
  const overrides = shape.toolTypes && shape.toolTypes[stdin.tool_name];
  if (overrides) {
    for (const [f, want] of Object.entries(overrides)) {
      if (f in stdin && typeOf(stdin[f]) !== want) {
        errors.push(event + ':' + stdin.tool_name + '.' + f + ' must be ' + want + ', got ' + typeOf(stdin[f]));
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  FIXTURES_DIR,
  MATCHER_SUBJECT,
  NON_HOOK_PRODUCERS,
  EVENT_SHAPES,
  UNCOVERED_ALLOWLIST,
  FROZEN_UNCOVERED_COUNT,
  scriptBasename,
  commandArgs,
  declaredPairs,
  loadFixtureCorpus,
  matcherMatches,
  isCovered,
  uncoveredPairs,
  pairKey,
  checkShape,
  lifecycleIssues,
};
