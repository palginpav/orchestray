#!/usr/bin/env node
'use strict';

/**
 * validate-pattern-ack.js — SubagentStop hook.
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
 * Fourth rewrite (2026-08-08, same day, same root shape one level up): this
 * hook was registered at **PostToolUse:Agent**, which fires when an agent is
 * DISPATCHED. Its `tool_response` is dispatch metadata (status, prompt,
 * teammate_id, agent_id, model, tmux_*, …) — no field carries agent output,
 * because the output does not exist yet. So `rawOutputText` found nothing,
 * `hasStructuredAck` was permanently false, every ack read
 * `legacy_text_scan`, and `appendAck` (correctly gated on the structured
 * path) never wrote. Observed live: 6 offers, 3 pattern_ack_captured, 0 ack
 * rows, 0 credits. See
 * .orchestray/kb/decisions/pattern-ack-wired-to-wrong-hook-event.md.
 *
 * It now runs at **SubagentStop**, the event that carries
 * `last_assistant_message` — the same event bin/_lib/claim-rules.js consumes,
 * which is why the field-precedence table it shares was right about the field
 * and wrong about where the file was mounted.
 *
 * Consequence for the join: SubagentStop has no `tool_use_id`, so the offer
 * ledger cannot be keyed on it from here. The key is now the composite
 * (session_id, agent roster name) — the only pair both payloads carry. Both
 * sides of it are defined once, in bin/_lib/pattern-evidence-ledger.js
 * (spawnAgentName / stopAgentName / findOfferRowForAgent); this file only
 * calls them. The matched offer row then supplies spawn_id, agent_role and
 * task_id for the emitted events and the ack row, so Phase 3's spawn_id-keyed
 * join (bin/_lib/pattern-credit-compute.js) is unchanged by this move.
 *
 * Third rewrite (2026-08-08): `extractResult`'s raw-text lookup was its own
 * ad-hoc list (tool_response, then output, then result, then agent_output)
 * — a private copy of the field-precedence table `bin/_lib/claim-rules.js` already
 * fixed once (v2.3.19 W1) after discovering `last_assistant_message` is the
 * only field a live PostToolUse:Agent/SubagentStop payload ever sets. This
 * file's private list never included it, so `hasStructuredAck` was always
 * false in production and every ack fell through to `legacy_text_scan` —
 * identical failure shape to the bug W1 fixed in validate-claim-evidence.js,
 * recurring here because the fix lived in one file instead of one function.
 * Now sourced from `claim-rules.js#rawOutputText` (single definition, four
 * call sites) with a parity guard —
 * bin/__tests__/anti-pattern-agent-output-fields-parity.test.js — that fails
 * if any file re-declares the field list privately.
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
 *   1. Triggers on any subagent completion (any subagent_type — see reason 2
 *      above) whose spawn carried an offered pattern.
 *   2. Reads curated-offer slugs for this agent from the Phase-1 ledger
 *      (`.orchestray/state/pattern-offers.jsonl`), joined on
 *      (session_id, agent name) — the offer set this validator reasons about.
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
 * Fail-open contract (unchanged in substance, now guarding a stop rather than
 * a spawn — a crash here must never strand a subagent's completed work):
 *   - No curated offer row joinable to this agent → no check → no event (safe).
 *   - Any internal error → exit 0 (never blocks the stop).
 *   - Kill switch: ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → exit 0.
 *
 * Default-on per feedback_default_on_shipping.md.
 *
 * Input:  Claude Code SubagentStop JSON payload on stdin
 * Output: { continue: true } on stdout always; exit 0 always
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { peekOrchestrationId } = require('./_lib/peek-orchestration-id');
const { findOfferRowForAgent, stopAgentName, appendAck } = require('./_lib/pattern-evidence-ledger');
const { resolveOfferedSlug } = require('./_lib/pattern-offer-scan');
// Shared prose resolver and length bounds — see handoff-contract-text.js
// #resolvePatternAckProse / #isPatternAckProseLenValid docstrings. Same
// functions bin/validate-task-completion.js's isValidPatternAckEntry calls,
// so the advisory ledger and the blocking gate can never disagree on what
// counts as prose or how long it must be.
const { resolvePatternAckProse, isPatternAckProseLenValid } = require('./_lib/handoff-contract-text');
// Canonical raw-output field precedence — see claim-rules.js RAW_OUTPUT_FIELDS
// docstring. Recurrence guard: bin/__tests__/anti-pattern-agent-output-fields-parity.test.js.
const { rawOutputText } = require('./_lib/claim-rules');

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
 * Curated slugs on one Phase-1 offer row. Ambient offers are excluded —
 * design §5.4: not application-eligible by default, so they must not carry
 * the ack-coverage obligation either.
 *
 * @param {object|null} row
 * @returns {string[]}
 */
