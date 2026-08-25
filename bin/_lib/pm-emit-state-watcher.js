'use strict';

/**
 * pm-emit-state-watcher.js — backstop emitter for prose-only PM events
 * (v2.2.9 B-8; extended v2.2.10 B1; extended v2.2.10 B2; extended v2.2.10 B6).
 *
 * Why this exists
 * ---------------
 * v2.2.9 W1 found 4 PM-emit-prose findings sharing one anti-pattern: the PM
 * is told (in prose) to emit event X when state file Y mutates, but no hook
 * observes Y to back-stop the emit. When PM forgets, telemetry goes dark:
 *
 *   F-PM-7  → `tier2_invoked` for tier-2 protocols (drift_sentinel, etc.)
 *   F-PM-9  → `pattern_roi_snapshot` when roi-snapshot.json updates
 *   F-PM-12 → `verify_fix_start` synthesised from task YAML round_history
 *   F-PM-21 → `consequence_forecast` when consequences.md is written
 *
 * v2.2.10 B1 adds two more:
 *   B1-pass → `verify_fix_pass` when task YAML verify_fix.status → resolved
 *   B1-fail → `verify_fix_fail` when task YAML verify_fix.status → escalated
 *
 * v2.2.10 B2 replaces 4 R-TGATE-PM Bash-emit prose blocks with mechanical rules:
 *   B2-cb   → `tier2_invoked` protocol=cognitive_backpressure on state/confidence/task-*.json write
 *   B2-ad   → `tier2_invoked` protocol=auto_documenter on routing.jsonl write with documenter entry
 *   B2-dp   → `tier2_invoked` protocol=disagreement_protocol on state/disagree-*.json write
 *   B2-ra   → `tier2_invoked` protocol=replay_analysis on state/replay-*.json write
 *
 * v2.2.10 B6: `checkOrchRoiPresence` — orch-complete-time check.
 *   Reads the orch slice; emits `orchestration_roi_missing` if no
 *   `orchestration_roi` row found. Called by audit-pm-emit-coverage.js.
 *
 * v2.3.19 dark-event-triage item 1 adds one more:
 *   → `replan` when `.orchestray/state/orchestration.md`'s `replan_count`
 *     frontmatter field increases. phase-verify.md §16 step 5 asks for a
 *     manual `ox events append --type=replan`; confirmed 0 emits ever.
 *
 * v2.3.19 item 2 is a BUG FIX, not a new target: `verify_fix_pass`/
 *   `verify_fix_fail` (the B1 `task_verify_fix_outcome` target below) were
 *   never reachable — `WATCH_TARGETS.find()` matched the F-PM-12
 *   `task_verify_fix_round` target FIRST for every `.md` write under
 *   `state/tasks/`, since both targets' `match()` accept any `.md` path in
 *   that dir regardless of content. `processEdit` now runs ALL matching
 *   targets per file write (see `processTarget`), not just the first.
 *
 * v2.3.20 item 1 adds the last verify-fix-loop event: `verify_fix_oscillation`
 *   (phase-verify.md §"Regression Prevention" — `ox events append` prose,
 *   confirmed 0 emits ever). Detected from the SAME `state/tasks/<id>.md`
 *   write as the B1 target above: when the two most recent round_history
 *   entries show `errors_current >= errors_previous`.
 *
 * v2.3.20 item 2: `oversized_map_dispatched` / `oversized_slice_skipped` /
 *   `oversized_synthesis_complete` (oversized-input-mode.md OI.5/OI.6/OI.8)
 *   have NO Edit/Write-observable trigger — the real state changes are a
 *   Bash `ox routing add` per slice and an Agent() result (no file write).
 *   `checkOversizedInputCompleteness` (below, orch-close check, same shape
 *   as `checkOrchRoiPresence`) fills the gap instead: at orch-close the
 *   `oversized_input_detected` event (corpus_id + natural_slices, already
 *   emitted by the detection hook) is ground truth for "this corpus was
 *   sliced", and the KB buffer artifact (kept slices only) is stable by
 *   then, so kept-vs-natural-slices reconstructs exactly which slices were
 *   dropped — precise, not a guess.
 *
 * v2.3.21 item 1 adds `state_cancel_aborted` (tier1-orchestration-rare.md
 *   §"Cancel" step 3, `ox events append` prose, confirmed 0 emits ever).
 *   Same non-Edit/Write shape as v2.3.20 item 2: the real state change is a
 *   Bash `mv .orchestray/state/ .orchestray/history/<orch_id>-cancelled/`,
 *   not a file this hook observes. `checkStateCancelCompleteness` (below)
 *   uses the SAME orch-close-check shape: the archived directory existing
 *   on disk is ground truth that the abort sequence ran (nothing else ever
 *   creates it), so its absence from the live audit log is unambiguous.
 *
 * What this helper does
 * ---------------------
 * On every PostToolUse:Edit|Write fire, it inspects the `tool_input.file_path`
 * against the WATCH_TARGETS table. If the path matches a target AND the PM
 * has NOT already emitted the corresponding event in the current orchestration
 * within the last `RECENT_EMIT_WINDOW_MS`, the helper emits the event ON THE
 * PM'S BEHALF with `{source: "state_watcher_backstop", original_state_file,
 * mutated_at}` plus the shape required by the existing schema.
 *
 * Whenever the helper has to fire on the PM's behalf, it ALSO emits a
 * `pm_emit_backstop_engaged` row so operators can see drift between
 * PM-emit-prose and reality.
 *
 * "Last seen" coordination
 * ------------------------
 * `.orchestray/state/pm-emit-watcher.last-seen.json` keeps
 * `{ <state_file_rel>: { mutated_at_iso, orchestration_id } }`. Used purely
 * for dedupe across rapid Edit fires (Multi-edit cascades, atomic-write
 * tmp+rename pairs). The "did PM also emit" check reads the live
 * events.jsonl directly with a 30-second look-back window — short enough
 * to catch in-turn pairing, long enough to survive a small batch.
 *
 * Kill switches
 * -------------
 *   - process.env.ORCHESTRAY_PM_EMIT_WATCHER_DISABLED === '1'
 *   - process.env.ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED === '1'  (B1 rules only)
 *   - process.env.ORCHESTRAY_TIER2_WATCHER_DISABLED === '1'        (B2 rules only)
 *   - config.pm_emit_watcher.enabled === false
 *
 * Default-on per `feedback_default_on_shipping.md`.
 *
 * Fail-open contract
 * ------------------
 * Hooks must never block Claude Code on audit failures. Every error path
 * logs to stderr at most and returns a no-op result. The CLI wrapper
 * exits 0 unconditionally.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { writeEvent }                  = require('./audit-event-writer');
const { resolveSafeCwd }              = require('./resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./orchestration-state');
const { _withAdvisoryLock }           = require('./atomic-append');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAST_SEEN_REL      = path.join('.orchestray', 'state', 'pm-emit-watcher.last-seen.json');
const LAST_SEEN_LOCK_REL = LAST_SEEN_REL + '.lock';
const EVENTS_REL         = path.join('.orchestray', 'audit', 'events.jsonl');

// PM is considered to have emitted the event itself if a matching row appears
// in events.jsonl within this many ms of the state-file write. 30 s is wider
// than a typical Edit→emit pairing (single PM turn) but tight enough that
// stale prior-orch emits don't suppress this orchestration's backstop.
const RECENT_EMIT_WINDOW_MS = 30_000;

// Defensive: don't slurp events.jsonl beyond this — read tail only.
const EVENTS_TAIL_BYTES = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Watch targets — the 4 prose-only emit findings, mechanised
// ---------------------------------------------------------------------------

/**
 * Each target is `{
 *   id:                 unique slug (used in last-seen + observability)
 *   match(filePath):    boolean — does this path trigger the watcher?
 *   eventType:          the event the PM was supposed to emit
 *   resolveEventType?:  optional fn(ctx) → string|null — dynamic event type
 *                       (overrides eventType for idempotency + pmAlreadyEmitted)
 *   buildPayload(ctx):  returns the canonical event payload (less the
 *                       backstop-marker fields, which are added by the caller)
 *   findingRef:         W1 finding slug for traceability
 * }`.
 *
 * `eventType` values are the existing schema slugs. We DO NOT invent new
 * event types here — the schema-emit validator would drop a fabricated
 * type and surrogate it, which is the exact failure mode we're closing.
 */
