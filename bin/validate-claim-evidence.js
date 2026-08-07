#!/usr/bin/env node
'use strict';

/**
 * validate-claim-evidence.js — SubagentStop hook (v2.3.18, CEL).
 *
 * An agent's Structured Result is testimony; its tool calls are evidence. This
 * gate matches claim language against `_lib/claim-rules.js`, looks for a
 * satisfying `tool_use` block in the spawn's transcript, and records every
 * verdict to a ledger that outlives the spawn.
 *
 * Replaces five hand-written point-gates (see `ported_from` on each rule).
 *
 * Kill switches:
 *   ORCHESTRAY_CLAIM_EVIDENCE_DISABLED=1        — full bypass
 *   config claim_evidence_ledger.enabled=false  — full bypass
 *   config claim_evidence_ledger.block=false    — telemetry only, ledger kept
 *   ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD=N  — override the ramp
 *
 * Ledger: .orchestray/state/claim-ledger-<orch-id>.jsonl
 * Ramp counters: .orchestray/state/claim-evidence-warn-count-<orch-id>.json
 *   — one counter per `role|rule_id`, so the warn budget is per failure mode
 *     rather than a single orchestration-wide allowance.
 *
 * Events emitted:
 *   claim_evidence_ok      — no blocking gaps (or nothing claimed)
 *   claim_evidence_gap     — blocking gaps found, ramp window still open
 *   claim_evidence_blocked — blocking gaps found, ramp exhausted, exit 2
 *
 * Contract:
 *   - exit 0 when no claim matches, or every blocking claim is evidenced.
 *   - exit 0 within the ramp window (emits claim_evidence_gap).
 *   - exit 0 when block=false, whatever the gaps.
 *   - exit 2 when ramp exhausted and a blocking claim has no strong evidence.
 *   - fail-open on any internal error, including a malformed transcript.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { extractToolCalls } = require('./_lib/transcript-tools');
const {
  matchClaims,
  findEvidence,
  syntheticClaims,
  evaluateAssertions,
  extractStructuredResult,
  rawOutputText,
  stripNonTestimony,
  stripStructuredResultSection,
  stripStructuredResultFences,
  subtractIssueLeaves,
} = require('./_lib/claim-rules');
const { validateTranscriptPath } = require('./_lib/path-containment');

const SCHEMA_VERSION = 1;
const DEFAULT_RAMP_THRESHOLD = 3;

/** Tail of the final assistant message scanned for prose claims. */
const MAX_PROSE_BYTES = 8 * 1024;

/** Tail of the raw output that section-stripping is applied to. */
const MAX_STRIP_BYTES = 256 * 1024;

/** Cap ledger rows per spawn so a runaway match cannot bloat state. */
const MAX_LEDGER_ROWS = 50;

/** Tail of events.jsonl scanned for rules that accept audit-event evidence. */
const MAX_EVENT_SCAN_BYTES = 4 * 1024 * 1024;

/** Tail of the transcript scanned for the spawn's own start timestamp. */
const MAX_TRANSCRIPT_SCAN_BYTES = 512 * 1024;

/**
 * Slack on the leading edge of the spawn window.
 *
 * M1 grounding is prefetched by a PreToolUse:Agent hook that runs *before* the
 * subagent exists, so `mcp_grounding_prefetched` and its per-tool
 * `mcp_tool_call` rows are always older than the transcript's first line. A
 * window anchored exactly at the transcript would exclude the one thing the
 * events probe was added to see. One minute bounds that hook's own runtime
 * (a handful of MCP calls) without reopening the window to the previous spawn.
 */
const SPAWN_WINDOW_GRACE_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Load the `claim_evidence_ledger` config section. Fail-open to defaults.
 * @returns {{enabled: boolean, ramp: number, block: boolean}}
 */
function loadClaimEvidenceConfig(cwd) {
  const defaults = { enabled: true, ramp: DEFAULT_RAMP_THRESHOLD, block: true };
  let section;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    section = parsed && parsed.claim_evidence_ledger;
  } catch (_e) { return defaults; }
  if (!section || typeof section !== 'object') return defaults;
  return {
    enabled: typeof section.enabled === 'boolean' ? section.enabled : defaults.enabled,
    ramp: Number.isFinite(section.ramp) && section.ramp >= 0 ? section.ramp : defaults.ramp,
    block: typeof section.block === 'boolean' ? section.block : defaults.block,
  };
}

