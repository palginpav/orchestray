#!/usr/bin/env node
'use strict';

/**
 * validate-pattern-ack.js — PostToolUse:Agent hook.
 *
 * pattern-application-evidence-design.md §4.2 (v2.3.19 Phase 2 — "capturing
 * it"). Originally v2.2.11 W2-6, architect-only. Rewritten twice: first for
 * the three reasons below, then again (RV-2 review, Issue 2) because the
 * first rewrite dropped the `isAgentSpawn` role guard but left a downstream
 * `<mcp-grounding>`-block gate that silently re-imposed it.
 *
 *   1. §0.2 parser bug (now moot — see below): `pattern_find(mode:'catalog')`
 *      returns `{ mode, catalog: "PATTERN slug=… confidence=…" (a STRING),
 *      … }`. The original `parsePatternFindResults` only recognised
 *      `matches|items|results|patterns` ARRAY keys, found none, and returned
 *      `[]` — decapitating this validator since the R-CAT-DEFAULT catalog
 *      switch (v2.1.16).
 *   2. Architect-only was too narrow — developers and testers are where
 *      patterns most often shape work (2 architect spawns vs 304
 *      routing_outcome rows in the live log).
 *   3. It only ever recorded the NEGATIVE (a miss). It now records the
 *      POSITIVE too — every offered pattern's used/rejected disposition —
 *      via the `patterns_used`/`patterns_rejected` Structured Result fields
 *      (bin/_lib/handoff-contract-text.js), falling back to the old
 *      substring-scan heuristic only when an agent's payload predates those
 *      fields (grace window, same rationale as validate-task-completion.js).
 *
 * RV-2 Issue 2 fix: this hook no longer parses `tool_input.prompt` or the
 * `<mcp-grounding>` fence at all. It reads the "offered" set from the Phase-1
 * offer ledger (bin/_lib/pattern-evidence-ledger.js, written by
 * bin/record-pattern-offers.js at PreToolUse:Agent) by `spawn_id`, filtered
 * to `offer_kind: "curated"`. This fixes two independent bugs in one move:
 * the ledger exists for every spawn regardless of role, so the 4-of-15-role
 * restriction (only pm/researcher/architect/debugger ever receive a
 * `<mcp-grounding>` fence — bin/prefetch-mcp-grounding.js) is gone; and
 * "offered" now means the same thing here as it does in Phase 1 — curated,
 * PM-authored citations, not the ambient catalog (design §5.4: ambient
 * offers are not application-eligible by default). It also deletes the
 * second, independently-drifting TOON-catalog parser this file used to
 * carry (RV-2 Issue 5) — bin/_lib/pattern-offer-scan.js is now the only one.
 *
 * Behaviour:
 *   1. Triggers on any Agent() spawn that carries an offered pattern (any
 *      subagent_type — see reason 2 above).
 *   2. Reads curated-offer slugs for this spawn_id from the Phase-1 ledger
 *      (`.orchestray/state/pattern-offers.jsonl`) — the offer set this
 *      validator reasons about.
 *   3. Reads the agent's patterns_used/patterns_rejected from its Structured
 *      Result and computes per-slug coverage against the offered set.
 *   4. Emits `pattern_ack_captured` (always, when ≥1 pattern was offered)
 *      and `pattern_application_withheld` (reason: "no_ack", once per
 *      uncovered slug) — the latter supersedes `architect_pattern_ack_missing`
 *      per design §8.4/§8.6.
 *   5. Appends a `source: "structured_result"` row to
 *      `.orchestray/state/pattern-acks.jsonl` when the structured fields were
 *      present (not appended for the legacy text-scan fallback — that signal
 *      is too unreliable to feed the §4.3 Phase 3 commit join).
 *
 * Fail-open contract (unchanged):
 *   - No curated offer row for this spawn_id → no check → no event (safe).
 *   - Any internal error → exit 0 (never blocks a spawn).
 *   - Kill switch: ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → exit 0.
 *
 * Default-on per feedback_default_on_shipping.md.
 *
 * Input:  Claude Code PostToolUse:Agent JSON payload on stdin
 * Output: { continue: true } on stdout always; exit 0 always
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { peekOrchestrationId } = require('./_lib/peek-orchestration-id');
const { readOffersForOrch, appendAck } = require('./_lib/pattern-evidence-ledger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Offered-set lookup — Phase-1 ledger read (RV-2 Issue 2). Replaces the old
// grounding-block re-parse: the ledger already resolved curated vs ambient
// once, at PreToolUse, for every spawn regardless of role.
// ---------------------------------------------------------------------------

/**
 * Curated slugs offered to this spawn, per the Phase-1 offer ledger
 * (.orchestray/state/pattern-offers.jsonl). Ambient offers are excluded —
 * design §5.4: not application-eligible by default, so they must not carry
 * the ack-coverage obligation either. Normally 0 or 1 ledger row exists per
 * spawn_id; multiple rows (e.g. a retried spawn) are unioned defensively.
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {string|null} spawnId
 * @returns {string[]}
 */