const WATCH_TARGETS = [
  // F-PM-7: kb/decisions/*.md write → tier2_invoked (drift_sentinel)
  {
    id:        'kb_decisions_write',
    findingRef: 'F-PM-7',
    eventType: 'tier2_invoked',
    match(rel) {
      return /^\.orchestray\/kb\/decisions\/[^/]+\.md$/.test(rel);
    },
    buildPayload(ctx) {
      return {
        version:        1,
        type:           'tier2_invoked',
        protocol:       'drift_sentinel',
        trigger_signal: 'state_watcher_backstop: ' + ctx.relPath,
      };
    },
  },

  // F-PM-9: patterns/roi-snapshot.json write → pattern_roi_snapshot
  {
    id:        'roi_snapshot_write',
    findingRef: 'F-PM-9',
    eventType: 'pattern_roi_snapshot',
    match(rel) {
      return rel === '.orchestray/patterns/roi-snapshot.json';
    },
    buildPayload(ctx) {
      // patterns_scanned is required by the schema; we surface a 0-fallback
      // when we can't read the snapshot (the watcher is best-effort).
      let patterns_scanned = 0;
      let window_days      = 30;
      let top_roi          = [];
      let bottom_roi       = [];
      try {
        const raw = fs.readFileSync(path.join(ctx.cwd, ctx.relPath), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.patterns)) patterns_scanned = parsed.patterns.length;
          if (typeof parsed.window_days === 'number') window_days = parsed.window_days;
          if (Array.isArray(parsed.top_roi))    top_roi    = parsed.top_roi.slice(0, 5);
          if (Array.isArray(parsed.bottom_roi)) bottom_roi = parsed.bottom_roi.slice(0, 5);
        }
      } catch (_e) { /* fail-open — payload still validates with defaults */ }
      return {
        version:           1,
        type:              'pattern_roi_snapshot',
        schema_version:    1,
        window_days,
        patterns_scanned,
        artefact_path:     ctx.relPath,
        top_roi,
        bottom_roi,
      };
    },
  },

  // F-PM-12: state/tasks/<task>.md write with verify_fix.round_history
  //          → verify_fix_start synthesised from the latest round.
  // Only fires when the YAML frontmatter contains a `verify_fix:` block AND
  // the round_history has at least one entry — otherwise the file mutation
  // is unrelated to verify-fix and we no-op.
  {
    id:        'task_verify_fix_round',
    findingRef: 'F-PM-12',
    eventType: 'verify_fix_start',
    match(rel) {
      return /^\.orchestray\/state\/tasks\/[^/]+\.md$/.test(rel);
    },
    buildPayload(ctx) {
      const taskFile = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(taskFile, 'utf8'); }
      catch (_e) { return null; }
      // Quick existence check — only fire when round_history is present.
      if (!/verify_fix:/.test(raw))    return null;
      if (!/round_history:/.test(raw)) return null;
      const round       = parseLatestRound(raw);
      const error_count = parseLatestErrorCount(raw);
      if (round == null) return null;
      // task_id from filename (state/tasks/<task>.md -> <task>).
      const task_id = path.basename(ctx.relPath, '.md');
      return {
        version:     1,
        type:        'verify_fix_start',
        task_id,
        round,
        error_count: error_count == null ? 0 : error_count,
      };
    },
  },

  // F-PM-21: state/consequences.md write → consequence_forecast
  // Phase A: predictions written. The post-execution event has more shape
  // (accuracy block) — that fires from a different site. The watcher fills
  // the Phase A "I wrote predictions" gap.
  {
    id:        'consequences_write',
    findingRef: 'F-PM-21',
    eventType: 'consequence_forecast',
    match(rel) {
      return rel === '.orchestray/state/consequences.md';
    },
    buildPayload(ctx) {
      const file = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (_e) { raw = ''; }
      const predictions = parseConsequencePredictions(raw);
      return {
        version:      1,
        type:         'consequence_forecast',
        predictions,
        accuracy: {
          total:     predictions.length,
          addressed: 0,
          missed:    0,
          wrong:     0,
        },
      };
    },
  },

  // B1: state/tasks/<task>.md|yaml write with verify_fix.status transition.
  //   status: resolved   → verify_fix_pass
  //   status: escalated  → verify_fix_fail
  //   anything else      → no-op (payload_null)
  //
  // Uses `resolveEventType` to pick the event dynamically. `processEdit` reads
  // this method when present and uses it in place of the static `eventType`
  // field for the `pmAlreadyEmitted` check, the last-seen status key, and the
  // backstop emit. Idempotency: last-seen records `last_event_type` so a
  // repeated write with the same status is suppressed even outside the
  // 30-second PM-emit window.
  {
    id:        'task_verify_fix_outcome',
    findingRef: 'B1',
    eventType: 'verify_fix_pass', // static default; overridden by resolveEventType
    match(rel) {
      return /^\.orchestray\/state\/tasks\/[^/]+\.(md|yaml)$/.test(rel);
    },
    /**
     * Returns the event type for this file write, or null if not applicable.
     * Called by `processEdit` BEFORE the `pmAlreadyEmitted` check so we use
     * the correct event slug for de-dup.
     */
    resolveEventType(ctx) {
      if (process.env.ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED === '1') return null;
      const taskFile = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(taskFile, 'utf8'); }
      catch (_e) { return null; }
      if (parseVerifyFixStatus(raw, 'resolved'))  return 'verify_fix_pass';
      if (parseVerifyFixStatus(raw, 'escalated')) return 'verify_fix_fail';
      return null; // status is open/in_progress/design_rejected/etc → no-op
    },
    buildPayload(ctx) {
      if (process.env.ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED === '1') return null;
      const taskFile = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(taskFile, 'utf8'); }
      catch (_e) { return null; }
      const task_id     = path.basename(ctx.relPath).replace(/\.(md|yaml)$/, '');
      const round       = parseLatestRound(raw);
      const error_count = parseLatestErrorCount(raw);

      if (parseVerifyFixStatus(raw, 'resolved')) {
        return {
          version:      1,
          type:         'verify_fix_pass',
          task_id,
          round:        round == null ? 1 : round,
          rounds_total: round == null ? 1 : round,
        };
      }
      if (parseVerifyFixStatus(raw, 'escalated')) {
        return {
          version:          1,
          type:             'verify_fix_fail',
          task_id,
          round:            round == null ? 1 : round,
          remaining_errors: error_count == null ? 0 : error_count,
        };
      }
      return null; // status does not warrant an emit
    },
  },

  // v2.3.20 item 1: state/tasks/<task>.md|yaml write where the two most
  // recent round_history entries show errors_current >= errors_previous
  // → verify_fix_oscillation (phase-verify.md §"Regression Prevention").
  // Co-matches the SAME file glob as task_verify_fix_round/_outcome above;
  // processEdit runs all three independently per v2.3.19 item 2.
  {
    id:        'task_verify_fix_oscillation',
    findingRef: 'v2320-item1',
    eventType: 'verify_fix_oscillation', // static default; overridden by resolveEventType
    match(rel) {
      return /^\.orchestray\/state\/tasks\/[^/]+\.(md|yaml)$/.test(rel);
    },
    resolveEventType(ctx) {
      const taskFile = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(taskFile, 'utf8'); }
      catch (_e) { return null; }
      const pairs = parseRoundHistoryPairs(raw);
      if (pairs.length < 2) return null;
      const cur  = pairs[pairs.length - 1];
      const prev = pairs[pairs.length - 2];
      return cur.errors >= prev.errors ? 'verify_fix_oscillation' : null;
    },
    // Keyed by the round the oscillation was detected at — a later round
    // that ALSO oscillates must re-fire, mirroring the `replan` pattern.
    resolveChangeKey(ctx) {
      const taskFile = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(taskFile, 'utf8'); }
      catch (_e) { return null; }
      const pairs = parseRoundHistoryPairs(raw);
      if (pairs.length < 2) return null;
      return 'oscillation_round:' + pairs[pairs.length - 1].round;
    },
    buildPayload(ctx) {
      const taskFile = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(taskFile, 'utf8'); }
      catch (_e) { return null; }
      const pairs = parseRoundHistoryPairs(raw);
      if (pairs.length < 2) return null;
      const cur  = pairs[pairs.length - 1];
      const prev = pairs[pairs.length - 2];
      if (cur.errors < prev.errors) return null;
      const task_id = path.basename(ctx.relPath).replace(/\.(md|yaml)$/, '');
      return {
        version:          1,
        type:             'verify_fix_oscillation',
        task_id,
        round:            cur.round,
        errors_current:   cur.errors,
        errors_previous:  prev.errors,
      };
    },
  },

  // B2-cb: state/confidence/task-*.json write → tier2_invoked (cognitive_backpressure)
  {
    id:        'cognitive_backpressure_write',
    findingRef: 'B2',
    eventType: 'tier2_invoked',
    match(rel) {
      return /^\.orchestray\/state\/confidence\/task-[^/]+\.json$/.test(rel);
    },
    buildPayload(ctx) {
      if (process.env.ORCHESTRAY_TIER2_WATCHER_DISABLED === '1') return null;
      const task_id = path.basename(ctx.relPath, '.json');
      return {
        version:        1,
        type:           'tier2_invoked',
        protocol:       'cognitive_backpressure',
        trigger_signal: 'state_watcher_backstop: ' + ctx.relPath,
        task_id,
      };
    },
  },

  // B2-ad: state/routing.jsonl write with documenter delegation entry
  //        → tier2_invoked (auto_documenter)
  {
    id:        'auto_documenter_routing',
    findingRef: 'B2',
    eventType: 'tier2_invoked',
    match(rel) {
      return rel === '.orchestray/state/routing.jsonl' ||
             rel === '.orchestray/audit/routing.jsonl';
    },
    buildPayload(ctx) {
      if (process.env.ORCHESTRAY_TIER2_WATCHER_DISABLED === '1') return null;
      const file = path.join(ctx.cwd, ctx.relPath);
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (_e) { return null; }
      // Only fire when a documenter delegation appears anywhere in the file.
      const hasDocumenter = raw.split('\n').some(line => {
        if (!line.trim()) return false;
        try {
          const entry = JSON.parse(line);
          return (
            entry &&
            (entry.agent_type === 'documenter' || entry.agent_role === 'documenter')
          );
        } catch (_e) { return false; }
      });
      if (!hasDocumenter) return null;
      return {
        version:        1,
        type:           'tier2_invoked',
        protocol:       'auto_documenter',
        trigger_signal: 'state_watcher_backstop: ' + ctx.relPath,
      };
    },
  },

  // B2-dp: state/disagree-*.json write → tier2_invoked (disagreement_protocol)
  {
    id:        'disagreement_protocol_write',
    findingRef: 'B2',
    eventType: 'tier2_invoked',
    match(rel) {
      return /^\.orchestray\/state\/disagree-[^/]+\.json$/.test(rel);
    },
    buildPayload(ctx) {
      if (process.env.ORCHESTRAY_TIER2_WATCHER_DISABLED === '1') return null;
      return {
        version:        1,
        type:           'tier2_invoked',
        protocol:       'disagreement_protocol',
        trigger_signal: 'state_watcher_backstop: ' + ctx.relPath,
      };
    },
  },

  // B2-ra: state/replay-*.json write → tier2_invoked (replay_analysis)
  {
    id:        'replay_analysis_write',
    findingRef: 'B2',
    eventType: 'tier2_invoked',
    match(rel) {
      return /^\.orchestray\/state\/replay-[^/]+\.json$/.test(rel);
    },
    buildPayload(ctx) {
      if (process.env.ORCHESTRAY_TIER2_WATCHER_DISABLED === '1') return null;
      return {
        version:        1,
        type:           'tier2_invoked',
        protocol:       'replay_analysis',
        trigger_signal: 'state_watcher_backstop: ' + ctx.relPath,
      };
    },
  },

  // v2.3.19 triage item 1: state/orchestration.md replan_count write → replan.
  // match() is deliberately broad (any write to orchestration.md) because
  // ordinary phase/status edits touch this file constantly; the actual gate
  // is content-based in resolveEventType/resolveChangeKey below, mirroring
  // the F-PM-12 round_history pattern.
  {
    id:        'orchestration_replan_count',
    findingRef: 'v2319-triage-item1',
    eventType: 'replan',
    match(rel) {
      return rel === '.orchestray/state/orchestration.md';
    },
    resolveEventType(ctx) {
      const count = readReplanCount(ctx);
      if (count == null || count <= 0) return null;
      return 'replan';
    },
    // The dedup key must include the count, not just the (static) event
    // type — otherwise a second, later replan in the same orchestration
    // would be suppressed as "status_unchanged" forever after the first.
    resolveChangeKey(ctx) {
      const count = readReplanCount(ctx);
      return count == null ? null : 'replan_count:' + count;
    },
    buildPayload(ctx) {
      const count = readReplanCount(ctx);
      if (count == null || count <= 0) return null;
      // old_task_count is fundamentally unrecoverable from this signal:
      // by the time replan_count increments (§16 step 7), task-graph.md
      // already holds the NEW graph (step 4 runs first). Best-effort,
      // same convention as the roi-snapshot/consequence_forecast targets
      // above — report what's knowable, default the rest to 0.
      let new_task_count = 0;
      try {
        const graphRaw = fs.readFileSync(
          path.join(ctx.cwd, '.orchestray', 'state', 'task-graph.md'), 'utf8',
        );
        const n = parseFrontmatterInt(graphRaw, 'total_tasks');
        if (n != null) new_task_count = n;
      } catch (_e) { /* fail-open */ }
      return {
        version:            1,
        type:               'replan',
        reason:             'state_watcher_backstop',
        old_task_count:     0,
        new_task_count,
        tasks_invalidated:  [],
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Mini-parsers (best-effort, fail-open)
// ---------------------------------------------------------------------------

/**
 * Check if the verify_fix block in YAML raw text has `status: <expected>`.
 * Returns true only when `verify_fix:` block is present AND the indented
 * `status:` key inside it has the expected value.
 * Best-effort — fails open (returns false) on error.
 */
function parseVerifyFixStatus(raw, expected) {
  if (!raw || !/verify_fix:/m.test(raw)) return false;
  const lines = raw.split('\n');
  let vfIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const vfMatch = /^(\s*)verify_fix:\s*$/.exec(line);
    if (vfMatch) {
      vfIndent = vfMatch[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j];
        if (!sub.trim()) continue;
        const subIndent = sub.length - sub.trimStart().length;
        if (subIndent <= vfIndent) break;
        const stMatch = /^\s+status:\s*(\w+)\s*$/.exec(sub);
        if (stMatch) {
          return stMatch[1] === expected;
        }
      }
      return false;
    }
  }
  return false;
}

/**
 * Find the highest-numbered `- round: <N>` in YAML round_history. Returns
 * null when no `round:` line is found.
 */
function parseLatestRound(raw) {
  let max = null;
  const re = /^\s*-?\s*round:\s*(\d+)\s*$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    if (max == null || n > max) max = n;
  }
  return max;
}