function curatedSlugsFromRow(row) {
  if (!row || !Array.isArray(row.offers)) return [];
  const slugs = new Set();
  for (const o of row.offers) {
    if (o && o.offer_kind === 'curated' && typeof o.slug === 'string' && o.slug) slugs.add(o.slug);
  }
  return Array.from(slugs);
}

// ---------------------------------------------------------------------------
// Structured result extractor
// ---------------------------------------------------------------------------

/**
 * Extract the stopped agent's Structured Result from the SubagentStop hook
 * payload.
 *
 * Raw text is resolved via claim-rules.js#rawOutputText — the canonical
 * `last_assistant_message` > `result` > `output` > `agent_output` precedence
 * (v2.3.19 W1). `last_assistant_message` is the field a live SubagentStop
 * payload sets; `tool_response` is not in the list because it is a
 * different-shaped field on other PostToolUse hooks (see
 * bin/validate-commit-handoff.js) and, on PostToolUse:Agent, dispatch
 * metadata with no output in it at all.
 *
 * @param {object} event
 * @returns {{ summary: string, filesChangedText: string, status: string|null,
 *             patternsUsedRaw: *, patternsRejectedRaw: * }}
 */
function extractResult(event) {
  const raw = rawOutputText(event) || '';

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
 * { slug, <proseKey>_len, <proseKey>_valid }[]. Tolerates the malformed
 * shapes bin/validate-task-completion.js's entry-shape check rejects (bare
 * strings, missing prose) — this hook is advisory-only and must not throw
 * on input the blocking validator would have already caught.
 *
 * Three tolerances, all from live payloads:
 *   - `name` is accepted as an alias for `slug` (observed:
 *     `{"name": "verification-shares-blind-spot", "how": "…"}`).
 *   - the identifier is resolved against `offered` by
 *     pattern-offer-scan.js#resolveOfferedSlug, which restores a dropped
 *     category prefix, or (when that reduction doesn't reproduce the slug)
 *     matches the offered pattern's own frontmatter `name:` field — both
 *     only when unambiguous.
 *   - the prose key name is flexible — see
 *     handoff-contract-text.js#resolvePatternAckProse — because array
 *     membership already encodes used-vs-rejected; an entry under
 *     `patterns_rejected` carrying `how` instead of `why` is still a
 *     rejection with real reasoning, not an empty one.
 *
 * `<proseKey>_valid` (2026-08-08): the length bound
 * (isPatternAckProseLenValid) is now the same one the T15 gate enforces, but
 * this hook records rather than rejects. The row already stores a length,
 * not the prose text itself, so there is nothing to truncate; an over-length
 * `how` is weak evidence of a real application (the agent said more than
 * required), not of a fake one, so dropping the row would discard real
 * signal for a violation direction that isn't the suspicious one.
 * Under-length (including the 0-length no-prose case) is the direction that
 * actually indicates a missing/fabricated ack, and Phase 3
 * (pattern-credit-compute.js's own `min_how_length` gate) already declines
 * credit for it. Either way the row is kept and flagged, never dropped —
 * this hook is advisory, so silently discarding evidence here would just
 * hide the disagreement instead of surfacing it.
 *
 * @param {*} arr
 * @param {string} proseKey - 'how' or 'why'
 * @param {string[]} offered - curated slugs offered to this spawn
 * @param {string} [cwd] - enables the frontmatter-name fallback in
 *   resolveOfferedSlug for the 4 corpus outliers where slug !=
 *   category + '-' + name (see pattern-offer-scan.js#resolveOfferedSlug).
 * @returns {Array<{slug: string, [k: string]: number|boolean}>}
 */
function normalizeAckEntries(arr, proseKey, offered, cwd) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const lenKey = proseKey + '_len';
  const validKey = proseKey + '_valid';
  for (const e of arr) {
    if (typeof e === 'string' && e.trim()) {
      out.push({ slug: resolveOfferedSlug(e, offered, cwd), [lenKey]: 0, [validKey]: false });
    } else if (e && typeof e === 'object') {
      const raw = [e.slug, e.name].find((v) => typeof v === 'string' && v.trim());
      if (!raw) continue;
      const len = resolvePatternAckProse(e, proseKey).length;
      out.push({
        slug: resolveOfferedSlug(raw, offered, cwd),
        [lenKey]: len,
        [validKey]: isPatternAckProseLenValid(len),
      });
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
//     source: "structured_result", used: [{slug, how_len, how_valid}],
//     rejected: [{slug, why_len, why_valid}], agent_status }
// `*_valid` is additive (2026-08-08) — consumers reading only `*_len`
// (e.g. bin/_lib/pattern-credit-compute.js's own min_how_length gate) are
// unaffected.
// Same file bin/mcp-server/tools/pattern_record_application.js writes
// self-report rows to (.orchestray/state/pattern-acks.jsonl).
// ---------------------------------------------------------------------------
// Trigger guard
// ---------------------------------------------------------------------------

/**
 * Any subagent completion qualifies (was architect-only, then any Agent()
 * spawn). The role filter is gone entirely: the offer ledger decides whether
 * there is anything to check, and it is written for every spawn — see module
 * header reason 2 and the RV-2 Issue 2 note.
 *
 * SubagentStop is asserted explicitly so a payload from another event cannot
 * reach run() and be mis-joined; hooks.json registers this file once, at
 * SubagentStop, and this guard is what makes that registration load-bearing.
 */
function isSubagentStop(event) {
  return !!event && (event.hook_event_name || '') === 'SubagentStop';
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

    if (!isSubagentStop(event)) return;

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
  // Join: (session_id, agent roster name). SubagentStop carries no
  // tool_use_id, so spawn_id cannot be resolved from the payload — it comes
  // off the matched offer row instead, which keeps every downstream consumer
  // (events, ack row, Phase 3 caps) keyed exactly as before.
  const agentName = stopAgentName(event);
  if (!agentName) return;

  // Same fallback record-pattern-offers.js uses (peekOrchestrationId(cwd) ||
  // 'unknown') — both phases must resolve the identical orchestration id even
  // when no orchestration marker file exists (e.g. a solo, non-orchestrated
  // spawn).
  const orchId   = peekOrchestrationId(cwd) || 'unknown';
  const offerRow = findOfferRowForAgent(cwd, orchId, event.session_id, agentName);
  const offered  = curatedSlugsFromRow(offerRow);
  // No curated offer joinable to this agent → no check (safe-on-missing).
  if (offered.length === 0) return;

  const spawnId   = offerRow.spawn_id || null;
  const agentRole = offerRow.agent_role || null;
  const taskId    = offerRow.task_id || null;

  const { summary, filesChangedText, status, patternsUsedRaw, patternsRejectedRaw } = extractResult(event);
  const hasStructuredAck = Array.isArray(patternsUsedRaw) || Array.isArray(patternsRejectedRaw);

  const offeredSet = new Set(offered);
  let usedSlugs, rejectedSlugs, usedEntries, rejectedEntries;

  if (hasStructuredAck) {
    usedEntries    = normalizeAckEntries(patternsUsedRaw, 'how', offered, cwd);
    rejectedEntries = normalizeAckEntries(patternsRejectedRaw, 'why', offered, cwd);
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
  curatedSlugsFromRow,
  normalizeAckEntries,
  slugsAcknowledgedByText,
  extractResult,
  isSubagentStop,
  run,
};

if (require.main === module) {
  main();
}
