#!/usr/bin/env node
'use strict';

/**
 * inject-tokenwright.js — PreToolUse:Agent hook.
 *
 * v2.3.18 retirement (W1f): the L1 MinHash compression pipeline (runL1 and
 * the tokenwright.l1_compression_enabled gate that guarded it) has been
 * removed. It shipped default-off since v2.2.19 and was reaffirmed dead in
 * the v2.2.20 corpus audit (0/477 production prompts matched any
 * dedup-eligible heading — see .orchestray/kb/artifacts/v2219-compression-rca.md
 * §Symptom 1 and .orchestray/kb/artifacts/v2220-l1-revival-design.md
 * §Executive Verdict). The mechanics (parseSections, classifySection,
 * applyMinHashDedup) remain as tested library code under
 * bin/_lib/tokenwright/ for a possible future revival — they are just no
 * longer wired into this hot spawn-time path.
 *
 * What this hook still does on every Agent spawn:
 *   - Passes the delegation prompt through UNMODIFIED (no compression).
 *   - Writes a lightweight pre-spawn token estimate (bootstrapEstimate) to
 *     the pending journal so bin/capture-tokenwright-realized.js can keep
 *     emitting tokenwright_realized_savings / tokenwright_estimation_drift
 *     telemetry (estimation-accuracy tracking, independent of compression —
 *     see v2219-compression-rca.md §Symptom 2 "lightweight pre-spawn
 *     estimate write" recommendation).
 *   - Emits compression_skipped for kill-switch / no-prompt / exception
 *     paths, and compression_double_fire_detected / tokenwright_journal_truncated
 *     for the journal-write guard rails.
 *
 * Kill switches: ORCHESTRAY_DISABLE_COMPRESSION=1, cfg.compression.enabled===false.
 * ORCHESTRAY_DISABLE_SKIP_EVENT=1 or cfg.compression.skip_event_enabled===false restores
 * silent behavior.
 * ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1 or cfg.compression.double_fire_guard_enabled===false
 * skips the double-fire guard.
 *
 * Fail-safe: any exception → original tool_input unchanged, spawn always allowed.
 * routing.jsonl is never opened, read, or written by this hook.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const {
  emitCompressionSkipped,
  emitCompressionDoubleFireDetected,
  emitTokenwrightJournalTruncated,
} = require('./_lib/tokenwright/emit');
const { checkDoubleFire }    = require('./_lib/tokenwright/double-fire-guard');
const { sweepJournal }       = require('./_lib/tokenwright/journal-sweep');
const { bootstrapEstimate }  = require('./_lib/tokenwright/bootstrap-estimator');
const { readHookInputRaw } = require('./_lib/hook-stdin');

// ---------------------------------------------------------------------------
// Per-process skip-event dedup cache (suppress duplicate skips per reason)
// ---------------------------------------------------------------------------
const _skipEmitCache = new Set();

function emitPassthrough(toolInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', modifiedToolInput: toolInput },
    continue: true,
  }));
}

function loadConfig(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8')); }
  catch (_e) { return {}; }
}

function resolveOrchestrationId(cwd) {
  try {
    const d = JSON.parse(fs.readFileSync(getCurrentOrchestrationFile(cwd), 'utf8'));
    return (d && typeof d.orchestration_id === 'string') ? d.orchestration_id : null;
  } catch (_e) { return null; }
}

function spawnKey(agentType, prompt) {
  return (agentType || 'unknown') + ':' +
    crypto.createHash('sha256').update(prompt || '').digest('hex').slice(0, 32);
}

function skipEventEnabled(cfg) {
  if (process.env.ORCHESTRAY_DISABLE_SKIP_EVENT === '1') return false;
  if (cfg.compression && cfg.compression.skip_event_enabled === false) return false;
  return true;
}

function doubleFireGuardEnabled(cfg) {
  if (process.env.ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD === '1') return false;
  if (cfg.compression && cfg.compression.double_fire_guard_enabled === false) return false;
  return true;
}

/**
 * Emit a compression_skipped event, suppressing duplicates per (orchId, reason).
 * Dedup is process-local; cross-invocation dedup not required.
 */
function emitSkip(cfg, orchId, agentType, reason, skipPath) {
  if (!skipEventEnabled(cfg)) return;
  const cacheKey = `${orchId || 'unknown'}|${reason}`;
  if (_skipEmitCache.has(cacheKey)) return;
  _skipEmitCache.add(cacheKey);
  emitCompressionSkipped({ orchestration_id: orchId, agent_type: agentType, reason, skip_path: skipPath });
}

/**
 * Read the pending journal, sweep it, and return kept entries.
 */
function readAndSweepJournal(pendingPath, cfg) {
  let entries = [];
  try {
    if (fs.existsSync(pendingPath)) {
      const raw = fs.readFileSync(pendingPath, 'utf8');
      entries = raw.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch (_e) { return null; }
      }).filter(Boolean);
    }
  } catch (_e) { entries = []; }

  const ttlHours   = (cfg.compression && typeof cfg.compression.pending_journal_ttl_hours   === 'number') ? cfg.compression.pending_journal_ttl_hours   : 24;
  const maxBytes   = (cfg.compression && typeof cfg.compression.pending_journal_max_bytes    === 'number') ? cfg.compression.pending_journal_max_bytes    : 10240;
  const maxEntries = (cfg.compression && typeof cfg.compression.pending_journal_max_entries  === 'number') ? cfg.compression.pending_journal_max_entries  : 100;

  const { kept, truncationEvent } = sweepJournal({ entries, ttlHours, maxBytes, maxEntries });
  return { kept, truncationEvent };
}

/**
 * Write pending journal entries back to disk.
 */