/**
 * Parse ordered `{round, errors}` pairs from a round_history block, pairing
 * each `- round: N` line with the `reviewer_issues:` line that follows it
 * (the shape every round_history entry in this codebase uses — see the
 * bonus fixtures below and phase-verify.md's round-history examples).
 * Order follows file order, i.e. round order. Best-effort — a `round:`
 * line with no matching `reviewer_issues:` line is simply dropped.
 */
function parseRoundHistoryPairs(raw) {
  const pairs = [];
  const lines = raw.split('\n');
  let pendingRound = null;
  for (const line of lines) {
    const rm = /^\s*-?\s*round:\s*(\d+)\s*$/.exec(line);
    if (rm) { pendingRound = parseInt(rm[1], 10); continue; }
    const em = /^\s*reviewer_issues:\s*(\d+)\s*$/.exec(line);
    if (em && pendingRound != null) {
      pairs.push({ round: pendingRound, errors: parseInt(em[1], 10) });
      pendingRound = null;
    }
  }
  return pairs;
}

/**
 * Best-effort: pick the last `reviewer_issues:` value (in round-history order).
 * Used as `error_count` when present.
 */
function parseLatestErrorCount(raw) {
  let last = null;
  const re = /reviewer_issues:\s*(\d+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

/**
 * Parse `- [direct] path/to/file — prediction text` lines under
 * "## Consequence Predictions". Returns an array of
 * `{target_file, category, prediction, verified, outcome}` rows.
 */
function parseConsequencePredictions(raw) {
  const out = [];
  // Match either an em-dash or a regular hyphen as the separator.
  const re = /^-\s*\[(direct|convention|test)\]\s+(\S+)\s*[—-]\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push({
      target_file: m[2],
      category:    m[1],
      prediction:  m[3],
      verified:    false,
      outcome:     'missed',
    });
    if (out.length >= 8) break; // §39 cap
  }
  return out;
}

/**
 * Read a top-level `<key>: <int>` YAML frontmatter line. Returns null when
 * absent or non-numeric. Best-effort — fails open.
 */
function parseFrontmatterInt(raw, key) {
  if (!raw) return null;
  const re = new RegExp('^' + key + ':\\s*(\\d+)\\s*$', 'm');
  const m = re.exec(raw);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Read `replan_count` from ctx.relPath (orchestration.md). Fail-open → null. */
function readReplanCount(ctx) {
  let raw;
  try { raw = fs.readFileSync(path.join(ctx.cwd, ctx.relPath), 'utf8'); }
  catch (_e) { return null; }
  return parseFrontmatterInt(raw, 'replan_count');
}

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_PM_EMIT_WATCHER_DISABLED === '1') return true;
  try {
    const cfgPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (
      cfg && cfg.pm_emit_watcher && cfg.pm_emit_watcher.enabled === false
    ) return true;
  } catch (_e) { /* config absent → default-on */ }
  return false;
}