function curatedOfferedSlugs(cwd, orchId, spawnId) {
  if (!spawnId) return [];
  const rows = readOffersForOrch(cwd, orchId).filter((r) => r && r.spawn_id === spawnId);
  const slugs = new Set();
  for (const row of rows) {
    if (!Array.isArray(row.offers)) continue;
    for (const o of row.offers) {
      if (o && o.offer_kind === 'curated' && typeof o.slug === 'string' && o.slug) slugs.add(o.slug);
    }
  }
  return Array.from(slugs);
}

// ---------------------------------------------------------------------------
// Structured result extractor
// ---------------------------------------------------------------------------

/**
 * Extract the spawned agent's Structured Result from the PostToolUse hook
 * payload.
 *
 * PostToolUse:Agent payload fields (as observed in sibling validators):
 *   event.tool_response  — the agent's raw text output
 *   event.output         — alternative key (some CC versions)
 *   event.result         — alternative key
 *
 * @param {object} event
 * @returns {{ summary: string, filesChangedText: string, status: string|null,
 *             patternsUsedRaw: *, patternsRejectedRaw: * }}
 */
function extractResult(event) {
  const raw = [
    event.tool_response,
    event.output,
    event.result,
    event.agent_output,
  ].find(v => typeof v === 'string' && v.length > 0) || '';

  const empty = {
    summary: '', filesChangedText: '', status: null,
    patternsUsedRaw: undefined, patternsRejectedRaw: undefined,
  };
  if (!raw) return empty;

  // Locate ## Structured Result block.
  const tail = raw.slice(-65536);
  const srMatch = tail.match(/##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (srMatch) {
    try {
      const sr = JSON.parse(srMatch[1]);
      const summary = typeof sr.summary === 'string' ? sr.summary : '';
      let filesChangedText = '';
      if (Array.isArray(sr.files_changed)) {
        for (const fc of sr.files_changed) {
          if (typeof fc === 'string') {
            filesChangedText += ' ' + fc;
          } else if (fc && typeof fc === 'object') {
            filesChangedText += ' ' + (fc.description || fc.path || '');
          }
        }
      }
      return {
        summary,
        filesChangedText: filesChangedText.trim(),
        status: typeof sr.status === 'string' ? sr.status : null,
        patternsUsedRaw: sr.patterns_used,
        patternsRejectedRaw: sr.patterns_rejected,
      };
    } catch (_) { /* fall through */ }
  }

  // Fallback: raw text (slug grep will still work for the legacy path).
  return Object.assign({}, empty, { summary: raw.slice(-8192) });
}

/**
 * Normalise a patterns_used/patterns_rejected array into
 * { slug, <proseKey>_len }[]. Tolerates the malformed shapes
 * bin/validate-task-completion.js's entry-shape check rejects (bare
 * strings, missing prose) — this hook is advisory-only and must not throw
 * on input the blocking validator would have already caught.
 *
 * @param {*} arr
 * @param {string} proseKey - 'how' or 'why'
 * @returns {Array<{slug: string, [k: string]: number}>}
 */
function normalizeAckEntries(arr, proseKey) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (typeof e === 'string' && e.trim()) {
      out.push({ slug: e.trim(), [proseKey + '_len']: 0 });
    } else if (e && typeof e === 'object' && typeof e.slug === 'string' && e.slug.trim()) {
      const prose = e[proseKey];
      out.push({ slug: e.slug.trim(), [proseKey + '_len']: typeof prose === 'string' ? prose.trim().length : 0 });
    }
  }
  return out;
}

/**
 * Case-insensitive substring scan — the pre-§4.2 heuristic, kept as a
 * fallback for agents whose payload predates patterns_used/patterns_rejected
 * (same grace-window rationale as bin/validate-task-completion.js).
 *
 * @param {string[]} slugs
 * @param {string}   haystack
 * @returns {string[]} the subset of `slugs` found in `haystack`
 */