function rampThreshold(cfg) {
  const n = parseInt(process.env.ORCHESTRAY_CLAIM_EVIDENCE_RAMP_THRESHOLD, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return cfg.ramp;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function resolveOrchId(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCurrentOrchestrationFile(cwd), 'utf8'));
    return parsed.orchestration_id || parsed.id || null;
  } catch (_e) { return null; }
}

/** Filesystem-safe slug for an orchestration id used in a file name. */
function safeSlug(id) {
  return String(id || 'no-orch').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function ledgerPath(cwd, orchId) {
  return path.join(cwd, '.orchestray', 'state', 'claim-ledger-' + safeSlug(orchId) + '.jsonl');
}

function counterFilePath(cwd, orchId) {
  return path.join(cwd, '.orchestray', 'state', 'claim-evidence-warn-count-' + safeSlug(orchId) + '.json');
}

/**
 * Start of this spawn's evidence window, in epoch ms, or null when unknown.
 *
 * SubagentStop carries no spawn-start field, so the transcript is the closest
 * witness we have: a subagent transcript is written for one spawn, which makes
 * its earliest line timestamp the spawn's own start. `SPAWN_WINDOW_GRACE_MS` is
 * then subtracted to cover the prefetch hook that ran just before it.
 *
 * Only the transcript's own clock is used. A filesystem birthtime was tried and
 * removed: `birthtime` and `mtime` land in the same millisecond on a quiet
 * machine and in different ones under load, which made the window — and so the
 * verdict of a blocking rule — depend on how busy the box was.
 *
 * `null` means "unknown" and widens the probe back to orchestration-and-role
 * scope rather than inventing a window: the grounding rule blocks, and a
 * guessed window would wedge real spawns.
 *
 * @param {string|undefined} transcriptPath
 * @param {string} cwd
 * @returns {number|null}
 */
function resolveSpawnStart(transcriptPath, cwd) {
  let safe = '';
  try { safe = validateTranscriptPath(transcriptPath, cwd); } catch (_e) { return null; }
  if (!safe) return null;

  let text = '';
  try {
    const { size } = fs.statSync(safe);
    if (size === 0) return null;
    const start = Math.max(0, size - MAX_TRANSCRIPT_SCAN_BYTES);
    const fd = fs.openSync(safe, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.slice(0, read).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  } catch (_e) { return null; }

  let earliest = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;   // a tail read can slice line one
    let rec;
    try { rec = JSON.parse(line); } catch (_e) { continue; }
    const ms = Date.parse((rec && (rec.timestamp || rec.ts)) || '');
    if (Number.isFinite(ms) && (earliest === null || ms < earliest)) earliest = ms;
  }
  return earliest === null ? null : earliest - SPAWN_WINDOW_GRACE_MS;
}

/**
 * Audit-event probe for rules with `evidence.events`.
 *
 * Reads the tail of `.orchestray/audit/events.jsonl` once per process and
 * answers "did *this spawn* record any of these event types?". Restores the
 * retired validate-mcp-grounding.js check, which counted events rather than
 * transcript calls — grounding delivered by M1 prefetch leaves an event and no
 * tool call.
 *
 * "This spawn", not "this orchestration". Orchestration scope alone let any
 * sibling discharge an obligation that was never theirs: `mcp_tool_call` covers
 * every Orchestray MCP tool, so one agent's `pattern_record_skip_reason` cleared
 * the next agent's grounding — and with no orchestration id resolved, every row
 * in the 4 MB tail counted, prior orchestrations included. See `scopeEvent`.
 *
 * @param {string} cwd
 * @param {string|null} orchId
 * @param {{role?: string, since?: number|null}} [scope]
 * @returns {function(string[]): (string|false)}  matched type, or false
 */
function makeAuditEventProbe(cwd, orchId, scope = {}) {
  let types = null;
  return function hasAuditEvent(wanted) {
    if (!Array.isArray(wanted) || wanted.length === 0) return false;
    if (types === null) types = readAuditEventTypes(cwd, orchId, scope);
    for (const t of wanted) if (types.has(t)) return t;
    return false;
  };
}

/**
 * Fields an event may use to name the agent it belongs to, in priority order.
 *
 * `grounded_for` is the emitter-side stamp: a prefetch runs *before* its
 * subagent exists, so it has no agent role of its own to report and names the
 * spawn it is grounding for instead. Treating it as an attribution field is
 * what lets prefetch evidence stay attributable without reopening the door to
 * unattributed rows — see `scopeEvent`.
 */
const EVENT_ROLE_FIELDS = ['agent_role', 'role', 'subagent_type', 'grounded_for'];

/**
 * The agent an event names, normalised, or '' when it names nobody.
 * @param {object} ev
 * @returns {string}
 */
function eventRole(ev) {
  for (const field of EVENT_ROLE_FIELDS) {
    const v = ev && ev[field];
    if (typeof v !== 'string') continue;
    const norm = v.toLowerCase().trim();
    if (norm) return norm;
  }
  return '';
}

/**
 * Is this event attributable to the spawn under evaluation?
 *
 * Three independent filters, each closing a way a stranger's activity used to
 * count as this agent's evidence:
 *
 *   1. Orchestration — exact match when an id is resolved. The old code
 *      admitted id-less rows on the theory that the prefetch can run before the
 *      id exists; with an id in hand that allowance admitted everything else in
 *      the tail too. When no id resolves there is nothing to match on, so the
 *      window becomes mandatory instead.
 *   2. Attribution — an event must *name this spawn* to count, via any of
 *      `EVENT_ROLE_FIELDS`. Naming a different agent was never enough to
 *      exclude: a roleless `mcp_tool_call` from a sibling inside the same grace
 *      minute names nothing, so it passed the "no conflicting role" test and
 *      discharged an obligation that was never this agent's. Silence is not
 *      attribution.
 *
 *      Role alone could not be the discriminator, because the rows this rule
 *      exists to admit are roleless by construction: the M1 prefetch grounds a
 *      spawn that has not started, so its per-tool `mcp_tool_call` rows have no
 *      role to report. Hence the emitter stamp — `prefetch-mcp-grounding.js`
 *      writes `grounded_for: <target role>`, and that is what this filter
 *      matches. Prefetch evidence is admitted *because it is stamped*, not
 *      because roleless rows are waved through.
 *
 *      When the spawn's own role is unknown there is nothing to compare, and
 *      the orchestration and window filters carry the scope alone.
 *   3. Window — anything recorded before this spawn began was someone else's
 *      turn. An undated event cannot show it is ours, so it does not count
 *      once a window is known.
 *
 * Back-compat: `mcp_tool_call` rows written before the stamp existed carry no
 * attribution and are therefore not accepted as grounding evidence. Failing
 * closed on *evidence* is the safe direction for a security control, and it is
 * not retroactive in practice: filter 3 only ever admits rows written after the
 * live spawn began, so no historical row was in scope to begin with.
 *
 * Residual: an event stamped for the *same* role as a concurrently-running
 * sibling is still ambiguous. Closing it needs a spawn id shared by the
 * PreToolUse:Agent payload and the SubagentStop payload; there is none today
 * (SubagentStop carries no `tool_use_id`, and its `transcript_path` is the
 * subagent's, not the parent's), so role-level attribution is the tightest
 * join available.
 *
 * @param {object} ev
 * @param {string|null} orchId
 * @param {string} role       normalised role of the spawn, '' when unknown
 * @param {number|null} since spawn start in epoch ms, null when unknown
 * @returns {boolean}
 */
function scopeEvent(ev, orchId, role, since) {
  if (orchId) {
    if (ev.orchestration_id !== orchId) return false;
  } else if (since === null) {
    return false;   // no orchestration and no window — nothing is attributable
  }

  if (role && eventRole(ev) !== role) return false;

  if (since !== null) {
    const ts = Date.parse(ev.timestamp || ev.ts || '');
    if (!Number.isFinite(ts) || ts < since) return false;
  }
  return true;
}

/**
 * @param {string} cwd
 * @param {string|null} orchId
 * @param {{role?: string, since?: number|null}} [scope]
 * @returns {Set<string>} event types attributable to this spawn.
 */
function readAuditEventTypes(cwd, orchId, scope = {}) {
  const out = new Set();
  const role = String(scope.role || '').toLowerCase().trim();
  const since = Number.isFinite(scope.since) ? scope.since : null;
  const file = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  let raw = '';
  try {
    const { size } = fs.statSync(file);
    if (size === 0) return out;
    const start = Math.max(0, size - MAX_EVENT_SCAN_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.slice(0, read).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  } catch (_e) { return out; }

  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;   // a tail read can slice line one
    let ev;
    try { ev = JSON.parse(line); } catch (_e) { continue; }
    if (!ev) continue;
    if (!scopeEvent(ev, orchId, role, since)) continue;
    const type = ev.type || ev.event_type;
    if (type) out.add(String(type));
  }
  return out;
}

function appendLedger(cwd, orchId, rows) {
  if (!rows || rows.length === 0) return;
  try {
    const file = ledgerPath(cwd, orchId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ts = new Date().toISOString();
    const payload = rows.slice(0, MAX_LEDGER_ROWS)
      .map(r => JSON.stringify(Object.assign({ ts, orchestration_id: orchId || null }, r)))
      .join('\n') + '\n';
    fs.appendFileSync(file, payload, 'utf8');
  } catch (_e) { /* best-effort — the ledger never blocks the gate */ }
}

/** Ramp bucket for a gap: each role pays for its own rule, nobody else's. */
function rampKey(gap) {
  return (gap.role || 'unknown') + '|' + gap.rule_id;
}

/**
 * Bump one ramp counter per key and return the new counts.
 *
 * The counter is keyed on `role|rule_id`, not on the orchestration: a single
 * shared counter meant the first three gaps of any kind spent the whole budget
 * and every later spawn hard-blocked on its *first* occurrence — the opposite
 * of a telemetry-first ramp.
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {string[]} keys
 * @returns {Object<string, number>}
 */
function bumpWarnCounts(cwd, orchId, keys) {
  const filePath = counterFilePath(cwd, orchId);
  let counts = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) counts = parsed;
  } catch (_e) { /* fresh counter */ }

  const out = {};
  for (const key of keys) {
    const prev = Number.isFinite(counts[key]) && counts[key] >= 0 ? counts[key] : 0;
    counts[key] = prev + 1;
    out[key] = counts[key];
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(counts) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (_e) { /* best-effort */ }
  return out;
}

function emitGateEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function resolveRole(event) {
  return String(
    event.subagent_type || event.agent_type || event.agent_role ||
    (event.tool_input && event.tool_input.subagent_type) || ''
  ).toLowerCase().trim();
}

/**
 * Assemble the text scanned for claims: the Structured Result's own prose
 * fields plus the tail of the final assistant message.
 *
 * Two things are deliberately NOT testimony and never enter the corpus:
 *
 *   - `issues[]`. An issue is a finding *about someone else's work* — a
 *     reviewer quoting the developer's "tests pass" is reporting a claim, not
 *     making one. Scanning it made the reviewer answer for the developer's
 *     evidence, which no remedy available to a reviewer can produce.
 *   - `## Acceptance Rubric` / `## Rubric Scoring` sections, stripped by
 *     `stripNonTestimony` (see claim-rules.js). Rubric criteria are the
 *     specification an agent is graded against, mandated by rubric-format.md.
 *
 * @param {object} event
 * @param {object|null} sr
 * @returns {string}
 */
function buildClaimText(event, sr) {
  const parts = [];
  if (sr && typeof sr === 'object') {
    if (typeof sr.summary === 'string') parts.push(sr.summary);
    for (const key of ['assumptions', 'recommendations', 'next_steps']) {
      if (Array.isArray(sr[key])) {
        for (const v of sr[key]) if (typeof v === 'string') parts.push(v);
      }
    }
  }
  // `rawOutputText` — not a local field list. This function and
  // `extractStructuredResult` must agree on which field holds the output, or
  // the strip below runs against text that never held the Structured Result.
  const raw = rawOutputText(event);
  if (raw) {
    // Strip before slicing: a tail cut mid-rubric would orphan the heading and
    // leave the criteria behind. MAX_STRIP_BYTES bounds the regex work.
    const scoped = raw.length > MAX_STRIP_BYTES ? raw.slice(-MAX_STRIP_BYTES) : raw;
    // The Structured Result is dropped only when it parsed — its prose fields
    // are then already above, and re-reading the raw JSON would smuggle
    // `issues[]` back in. An unparsed block stays: it is all we have.
    //
    // Both strips run, then the leaf subtraction. The two strips are anchored
    // on delimiters — a heading, then a fence — and each was added after a
    // payload showed up without the one before it. `subtractIssueLeaves` is
    // anchored on the parsed `issues[]` text itself, so it closes the shape that
    // carries no delimiter at all and every shape a future payload invents. The
    // strips still run first: they also drop the JSON *scaffolding*, which the
    // subtraction has no reason to touch.
    const prose = sr
      ? subtractIssueLeaves(stripStructuredResultFences(stripStructuredResultSection(scoped)), sr)
      : scoped;
    parts.push(stripNonTestimony(prose).slice(-MAX_PROSE_BYTES));
  }
  return stripNonTestimony(parts.join('\n'));
}

/**
 * Evaluate one spawn. Pure apart from the transcript read and the audit-event
 * probe (both lazy, both fail-open to "no evidence found").
 *
 * @param {object} event
 * @param {string} cwd
 * @param {{orchId?: string|null, hasAuditEvent?: function}} [opts]
 * @returns {{rows: object[], gaps: object[], claimsCount: number}}
 */
function evaluateSpawn(event, cwd, opts = {}) {
  const role = resolveRole(event);
  const sr   = extractStructuredResult(event);

  // Transcript first: pattern_find in the call log is itself a claim trigger.
  // SubagentStop payloads carry the spawn transcript under either key.
  const transcriptPath = event.transcript_path || event.agent_transcript_path;
  const calls = extractToolCalls(transcriptPath, { cwd });

  const hasAuditEvent = opts.hasAuditEvent ||
    makeAuditEventProbe(cwd, opts.orchId !== undefined ? opts.orchId : resolveOrchId(cwd), {
      role,
      since: resolveSpawnStart(transcriptPath, cwd),
    });

  const text = [buildClaimText(event, sr), ...syntheticClaims(sr, role, calls)].join('\n');
  const claims = matchClaims(text, role);

  const rows = [];
  const seen = new Set();
  for (const { rule, sentence } of claims) {
    if (seen.has(rule.id)) continue;   // one verdict per rule per spawn
    seen.add(rule.id);
    const ev = findEvidence(rule, calls, { hasAuditEvent });
    rows.push({
      role,
      kind: 'claim',
      rule_id: rule.id,
      severity: rule.severity,
      claim: sentence.slice(0, 200),
      evidenced: !!(ev && ev.strength === 'strong'),
      strength: ev ? ev.strength : 'none',
      evidence_tool: ev ? ev.tool : null,
      remedy: rule.remedy,
    });
  }

  for (const { assertion, violations } of evaluateAssertions(sr, role)) {
    rows.push({
      role,
      kind: 'assertion',
      rule_id: assertion.id,
      severity: assertion.severity,
      claim: violations.join('; ').slice(0, 200),
      evidenced: false,
      strength: 'none',
      evidence_tool: null,
      remedy: assertion.remedy,
    });
  }

  const gaps = rows.filter(r => !r.evidenced && r.severity === 'block');
  return { rows, gaps, claimsCount: claims.length, role, tool_call_count: calls.length };
}

function failureMessage(gaps) {
  const lines = gaps.map(g => (
    '  [' + g.rule_id + '] "' + g.claim + '"\n' +
    '      -> ' + g.remedy
  ));
  return (
    '[orchestray] validate-claim-evidence: BLOCKED — unevidenced claims in your ' +
    'Structured Result.\nYour transcript contains no tool call supporting these. ' +
    'Either produce the evidence,\nor rewrite the claim to match what you actually did — ' +
    'both are accepted:\n\n' +
    lines.join('\n') + '\n\n' +
    'Kill switch: ORCHESTRAY_CLAIM_EVIDENCE_DISABLED=1\n'
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

function main() {
  if (process.env.ORCHESTRAY_CLAIM_EVIDENCE_DISABLED === '1') allow();

  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) allow();

  setImmediate(() => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_e) { allow(); return; }

    if ((event.hook_event_name || '') !== 'SubagentStop') allow();

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

    const cfg = loadClaimEvidenceConfig(cwd);
    if (!cfg.enabled) allow();

    const orchId = resolveOrchId(cwd);
    const { rows, gaps, claimsCount, role, tool_call_count } = evaluateSpawn(event, cwd, { orchId });

    appendLedger(cwd, orchId, rows);

    const base = {
      version:          SCHEMA_VERSION,
      schema_version:   SCHEMA_VERSION,
      agent_role:       role || 'unknown',
      claims_count:     claimsCount,
      rows_count:       rows.length,
      tool_call_count:  tool_call_count,
      gap_count:        gaps.length,
      rule_ids:         gaps.map(g => g.rule_id).slice(0, 20),
      orchestration_id: orchId,
    };

    if (gaps.length === 0) {
      emitGateEvent(cwd, Object.assign({ type: 'claim_evidence_ok' }, base));
      allow();
      return;
    }

    const threshold = rampThreshold(cfg);
    // Each gap draws on its own `role|rule_id` budget, so a first-ever gap is
    // never blocked by warnings some other role spent earlier.
    const counts = orchId ? bumpWarnCounts(cwd, orchId, gaps.map(rampKey)) : null;
    const countFor = (g) => (counts === null ? null : counts[rampKey(g)]);
    const exhausted = gaps.filter(g => countFor(g) !== null && countFor(g) > threshold);
    const maxCount = counts === null
      ? null
      : gaps.reduce((m, g) => Math.max(m, countFor(g) || 0), 0);

    if (!cfg.block || exhausted.length === 0) {
      emitGateEvent(cwd, Object.assign({
        type:           'claim_evidence_gap',
        ramp_count:     maxCount,
        ramp_threshold: threshold,
        ramp_state:     !cfg.block ? 'telemetry_only' : (counts === null ? 'no_orchestration' : 'warn'),
      }, base));
      process.stderr.write(
        '[orchestray] validate-claim-evidence: WARN' +
        (maxCount === null ? '' : ' (' + maxCount + '/' + threshold + ')') +
        ' — ' + gaps.length + ' unevidenced claim(s): ' +
        gaps.map(g => g.rule_id).join(', ') + '. ' +
        'Produce the evidence or downgrade the claim. ' +
        'Kill switch: ORCHESTRAY_CLAIM_EVIDENCE_DISABLED=1\n'
      );
      allow();
      return;
    }

    emitGateEvent(cwd, Object.assign({
      type:           'claim_evidence_blocked',
      ramp_count:     maxCount,
      ramp_threshold: threshold,
      ramp_state:     'blocked',
    }, base, { rule_ids: exhausted.map(g => g.rule_id).slice(0, 20), gap_count: exhausted.length }));
    process.stderr.write(failureMessage(exhausted));
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'claim_evidence_blocked:' + exhausted.map(g => g.rule_id).join(','),
    }));
    process.exit(2);
  });
}

module.exports = {
  loadClaimEvidenceConfig,
  buildClaimText,
  evaluateSpawn,
  resolveRole,
  failureMessage,
  ledgerPath,
  counterFilePath,
  bumpWarnCounts,
  rampKey,
  makeAuditEventProbe,
  readAuditEventTypes,
  resolveSpawnStart,
  scopeEvent,
  eventRole,
  EVENT_ROLE_FIELDS,
  DEFAULT_RAMP_THRESHOLD,
};

if (require.main === module) {
  main();
}