// ---------------------------------------------------------------------------
// Orchestration-id resolver
// ---------------------------------------------------------------------------

function resolveOrchId(cwd) {
  try {
    const file = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.orchestration_id === 'string') {
      return data.orchestration_id;
    }
  } catch (_e) { /* fail-open */ }
  return null;
}

// ---------------------------------------------------------------------------
// Last-seen state file
// ---------------------------------------------------------------------------

function loadLastSeen(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, LAST_SEEN_REL), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_e) { /* fail-open */ }
  return {};
}

function saveLastSeen(cwd, data) {
  const filePath = path.join(cwd, LAST_SEEN_REL);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// "Did PM already emit this event in the recent window?"
// ---------------------------------------------------------------------------

function readEventsTail(cwd) {
  const filePath = path.join(cwd, EVENTS_REL);
  try {
    const stat = fs.statSync(filePath);
    if (!stat || !stat.isFile()) return '';
    let start = 0;
    if (stat.size > EVENTS_TAIL_BYTES) start = stat.size - EVENTS_TAIL_BYTES;
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_e) { return ''; }
}

/**
 * Did the PM emit `eventType` for this orchestration_id within
 * `RECENT_EMIT_WINDOW_MS`? Backstop emits are EXCLUDED — we only look for
 * rows the PM (or another non-backstop emitter) produced.
 *
 * @param {string}  [cachedTail] - E4: pre-read tail (see readEventsTail),
 *   reused across multiple targets matching the SAME file write instead of
 *   each re-reading the same 1 MB window. Falls back to a fresh read when
 *   omitted, so existing callers (this file, and any external reuse of the
 *   exported fn) are unaffected.
 */
function pmAlreadyEmitted(cwd, eventType, orchId, nowMs, cachedTail) {
  const tail = typeof cachedTail === 'string' ? cachedTail : readEventsTail(cwd);
  if (!tail) return false;
  const lines = tail.split('\n');
  // Iterate from the tail backwards so we exit on the first hit.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    let evt;
    try { evt = JSON.parse(l); }
    catch (_e) { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (evt.type !== eventType) continue;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) continue;
    // EXCLUDE prior backstop emits — they are NOT proof the PM did it.
    if (evt.source === 'state_watcher_backstop') continue;
    const tsMs = Date.parse(evt.timestamp || '');
    if (!Number.isFinite(tsMs)) continue;
    if (nowMs - tsMs <= RECENT_EMIT_WINDOW_MS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core API — exported for the CLI hook + tests
// ---------------------------------------------------------------------------

/**
 * Run one target's full resolve → idempotency → build → emit sequence for a
 * single file write. Extracted from `processEdit` in v2.3.19 so a file that
 * matches MULTIPLE targets (e.g. a `state/tasks/<id>.md` write that both
 * appends a round AND transitions status in one Edit) processes each
 * independently instead of only the first `WATCH_TARGETS.find()` hit.
 *
 * @param {object} target - one WATCH_TARGETS entry.
 * @param {{cwd:string, relPath:string, orchId:string, nowMs:number, eventsTail:string}} ctx
 * @returns {{ target_id: string, backstop_emitted: boolean, reason: string }}
 */
function processTarget(target, ctx) {
  const { cwd, relPath, orchId, nowMs } = ctx;

  // For targets with `resolveEventType`, derive the effective event type now
  // (before last-seen update) so idempotency and pmAlreadyEmitted use the
  // correct slug. Also enables early-exit when the resolved type is null
  // (e.g., verify_fix.status is still open).
  let effectiveEventType = target.eventType;
  if (typeof target.resolveEventType === 'function') {
    effectiveEventType = target.resolveEventType(ctx);
    if (!effectiveEventType) {
      return { target_id: target.id, backstop_emitted: false, reason: 'payload_null' };
    }
  }

  // Dedup key for the "did this specific state already fire?" check. Most
  // targets reuse the (static) event type; counter-style targets (e.g.
  // `replan`'s replan_count) supply `resolveChangeKey` so each new count
  // is treated as a distinct occurrence rather than being suppressed by
  // the first one forever.
  let changeKey = effectiveEventType;
  if (typeof target.resolveChangeKey === 'function') {
    changeKey = target.resolveChangeKey(ctx);
    if (changeKey == null) {
      return { target_id: target.id, backstop_emitted: false, reason: 'payload_null' };
    }
  }

  // E3 fix: the read(lastSeen) → idempotency-check → write(lastSeen) →
  // pmAlreadyEmitted → emit sequence below is ONE critical section. Without a
  // lock, two concurrent PostToolUse:Edit fires on the same relPath+target
  // (Agent Teams parallel tool calls, or an atomic-write tmp+rename pair
  // landing as two separate Edit hooks) can both load the SAME pre-update
  // lastSeen, both pass the idempotency check, and both emit — a double-fire.
  // Mirrors the {flag:'wx'} lock already used in this file
  // (checkOrchRoiPresence, checkReplanBudget) but uses the retrying mutex
  // (_withAdvisoryLock, ./atomic-append) since this is a genuine
  // read-modify-write section, not a fire-once-per-orchestration flag.
  const lockPath = path.join(cwd, LAST_SEEN_LOCK_REL);
  const locked = _withAdvisoryLock(lockPath, function () {
    // Idempotency: suppress re-emit when the same change was already
    // backstopped for this file+target in this orchestration. Keyed by
    // relPath+target.id (not relPath alone) so co-matching targets on the
    // same file don't clobber each other's dedup state.
    const lastSeen  = loadLastSeen(cwd);
    const lastKey   = relPath + '::' + target.id;
    const lastEntry = lastSeen[lastKey];
    if (
      lastEntry &&
      lastEntry.orchestration_id === orchId &&
      lastEntry.last_change_key  === changeKey
    ) {
      return { target_id: target.id, backstop_emitted: false, reason: 'status_unchanged' };
    }

    // Update last-seen (best-effort) BEFORE pmAlreadyEmitted/emit so a
    // concurrent waiter — blocked on this same lock — sees the claim as soon
    // as it acquires the lock next, even if this call's writeEvent fails.
    lastSeen[lastKey] = {
      mutated_at:       new Date(nowMs).toISOString(),
      orchestration_id: orchId,
      target_id:        target.id,
      last_event_type:  effectiveEventType,
      last_change_key:  changeKey,
    };
    saveLastSeen(cwd, lastSeen);

    // Did PM emit this event itself in the recent window? Reuses the tail
    // read once per processEdit call (E4) instead of re-reading per target.
    if (pmAlreadyEmitted(cwd, effectiveEventType, orchId, nowMs, ctx.eventsTail)) {
      return { target_id: target.id, backstop_emitted: false, reason: 'pm_emit_paired' };
    }

    // Build the canonical event payload (target-specific shape).
    let payload;
    try {
      payload = target.buildPayload(ctx);
    } catch (e) {
      process.stderr.write('[pm-emit-state-watcher] buildPayload threw: ' + e.message + '\n');
      return { target_id: target.id, backstop_emitted: false, reason: 'build_payload_error' };
    }
    if (!payload) {
      return { target_id: target.id, backstop_emitted: false, reason: 'payload_null' };
    }

    // Annotate as a backstop emit so consumers can distinguish it from a real PM emit.
    payload.source              = 'state_watcher_backstop';
    payload.original_state_file = relPath;
    payload.mutated_at          = new Date(nowMs).toISOString();

    try {
      writeEvent(payload, { cwd });
    } catch (_e) { /* fail-open */ }

    // Observability: signal the prose has rotted.
    try {
      writeEvent({
        version:             1,
        type:                'pm_emit_backstop_engaged',
        original_event_type: effectiveEventType,
        source_state_file:   relPath,
        finding_ref:         target.findingRef,
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    return { target_id: target.id, backstop_emitted: true, reason: 'backstop_engaged' };
  });

  if (locked && locked.skipped) {
    // Lock contention exhausted retries — fail-closed (BUG-7 pattern): skip
    // this fire rather than risk a double-emit racing the lock holder. The
    // next Edit on the same target re-derives the decision from fresh state.
    return { target_id: target.id, backstop_emitted: false, reason: 'lock_contention_skipped' };
  }
  return locked;
}

/**
 * Process a single tool-input event for one Edit/Write fire.
 *
 * @param {object} event - PostToolUse hook payload.
 *                         Required: tool_name, tool_input.file_path.
 * @param {object} [opts]
 * @param {string} [opts.cwd]      - Project root (default: resolveSafeCwd(event.cwd)).
 * @param {number} [opts.nowMs]    - Override clock for tests.
 * @returns {{
 *   processed:           boolean,
 *   target_id:           string|null,
 *   backstop_emitted:    boolean,
 *   reason:              string,
 *   results:             Array<{target_id, backstop_emitted, reason}>,
 * }}
 */
function processEdit(event, opts) {
  opts = opts || {};
  const cwd   = resolveSafeCwd(opts.cwd || (event && event.cwd));
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  // Defensive: only respond to Edit/Write fires.
  const toolName = event && event.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
    return { processed: false, target_id: null, backstop_emitted: false, reason: 'wrong_tool', results: [] };
  }

  const filePath = event && event.tool_input && event.tool_input.file_path;
  if (!filePath || typeof filePath !== 'string') {
    return { processed: false, target_id: null, backstop_emitted: false, reason: 'no_file_path', results: [] };
  }

  // Normalise to project-relative POSIX path so our matchers work uniformly.
  let relPath = filePath;
  if (path.isAbsolute(filePath)) {
    relPath = path.relative(cwd, filePath);
  }
  relPath = relPath.split(path.sep).join('/');

  // Defect 3: oversized_map_dispatched/_slice_skipped/_synthesis_complete
  // were unreachable for real detections — their only backstop
  // (checkOversizedInputCompleteness, orch-close-gated below) requires a live
  // orchestration marker, but real oversized-input detections happen on
  // UserPromptSubmit, almost always before/without any orchestration ever
  // starting. The buffer-artifact write (OI.6 step 2 — the one real
  // file-write signal in the map/synthesis protocol) fires either way, so
  // key the reconciliation on it directly instead of waiting for orch-close.
  // Runs ahead of (and independent of) the WATCH_TARGETS/orchId gates below —
  // this is not one of the 4 prose-emit targets they cover.
  if (!isDisabled(cwd) && /^\.orchestray\/kb\/artifacts\/oversized-buffer-[^/]+\.md$/.test(relPath)) {
    try { checkOversizedInputCompleteness(cwd, resolveOrchId(cwd) || 'unknown', opts.readLines); }
    catch (_e) { /* fail-open */ }
  }

  // v2.3.19: find ALL matching targets, not just the first. A single write
  // can carry more than one independent lifecycle signal (see W2.3.19
  // triage item 2 — `task_verify_fix_round` and `task_verify_fix_outcome`
  // both match every `state/tasks/*.md` write; `.find()` starved the
  // second one on every fire, which is why verify_fix_pass/fail never
  // backstopped despite the B1 target existing since v2.2.10).
  const matches = WATCH_TARGETS.filter(t => t.match(relPath));
  if (matches.length === 0) {
    return { processed: false, target_id: null, backstop_emitted: false, reason: 'no_match', results: [] };
  }

  if (isDisabled(cwd)) {
    return { processed: true, target_id: matches[0].id, backstop_emitted: false, reason: 'disabled', results: [] };
  }

  const orchId = resolveOrchId(cwd);
  // No active orchestration → nothing to observe. (This avoids polluting the
  // audit log with orphaned backstop rows when tests touch state files.)
  if (!orchId) {
    return { processed: true, target_id: matches[0].id, backstop_emitted: false, reason: 'no_orchestration', results: [] };
  }

  // E4 fix: up to 3 targets (task_verify_fix_round / _outcome / _oscillation)
  // match the same `state/tasks/*.md` write, and each independently called
  // pmAlreadyEmitted -> readEventsTail (1 MB tail read) — up to 3x redundant
  // I/O per Edit. Read the tail once here and pass it through ctx instead.
  const eventsTail = readEventsTail(cwd);
  const ctx     = { cwd, relPath, orchId, nowMs, eventsTail };
  const results = matches.map(target => processTarget(target, ctx));
  const anyEngaged = results.some(r => r.backstop_emitted);

  return {
    processed:        true,
    target_id:        matches[0].id,
    backstop_emitted: anyEngaged,
    reason:            anyEngaged ? 'backstop_engaged' : results[0].reason,
    results,
  };
}

// ---------------------------------------------------------------------------
// W2-5: replan budget guard — PM Stop check
// ---------------------------------------------------------------------------

/**
 * Counts `w_item_redo_requested` events for `orchId` in the provided lines,
 * compares to `replan_budget` from config (default 3), and emits
 * `replan_budget_exceeded` if the count exceeds the budget. Fires at most
 * once per orchestration via a lock file.
 *
 * Kill switch: ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED=1
 *
 * @param {string}   cwd       - Project root.
 * @param {string}   orchId    - Active orchestration_id.
 * @param {Function} readLines - fn(filePath) → string[] — injected for tests.
 */
function checkReplanBudget(cwd, orchId, readLines) {
  if (process.env.ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED === '1') return;
  if (!orchId) return;

  // Per-orch dedup via lock file — only fire once per orchestration_id.
  const lockPath = path.join(
    cwd, '.orchestray', 'state',
    'replan-budget-exceeded-' + orchId + '.lock',
  );
  if (fs.existsSync(lockPath)) return;

  // Read replan_budget from config (default 3).
  let replan_budget = 3;
  try {
    const cfgPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && typeof cfg.replan_budget === 'number' && Number.isFinite(cfg.replan_budget)) {
      replan_budget = cfg.replan_budget;
    }
  } catch (_e) { /* config absent → default 3 */ }

  // Read the orch event slice (archive preferred; live log as fallback).
  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const livePath    = path.join(cwd, EVENTS_REL);

  let lines;
  try {
    if (fs.existsSync(archivePath)) {
      lines = typeof readLines === 'function' ? readLines(archivePath) : fs.readFileSync(archivePath, 'utf8').split('\n');
    } else {
      lines = typeof readLines === 'function' ? readLines(livePath) : fs.readFileSync(livePath, 'utf8').split('\n');
    }
  } catch (_e) {
    lines = [];
  }

  // Count w_item_redo_requested events for this orchestration.
  let replan_count = 0;
  for (const l of lines) {
    const trimmed = typeof l === 'string' ? l.trim() : '';
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (evt.type !== 'w_item_redo_requested') continue;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) continue;
    replan_count++;
  }

  if (replan_count <= replan_budget) return; // at threshold is allowed; exceed = over

  // Write lock file before emitting so a second Stop fire is deduped.
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, orchId, { flag: 'wx' });
  } catch (_e) { /* flag: wx fails if already exists — that's the dedup */ }

  try {
    writeEvent({
      version:          1,
      type:             'replan_budget_exceeded',
      orchestration_id: orchId,
      replan_count,
      replan_budget,
      schema_version:   1,
    }, { cwd });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// B6: orchestration_roi presence check
// ---------------------------------------------------------------------------

/**
 * Watcher rule: orch_complete without prior orchestration_roi → emit
 * orchestration_roi_missing.
 *
 * Called from audit-pm-emit-coverage.js at orch_complete time (via the
 * audit-on-orch-complete.js fan-out). NOT triggered by a file-write watch
 * target — this is an orch-slice completeness check.
 *
 * Kill switches:
 *   ORCHESTRAY_ROI_WATCHED_DISABLED=1        — disables the entire rule (pre-existing).
 *   ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED=1  — disables per-orch dedup (legacy: emit
 *                                              on every PM Stop invocation).
 *
 * Per-orch dedup: a lock file `.orchestray/state/roi-missing-dedup-<orchId>.lock`
 * prevents re-emitting `orchestration_roi_missing` for the same orchestration_id
 * across multiple PM Stop invocations in the same session. Lock survives intentionally
 * (no cleanup) — orch ids are unique so stale locks are inert.
 *
 * @param {string}   cwd       - Project root.
 * @param {string}   orchId    - Active orchestration_id.
 * @param {Function} readLines - fn(filePath) → string[] — injected for tests.
 */
function checkOrchRoiPresence(cwd, orchId, readLines) {
  if (process.env.ORCHESTRAY_ROI_WATCHED_DISABLED === '1') return;
  if (!orchId) return;

  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const livePath    = path.join(cwd, EVENTS_REL);

  let lines;
  try {
    if (fs.existsSync(archivePath)) {
      lines = typeof readLines === 'function' ? readLines(archivePath) : fs.readFileSync(archivePath, 'utf8').split('\n');
    } else {
      lines = typeof readLines === 'function' ? readLines(livePath) : fs.readFileSync(livePath, 'utf8').split('\n');
    }
  } catch (_e) {
    lines = [];
  }

  const hasRoi = lines.some(l => {
    const trimmed = typeof l === 'string' ? l.trim() : '';
    if (!trimmed) return false;
    let evt;
    try { evt = JSON.parse(trimmed); }
    catch (_e) { return false; }
    if (!evt || typeof evt !== 'object') return false;
    if (evt.type !== 'orchestration_roi') return false;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) return false;
    return true;
  });

  if (!hasRoi) {
    // Per-orch dedup: emit at most once per orchestration_id per session.
    // Kill switch: ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED=1 → legacy behaviour (emit every call).
    if (process.env.ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED !== '1') {
      try {
        const stateDir  = path.join(cwd, '.orchestray', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        const lockFile = path.join(stateDir, 'roi-missing-dedup-' + orchId + '.lock');
        if (fs.existsSync(lockFile)) return; // already emitted for this orch
        try {
          fs.writeFileSync(lockFile, orchId, { flag: 'wx' }); // exclusive create — race-safe
        } catch (e) {
          if (e && e.code === 'EEXIST') return; // lost race — other call already emitted
          throw e;
        }
      } catch (_e) { /* fail-open: if lock logic errors, allow emit */ }
    }

    try {
      writeEvent({
        version:          1,
        type:             'orchestration_roi_missing',
        orchestration_id: orchId,
        reason:           'no orchestration_roi event in orch slice at orch_complete',
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }
}

// ---------------------------------------------------------------------------
// v2.3.20 item 2: oversized-input completeness check
// ---------------------------------------------------------------------------

/**
 * Reads `oversized_input.<key>` from config.json, falling back to `dflt`.
 * Fail-open — config absent/unparseable returns `dflt`.
 */
function readOversizedConfigString(cwd, key, dflt) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    const v = cfg && cfg.oversized_input && cfg.oversized_input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  } catch (_e) { /* fail-open */ }
  return dflt;
}

// Defensive cap on how many missing slice_ids one corpus can synthesize —
// mirrors the DIR_ENTRY_CAP-style caps used elsewhere in oversized-input code.
const OVERSIZED_SLICE_SCAN_CAP = 2000;

/**
 * Orch-close completeness check for the oversized-input map-reduce protocol
 * (oversized-input-mode.md OI.5/OI.6/OI.8). Unlike the other watcher rules,
 * this is NOT triggered by an Edit/Write — the real state changes are a Bash
 * `ox routing add` per slice and a synthesis Agent() result (no file write),
 * neither of which the PostToolUse:Edit|Write|MultiEdit hook can observe.
 *
 * Instead, at orch-close (same call site as checkOrchRoiPresence), this
 * reconstructs what SHOULD have been emitted from state that IS readable
 * regardless of which tool wrote it:
 *   - `oversized_input_detected` (corpus_id, natural_slices, mode) — ground
 *     truth that a corpus was sliced in this orchestration.
 *   - the KB buffer artifact `.orchestray/kb/artifacts/oversized-buffer-
 *     <corpus_id>.md` — lists KEPT slices only (OI.6 step 2); by orch-close
 *     it is stable, so kept-vs-natural-slices gives the exact dropped set.
 *
 * `mode: 'refuse'` corpora are skipped — nothing was ever dispatched for them.
 *
 * Kill switch: ORCHESTRAY_OVERSIZED_WATCHER_DISABLED=1
 * Idempotent by construction: each emit is gated on "does this event already
 * exist for this corpus_id/slice_id in the orch slice?", so re-running this
 * function (e.g. a second Stop-hook fire) never double-emits.
 *
 * @param {string}   cwd       - Project root.
 * @param {string}   orchId    - Active orchestration_id.
 * @param {Function} readLines - fn(filePath) → string[] — injected for tests.
 */
function checkOversizedInputCompleteness(cwd, orchId, readLines) {
  if (process.env.ORCHESTRAY_OVERSIZED_WATCHER_DISABLED === '1') return;
  if (!orchId) return;

  // E5: up to OVERSIZED_SLICE_SCAN_CAP writeEvent calls happen below. Neither
  // `orchestration_id` nor `timestamp` was set explicitly (unlike every other
  // check in this file — see checkOrchRoiPresence/checkReplanBudget/
  // checkStateCancelCompleteness), so withAutofill filled BOTH on every call,
  // which routes through emitAutofillTelemetry -> _advanceAutofillSample ->
  // a SECOND advisory-lock cycle on a different file (audit-autofill-
  // sample.json.lock), on top of the primary events.jsonl lock — doubling
  // the locked I/O for up to 2000 iterations. Supplying both explicitly (we
  // already have orchId; one timestamp for the whole reconstruction pass is
  // also more correct than 2000 microsecond-apart stamps) makes autofill a
  // no-op here, cutting locked writes back to the one the gateway requires.
  const nowIso = new Date().toISOString();

  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const livePath    = path.join(cwd, EVENTS_REL);

  let lines;
  try {
    if (fs.existsSync(archivePath)) {
      lines = typeof readLines === 'function' ? readLines(archivePath) : fs.readFileSync(archivePath, 'utf8').split('\n');
    } else {
      lines = typeof readLines === 'function' ? readLines(livePath) : fs.readFileSync(livePath, 'utf8').split('\n');
    }
  } catch (_e) {
    lines = [];
  }

  const parsed = [];
  for (const l of lines) {
    const trimmed = typeof l === 'string' ? l.trim() : '';
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) continue;
    parsed.push(evt);
  }

  const corpora = parsed.filter(e => e.type === 'oversized_input_detected' && e.mode !== 'refuse');
  if (corpora.length === 0) return;

  const mapModel        = readOversizedConfigString(cwd, 'map_model', 'haiku');
  const synthesisModel  = readOversizedConfigString(cwd, 'synthesis_model', 'sonnet');

  for (const detected of corpora) {
    const corpusId = detected.corpus_id;
    if (!corpusId) continue;
    const naturalSlices = Number.isFinite(detected.natural_slices) ? detected.natural_slices : 0;

    // --- oversized_map_dispatched -----------------------------------------
    const hasDispatched = parsed.some(e => e.type === 'oversized_map_dispatched' && e.corpus_id === corpusId);
    if (!hasDispatched) {
      try {
        writeEvent({
          version:             1,
          type:                'oversized_map_dispatched',
          orchestration_id:    orchId,
          timestamp:           nowIso,
          corpus_id:           corpusId,
          slice_count:         naturalSlices,
          map_model:           mapModel,
          source:              'state_watcher_backstop',
          original_state_file: '.orchestray/state/input-corpus/' + corpusId + '/manifest.json',
        }, { cwd });
      } catch (_e) { /* fail-open */ }
    }

    // --- kept-slice set from the KB buffer artifact (stable by orch-close) --
    const bufferRel  = '.orchestray/kb/artifacts/oversized-buffer-' + corpusId + '.md';
    const bufferPath = path.join(cwd, bufferRel);
    let bufferRaw = '';
    try { bufferRaw = fs.readFileSync(bufferPath, 'utf8'); } catch (_e) { /* no buffer yet — treat as all-dropped */ }
    const kept = new Set();
    const sliceRe = new RegExp('oi-' + corpusId + '-slice-(\\d+)', 'g');
    let m;
    while ((m = sliceRe.exec(bufferRaw)) !== null) kept.add(parseInt(m[1], 10));

    // --- oversized_slice_skipped — one per index NOT in the kept set --------
    const alreadySkipped = new Set(
      parsed.filter(e => e.type === 'oversized_slice_skipped' && e.corpus_id === corpusId)
            .map(e => e.slice_id),
    );
    const scanLimit = Math.min(naturalSlices, OVERSIZED_SLICE_SCAN_CAP);
    for (let i = 0; i < scanLimit; i++) {
      if (kept.has(i)) continue;
      const sliceId = 'oi-' + corpusId + '-slice-' + i;
      if (alreadySkipped.has(sliceId)) continue;
      try {
        writeEvent({
          version:             1,
          type:                'oversized_slice_skipped',
          orchestration_id:    orchId,
          timestamp:           nowIso,
          corpus_id:           corpusId,
          slice_id:            sliceId,
          source:              'state_watcher_backstop',
          original_state_file: bufferRel,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
    }

    // --- oversized_synthesis_complete ---------------------------------------
    const hasSynthesis = parsed.some(e => e.type === 'oversized_synthesis_complete' && e.corpus_id === corpusId);
    if (!hasSynthesis) {
      try {
        writeEvent({
          version:             1,
          type:                'oversized_synthesis_complete',
          orchestration_id:    orchId,
          timestamp:           nowIso,
          corpus_id:           corpusId,
          slices_kept:         kept.size,
          synthesis_model:     synthesisModel,
          source:              'state_watcher_backstop',
          original_state_file: bufferRel,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
    }
  }
}

// ---------------------------------------------------------------------------
// v2.3.21 item 1: state_cancel_aborted completeness check
// ---------------------------------------------------------------------------

/**
 * Orch-close completeness check for the cancel-abort sequence
 * (tier1-orchestration-rare.md §"Cancel" step 3 — `state_cancel_aborted`,
 * confirmed 0 emits ever). Like `checkOversizedInputCompleteness`, the real
 * state change (`mv .orchestray/state/ .orchestray/history/<orch_id>-cancelled/`)
 * is a Bash op, not an Edit/Write this hook can observe — so this fires
 * from the same orch-close fan-out instead.
 *
 * Ground truth: the archived directory `.orchestray/history/<orchId>-
 * cancelled/` existing on disk IS the abort having happened — nothing but
 * the PM's manual `mv` ever creates it (bin/state-cancel.js only writes the
 * sentinel; bin/check-pause-sentinel.js only blocks the next spawn). Per
 * event-schemas.md, the event is written to the LIVE audit log, not
 * archived into the cancelled dir — so "already emitted" is checked there.
 *
 * v2.3.33 W4: the path was previously `orch-<orchId>-cancelled` (doubled
 * prefix — orchId itself already starts with 'orch-') and was deliberately
 * "pinned" in v2.3.20 (commit a2ad3ec) on the theory that writer/reader
 * agreement made it safe to leave alone. That reasoning didn't check the
 * doubled form against the rest of the codebase's history-dir convention:
 * `bin/archive-orch-events.js` writes real, actively-used per-orchestration
 * archives at `.orchestray/history/<orch_id>/` (single prefix — orchId as
 * given, no extra 'orch-'), and `bin/ox.js`'s state-snapshot archiving uses
 * the same single-prefix `history/${orchId}/...` shape. `bin/state-gc.js`
 * also treats `history/orch-*` (i.e. dirs starting with the orchId itself)
 * as the canonical shape, with status suffixes like `-abandoned` appended
 * directly to the id — the same pattern `-cancelled` now follows. No
 * `*-cancelled` directory has ever existed on disk (grep of `.orchestray/
 * history/` across dev machines), so this is the first time the path is
 * actually exercised end-to-end; the single-prefix form is corrected here
 * to match every other archive path in the codebase before any real user
 * data is ever written under the doubled form.
 *
 * `events_jsonl_preserved` (E1 fix): derived from `fs.existsSync(livePath)`
 * — the LIVE audit log at EVENTS_REL, not a file inside `archivedDir`. The
 * `mv` only ever moves `.orchestray/state/`; audit events live in the
 * sibling `.orchestray/audit/` dir and are never touched by cancel, so no
 * `events.jsonl` has ever existed inside the archived dir to check. Checking
 * `archivedDir` made the field constant-false on every real cancellation.
 *
 * Kill switch: ORCHESTRAY_CANCEL_ABORT_WATCHER_DISABLED=1
 * Idempotent by construction: once this fires, the next call's "does
 * state_cancel_aborted already exist" check finds its own row and no-ops —
 * same self-healing shape as checkOversizedInputCompleteness, no lock file
 * needed (unlike checkOrchRoiPresence, whose absence-check can never
 * become satisfied by its own emission of a DIFFERENT event type).
 *
 * @param {string}   cwd
 * @param {string}   orchId
 * @param {Function} readLines - fn(filePath) → string[] — injected for tests.
 */
function checkStateCancelCompleteness(cwd, orchId, readLines) {
  if (process.env.ORCHESTRAY_CANCEL_ABORT_WATCHER_DISABLED === '1') return;
  if (!orchId) return;

  // Single "orch-<rest>-cancelled" form — orchId already starts with "orch-"
  // (bin/ox.js enforces this), so do not prepend a second "orch-". Matches
  // the real, actively-exercised history-dir convention (bin/archive-orch-
  // events.js: `.orchestray/history/<orch_id>/`; bin/ox.js state-snapshot
  // archiving: same shape). See the doc comment above for why the v2.3.20
  // "pinned" doubled-prefix form was wrong. This is the writer AND reader
  // convention as of v2.3.33 W4 — bin/check-pause-sentinel.js's block
  // message and tier1-orchestration-rare.md step 2 must match this exactly.
  const archivedToRel = '.orchestray/history/' + orchId + '-cancelled';
  const archivedDir   = path.join(cwd, archivedToRel);
  if (!fs.existsSync(archivedDir)) return; // never cancelled — nothing to reconstruct

  const livePath = path.join(cwd, EVENTS_REL);
  let lines;
  try {
    lines = typeof readLines === 'function' ? readLines(livePath) : fs.readFileSync(livePath, 'utf8').split('\n');
  } catch (_e) {
    lines = [];
  }

  const hasAbort = lines.some(l => {
    const trimmed = typeof l === 'string' ? l.trim() : '';
    if (!trimmed) return false;
    let evt;
    try { evt = JSON.parse(trimmed); }
    catch (_e) { return false; }
    if (!evt || typeof evt !== 'object') return false;
    if (evt.type !== 'state_cancel_aborted') return false;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) return false;
    return true;
  });
  if (hasAbort) return;

  // E1 fix (reviewer finding): nothing ever writes an events.jsonl INTO the
  // renamed state dir — audit events always live at EVENTS_REL, a sibling
  // directory the cancel `mv` never touches. Checking `archivedDir` made this
  // field false on every real cancellation. `livePath` (the actual audit log)
  // is the honest ground truth for "are this orchestration's events still
  // readable" — real events, not manufactured telemetry.
  const eventsPreserved = fs.existsSync(livePath);

  try {
    writeEvent({
      version:                1, // defect 1: every sibling emit in this file stamps version:1 explicitly
      type:                   'state_cancel_aborted',
      orchestration_id:       orchId,
      archived_to:            archivedToRel,
      events_jsonl_preserved: eventsPreserved,
      source:                 'state_watcher_backstop',
      original_state_file:    archivedToRel,
    }, { cwd });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// v2.3.20 item 4: dynamic-target zero-emission detector
// ---------------------------------------------------------------------------

/**
 * Catches the class of bug `pm_emit_prose_rotting`'s 2-event floor
 * structurally cannot: a type that emits ZERO times despite its trigger
 * condition having demonstrably fired. Scoped to WATCH_TARGETS that use
 * `resolveEventType` ("dynamic" targets: task_verify_fix_outcome,
 * task_verify_fix_oscillation, orchestration_replan_count) — for those,
 * `pm-emit-watcher.last-seen.json` only records an entry AFTER
 * `resolveEventType` has already resolved a concrete (non-null) event type
 * (see `processTarget`), so an entry there is proof the trigger condition
 * was met, not just that the file was touched.
 *
 * NOT extended to static-eventType targets (kb_decisions_write,
 * roi_snapshot_write, task_verify_fix_round, consequences_write, the B2
 * tier2_invoked family): those record a last-seen entry on EVERY matching
 * file write regardless of whether buildPayload later no-ops (e.g. every
 * `state/tasks/*.md` write is recorded under task_verify_fix_round even for
 * task files with no verify_fix block at all — see the "WITHOUT verify_fix
 * block" test). Treating that as trigger-proof would false-positive on any
 * orchestration that simply never entered a verify-fix loop. Reasoned no:
 * the floor-of-2 stays for that subset; it does not have the same
 * "zero looks identical to normal" problem this check targets.
 *
 * Under correct operation `total` should never be 0 here — either the PM's
 * own emit satisfied the trigger (total >= 1) or the backstop fired
 * (total >= 1). A genuine 0 means buildPayload/writeEvent diverged from
 * resolveEventType's verdict — the exact class of silent regression this
 * detector exists to catch.
 *
 * Kill switch: ORCHESTRAY_ZERO_EMISSION_WATCHER_DISABLED=1
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {object} tallyCounts - `{ [eventType]: {pm, backstop} }`, as produced
 *                               by audit-pm-emit-coverage.js's tallyEvents().
 */
function checkDynamicTargetZeroEmission(cwd, orchId, tallyCounts) {
  if (process.env.ORCHESTRAY_ZERO_EMISSION_WATCHER_DISABLED === '1') return;
  if (!orchId || !tallyCounts) return;

  let lastSeen;
  try {
    lastSeen = JSON.parse(fs.readFileSync(path.join(cwd, LAST_SEEN_REL), 'utf8'));
  } catch (_e) { return; }
  if (!lastSeen || typeof lastSeen !== 'object') return;

  const dynamicTargetIds = new Set(
    WATCH_TARGETS.filter(t => typeof t.resolveEventType === 'function').map(t => t.id),
  );

  const triggeredTypes = new Set();
  for (const key of Object.keys(lastSeen)) {
    const entry = lastSeen[key];
    if (!entry || entry.orchestration_id !== orchId) continue;
    if (!dynamicTargetIds.has(entry.target_id)) continue;
    if (entry.last_event_type) triggeredTypes.add(entry.last_event_type);
  }

  for (const eventType of triggeredTypes) {
    const c = tallyCounts[eventType];
    const total = c ? (c.pm + c.backstop) : 0;
    if (total > 0) continue; // >=1 already proves the trigger produced a real event
    try {
      writeEvent({
        version:        1,
        type:           'pm_emit_prose_rotting',
        event_type:     eventType,
        pm_count:       0,
        backstop_count: 0,
        ratio:          1,
        zero_emission:  true,
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  processEdit,
  checkOrchRoiPresence,
  checkReplanBudget,
  checkOversizedInputCompleteness,
  checkStateCancelCompleteness,
  checkDynamicTargetZeroEmission,
  WATCH_TARGETS,
  // v2.3.19: promoted to real exports (were test-only) so the oversized-input
  // driving code (bin/oversized-extract.js, bin/detect-oversized-lifecycle.js)
  // can reuse the SAME "did the PM already emit this" pairing-window check
  // instead of re-implementing it — avoids the two mechanisms disagreeing on
  // what counts as a paired manual emit.
  pmAlreadyEmitted,
  resolveOrchId,
  // Visible for tests:
  _internals: {
    parseLatestRound,
    parseLatestErrorCount,
    parseRoundHistoryPairs,
    parseConsequencePredictions,
    parseVerifyFixStatus,
    pmAlreadyEmitted,
    isDisabled,
  },
};