function slugsAcknowledgedByText(slugs, haystack) {
  const lower = haystack.toLowerCase();
  return slugs.filter(slug => lower.includes(slug.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Ack ledger row shape (source: "structured_result"), appended via the
// shared bin/_lib/pattern-evidence-ledger.js#appendAck (fail-open — see
// module docstring there):
//   { timestamp, orchestration_id, spawn_id, agent_role, task_id,
//     source: "structured_result", used: [{slug, how_len}],
//     rejected: [{slug, why_len}], agent_status }
// Same file bin/mcp-server/tools/pattern_record_application.js writes
// self-report rows to (.orchestray/state/pattern-acks.jsonl).
// ---------------------------------------------------------------------------
// Trigger guard
// ---------------------------------------------------------------------------

/**
 * Any Agent() spawn with a subagent_type qualifies now (was architect-only).
 * Developers and testers are where patterns most often shape work — see
 * module header reason 2.
 */
function isAgentSpawn(event) {
  if (!event) return false;
  if ((event.tool_name || '') !== 'Agent') return false;
  const subtype = (event.tool_input && event.tool_input.subagent_type) || '';
  return typeof subtype === 'string' && subtype.length > 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
  setImmediate(() => {
    // Always emit continue — this hook never blocks.
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');

    // Kill switch.
    if (process.env.ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED === '1') return;

    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      return;
    }

    if (!isAgentSpawn(event)) return;

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    try {
      run(event, cwd);
    } catch (_) {
      // Fail-open — never propagate to crash.
    }
  });
}

function run(event, cwd) {
  const agentRole = (event.tool_input && event.tool_input.subagent_type) || null;
  const taskId     = (event.tool_input && event.tool_input.task_id) || null;
  const spawnId    = (event.tool_input && event.tool_input.agent_id)
    || (event.tool_input && event.tool_input.spawn_id)
    || null;

  // Same fallback record-pattern-offers.js uses (peekOrchestrationId(cwd) ||
  // 'unknown') — both phases must resolve the identical join key even when
  // no orchestration marker file exists (e.g. a solo, non-orchestrated spawn).
  const orchId  = peekOrchestrationId(cwd) || 'unknown';
  const offered = curatedOfferedSlugs(cwd, orchId, spawnId);
  // No curated offer for this spawn_id → no check (safe-on-missing contract).
  if (offered.length === 0) return;

  const { summary, filesChangedText, status, patternsUsedRaw, patternsRejectedRaw } = extractResult(event);
  const hasStructuredAck = Array.isArray(patternsUsedRaw) || Array.isArray(patternsRejectedRaw);

  const offeredSet = new Set(offered);
  let usedSlugs, rejectedSlugs, usedEntries, rejectedEntries;

  if (hasStructuredAck) {
    usedEntries    = normalizeAckEntries(patternsUsedRaw, 'how');
    rejectedEntries = normalizeAckEntries(patternsRejectedRaw, 'why');
    usedSlugs     = usedEntries.map(e => e.slug);
    rejectedSlugs = rejectedEntries.map(e => e.slug);
  } else {
    // Legacy fallback (pre-§4.2 payload): substring-scan summary/files_changed.
    const haystack = [summary, filesChangedText].join(' ');
    usedSlugs     = slugsAcknowledgedByText(offered, haystack);
    rejectedSlugs = [];
  }

  const usedOffered     = usedSlugs.filter(s => offeredSet.has(s));
  const rejectedOffered = rejectedSlugs.filter(s => offeredSet.has(s));
  const coveredSet      = new Set(usedOffered.concat(rejectedOffered));
  const uncovered        = offered.filter(s => !coveredSet.has(s));
  const coverageComplete = uncovered.length === 0;

  const agentStatus = status || 'unknown';

  // §8.2: pattern_ack_captured — the positive record, always emitted when
  // ≥1 curated pattern was offered.
  writeEvent({
    version:         SCHEMA_VERSION,
    type:            'pattern_ack_captured',
    spawn_id:        spawnId,
    agent_role:      agentRole,
    used_slugs:      usedOffered,
    rejected_slugs:  rejectedOffered,
    offered_count:   offered.length,
    coverage_complete: coverageComplete,
    agent_status:    agentStatus,
    ack_source:      hasStructuredAck ? 'structured_fields' : 'legacy_text_scan',
    schema_version:  SCHEMA_VERSION,
  }, { cwd });

  // §8.4/§8.6: pattern_application_withheld (reason: "no_ack") supersedes
  // architect_pattern_ack_missing, one event per uncovered offered slug.
  for (const slug of uncovered) {
    writeEvent({
      version:        SCHEMA_VERSION,
      type:           'pattern_application_withheld',
      slug,
      pattern_name:   slug,
      reason:         'no_ack',
      offer_kind:     'curated',
      spawn_ids:      spawnId ? [spawnId] : [],
      schema_version: SCHEMA_VERSION,
    }, { cwd });
  }

  if (!coverageComplete) {
    process.stderr.write(
      '[orchestray] validate-pattern-ack: WARN — ' + (agentRole || '(unknown role)') + ' spawn ' +
      (spawnId || '(unknown)') + ' did not cover ' + uncovered.length + ' of ' + offered.length +
      ' offered pattern(s): ' + uncovered.join(', ') + '. ' +
      'Kill switch: ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1\n'
    );
  }

  // Ledger row: only for the structured-fields path — the legacy text-scan
  // signal is too unreliable to feed the §4.3 Phase 3 commit join (no prose,
  // no explicit rejection, false positives from stray slug mentions).
  if (hasStructuredAck) {
    appendAck(cwd, {
      timestamp:        new Date().toISOString(),
      orchestration_id: orchId,
      spawn_id:         spawnId,
      agent_role:       agentRole,
      task_id:          taskId,
      source:           'structured_result',
      used:             usedEntries,
      rejected:         rejectedEntries,
      agent_status:     agentStatus,
    });
  }
}

module.exports = {
  curatedOfferedSlugs,
  normalizeAckEntries,
  slugsAcknowledgedByText,
  extractResult,
  isAgentSpawn,
  run,
};

if (require.main === module) {
  main();
}