function writeJournal(pendingPath, entries) {
  try {
    const dir = path.dirname(pendingPath);
    fs.mkdirSync(dir, { recursive: true });
    const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    fs.writeFileSync(pendingPath, content, 'utf8');
  } catch (_e) {
    try { process.stderr.write('[inject-tokenwright] journal write failed: ' + String(_e) + '\n'); }
    catch (_i) { /* swallow */ }
  }
}

let input = '';
input = readHookInputRaw();
if (input.length > MAX_INPUT_BYTES) {
  process.stderr.write('[inject-tokenwright] stdin exceeded limit; failing open\n');
  // oversize_stdin: we don't have parsed context yet, so minimal payload
  // We attempt to emit with what we know: no orchId yet at this point
  // but we can at least try after parsing
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}
setImmediate(() => {
  let toolInput;
  let cfg = {};
  let orchId = null;
  let agentType = 'unknown';

  try {
    let event;
    try { event = JSON.parse(input || '{}'); }
    catch (_e) {
      // parse_failure on stdin JSON
      emitSkip(cfg, orchId, agentType, 'parse_failure', 'stdin_json_parse_error');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
      return;
    }

    if ((event.tool_name || '') !== 'Agent') {
      process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); return;
    }

    toolInput = event.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
      emitSkip(cfg, orchId, agentType, 'no_prompt_field', 'tool_input_missing_or_not_object');
      process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); return;
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

    cfg       = loadConfig(cwd);
    orchId    = resolveOrchestrationId(cwd);
    agentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : 'unknown';

    // Kill switch: env var
    if (process.env.ORCHESTRAY_DISABLE_COMPRESSION === '1') {
      emitSkip(cfg, orchId, agentType, 'kill_switch_env', 'ORCHESTRAY_DISABLE_COMPRESSION=1');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    // Kill switch: config
    if (cfg.compression && cfg.compression.enabled === false) {
      emitSkip(cfg, orchId, agentType, 'kill_switch_config', 'compression.enabled=false');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : null;
    if (prompt === null) {
      emitSkip(cfg, orchId, agentType, 'no_prompt_field', 'toolInput.prompt_not_string');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    const inBytes  = Buffer.byteLength(prompt, 'utf8');
    const stateDir = path.join(cwd, '.orchestray', 'state');

    // Double-fire guard — still needed so the lightweight estimate write
    // below doesn't double-journal the same spawn on a duplicate hook fire.
    if (doubleFireGuardEnabled(cfg)) {
      // v2.3.19 fix: dedupToken used to embed a locally-computed Date.now()
      // stamped independently by each racing process, so two installs
      // handling the SAME Agent spawn never produced matching tokens — the
      // guard structurally could not detect a single duplicate in the
      // entire event log despite firing on every spawn
      // (v2319-guard-window-analysis.md §4). event.tool_use_id identifies
      // the underlying tool call and is delivered identically to both
      // racing installs, so keying on it is deterministic across the race
      // while staying unique per real spawn. Falls back to the prompt text
      // when tool_use_id is absent (defensive — expected present on every
      // PreToolUse:Agent payload).
      const spawnDiscriminator = (typeof event.tool_use_id === 'string' && event.tool_use_id)
        ? event.tool_use_id
        : prompt;
      const dedupToken = crypto.createHash('sha256')
        .update(agentType + ':' + spawnDiscriminator).digest('hex').slice(0, 16);
      const { shouldFire, doubleFireEvent } = checkDoubleFire({
        dedupToken,
        callerPath: __filename,
        stateDir,
        orchestrationId: orchId,
      });
      if (!shouldFire) {
        if (doubleFireEvent) {
          emitCompressionDoubleFireDetected(doubleFireEvent);
        }
        emitPassthrough(toolInput); process.exit(0); return;
      }
    }

    // Lightweight pre-spawn token estimate (no compression pipeline runs).
    // See v2219-compression-rca.md §Symptom 2 — kept so realized-savings /
    // estimation-drift telemetry in capture-tokenwright-realized.js keeps
    // receiving data after the L1 pipeline's retirement.
    const inTokEst  = bootstrapEstimate(agentType, { cwd, config: cfg, inBytes });
    const pendingPath = path.join(stateDir, 'tokenwright-pending.jsonl');
    const { kept, truncationEvent } = readAndSweepJournal(pendingPath, cfg);

    if (truncationEvent) {
      emitTokenwrightJournalTruncated(Object.assign({ orchestration_id: orchId }, truncationEvent));
    }

    const ttlHours = (cfg.compression && typeof cfg.compression.pending_journal_ttl_hours === 'number')
      ? cfg.compression.pending_journal_ttl_hours : 24;
    const newEntry = {
      spawn_key:            spawnKey(agentType, prompt),
      orchestration_id:     orchId,
      task_id:              null,
      agent_type:           agentType,
      technique_tag:        'passthrough',
      input_token_estimate: inTokEst,
      timestamp:            new Date().toISOString(),
      expires_at:           Date.now() + (ttlHours * 3600 * 1000),
    };
    writeJournal(pendingPath, [...kept, newEntry]);

    emitPassthrough(toolInput);
    process.exit(0);

  } catch (_err) {
    const errMsg = String(_err && _err.message ? _err.message : _err);
    try { process.stderr.write('[inject-tokenwright] exception: ' + errMsg + '\n'); }
    catch (_e) { /* swallow */ }
    try {
      emitSkip(cfg, orchId, agentType, 'runtime_exception', errMsg.slice(0, 200));
    } catch (_e) { /* swallow */ }
    if (toolInput && typeof toolInput === 'object') emitPassthrough(toolInput);
    else process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
