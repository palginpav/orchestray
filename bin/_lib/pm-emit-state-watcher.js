'use strict';

/**
 * pm-emit-state-watcher.js — backstop emitter for 4 prose-only PM events
 * (v2.2.9 B-8).
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
];

// ---------------------------------------------------------------------------
// Mini-parsers (best-effort, fail-open)
// ---------------------------------------------------------------------------

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

  // Update last-seen (best-effort).
  const lastSeen = loadLastSeen(cwd);
  lastSeen[relPath] = {
    mutated_at:       new Date(nowMs).toISOString(),
    orchestration_id: orchId,
    target_id:        target.id,
  };
  saveLastSeen(cwd, lastSeen);

  // Did PM emit this event itself in the recent window?
  if (pmAlreadyEmitted(cwd, target.eventType, orchId, nowMs)) {
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
      original_event_type: target.eventType,
      source_state_file:   relPath,
      finding_ref:         target.findingRef,
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  return { processed: true, target_id: target.id, backstop_emitted: true, reason: 'backstop_engaged' };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  processEdit,
  WATCH_TARGETS,
  // Visible for tests:
  _internals: {
    parseLatestRound,
    parseLatestErrorCount,
    parseConsequencePredictions,
    pmAlreadyEmitted,
    isDisabled,
  },
};
