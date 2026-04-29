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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAST_SEEN_REL = path.join('.orchestray', 'state', 'pm-emit-watcher.last-seen.json');
const EVENTS_REL    = path.join('.orchestray', 'audit', 'events.jsonl');

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
 */
function pmAlreadyEmitted(cwd, eventType, orchId, nowMs) {
  const tail = readEventsTail(cwd);
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
 * }}
 */
function processEdit(event, opts) {
  opts = opts || {};
  const cwd   = resolveSafeCwd(opts.cwd || (event && event.cwd));
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  // Defensive: only respond to Edit/Write fires.
  const toolName = event && event.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
    return { processed: false, target_id: null, backstop_emitted: false, reason: 'wrong_tool' };
  }

  const filePath = event && event.tool_input && event.tool_input.file_path;
  if (!filePath || typeof filePath !== 'string') {
    return { processed: false, target_id: null, backstop_emitted: false, reason: 'no_file_path' };
  }

  // Normalise to project-relative POSIX path so our matchers work uniformly.
  let relPath = filePath;
  if (path.isAbsolute(filePath)) {
    relPath = path.relative(cwd, filePath);
  }
  relPath = relPath.split(path.sep).join('/');

  // Find a matching target.
  const target = WATCH_TARGETS.find(t => t.match(relPath));
  if (!target) {
    return { processed: false, target_id: null, backstop_emitted: false, reason: 'no_match' };
  }

  if (isDisabled(cwd)) {
    return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'disabled' };
  }

  const orchId = resolveOrchId(cwd);
  // No active orchestration → nothing to observe. (This avoids polluting the
  // audit log with orphaned backstop rows when tests touch state files.)
  if (!orchId) {
    return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'no_orchestration' };
  }

  // For targets with `resolveEventType`, derive the effective event type now
  // (before last-seen update) so idempotency and pmAlreadyEmitted use the
  // correct slug. Also enables early-exit when the resolved type is null
  // (e.g., verify_fix.status is still open).
  let effectiveEventType = target.eventType;
  if (typeof target.resolveEventType === 'function') {
    effectiveEventType = target.resolveEventType({ cwd, relPath, orchId, nowMs });
    if (!effectiveEventType) {
      // Status is not a terminal value we care about — no-op.
      return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'payload_null' };
    }
  }

  // Idempotency for status-keyed targets (B1): suppress re-emit when the same
  // status was already backstopped for this file in this orchestration.
  const lastSeen = loadLastSeen(cwd);
  const lastEntry = lastSeen[relPath];
  if (
    lastEntry &&
    lastEntry.orchestration_id === orchId &&
    lastEntry.last_event_type  === effectiveEventType
  ) {
    return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'status_unchanged' };
  }

  // Update last-seen (best-effort).
  lastSeen[relPath] = {
    mutated_at:       new Date(nowMs).toISOString(),
    orchestration_id: orchId,
    target_id:        target.id,
    last_event_type:  effectiveEventType,
  };
  saveLastSeen(cwd, lastSeen);

  // Did PM emit this event itself in the recent window?
  if (pmAlreadyEmitted(cwd, effectiveEventType, orchId, nowMs)) {
    return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'pm_emit_paired' };
  }

  // Build the canonical event payload (target-specific shape).
  let payload;
  try {
    payload = target.buildPayload({ cwd, relPath, orchId, nowMs });
  } catch (e) {
    process.stderr.write('[pm-emit-state-watcher] buildPayload threw: ' + e.message + '\n');
    return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'build_payload_error' };
  }
  if (!payload) {
    return { processed: true, target_id: target.id, backstop_emitted: false, reason: 'payload_null' };
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

  return { processed: true, target_id: target.id, backstop_emitted: true, reason: 'backstop_engaged' };
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
 * Kill switch: ORCHESTRAY_ROI_WATCHED_DISABLED=1
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
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  processEdit,
  checkOrchRoiPresence,
  WATCH_TARGETS,
  // Visible for tests:
  _internals: {
    parseLatestRound,
    parseLatestErrorCount,
    parseConsequencePredictions,
    parseVerifyFixStatus,
    pmAlreadyEmitted,
    isDisabled,
  },
};
