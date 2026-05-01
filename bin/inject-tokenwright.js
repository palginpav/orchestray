#!/usr/bin/env node
'use strict';

/**
 * inject-tokenwright.js — PreToolUse:Agent hook (v2.2.6, tokenwright L1).
 *
 * v2.2.6 changes vs v2.2.5:
 *   - All silent skip paths now emit compression_skipped (event 5)
 *   - Double-fire guard via checkDoubleFire (event 6, §B3)
 *   - Journal sweep on write: TTL + size cap + count cap (event 7, §B4)
 *   - Invariant check post-compression: verifyLoadBearing (event 2, §B1)
 *   - Extended prompt_compression payload: sections_total, eligibility_rate,
 *     dedup_drop_by_heading, compression_skipped_path, tokenwright_version
 *   - expires_at added to pending journal entries (§B4)
 *
 * Kill switches: ORCHESTRAY_DISABLE_COMPRESSION=1, cfg.compression.enabled===false,
 * level 'off', level 'debug-passthrough'. All skip paths now emit compression_skipped.
 * ORCHESTRAY_DISABLE_SKIP_EVENT=1 or cfg.compression.skip_event_enabled===false restores
 * silent behavior.
 * ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1 or cfg.compression.double_fire_guard_enabled===false
 * skips the double-fire guard.
 * ORCHESTRAY_DISABLE_INVARIANT_CHECK=1 or cfg.compression.invariant_check_enabled===false
 * skips the load-bearing invariant check.
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
const { parseSections, reassembleSections } = require('./_lib/tokenwright/parse-sections');
const { classifySection, DEDUP_ELIGIBLE_HEADINGS } = require('./_lib/tokenwright/classify-section');
const { applyMinHashDedup }           = require('./_lib/tokenwright/dedup-minhash');
const {
  emitPromptCompression,
  emitCompressionSkipped,
  emitCompressionDoubleFireDetected,
  emitCompressionInvariantViolated,
  emitTokenwrightJournalTruncated,
} = require('./_lib/tokenwright/emit');
const { checkDoubleFire }    = require('./_lib/tokenwright/double-fire-guard');
const { sweepJournal }       = require('./_lib/tokenwright/journal-sweep');
const { verifyLoadBearing, DEFAULT_LOAD_BEARING_SECTIONS } = require('./_lib/tokenwright/verify-load-bearing');
const { bootstrapEstimate }  = require('./_lib/tokenwright/bootstrap-estimator');

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

function resolveLevel(cfg) {
  const env = process.env.ORCHESTRAY_COMPRESSION_LEVEL;
  if (env) return env;
  return (cfg.compression && cfg.compression.level) || 'safe';
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

function invariantCheckEnabled(cfg) {
  if (process.env.ORCHESTRAY_DISABLE_INVARIANT_CHECK === '1') return false;
  if (cfg.compression && cfg.compression.invariant_check_enabled === false) return false;
  return true;
}

/**
 * Emit a compression_skipped event, suppressing duplicates per (orchId, reason).
 * Dedup is process-local; cross-invocation dedup not required for v2.2.6.
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

function runL1(prompt) {
  const sections = parseSections(prompt);
  for (const s of sections) s.kind = classifySection(s).kind;
  const { dropped: droppedCount } = applyMinHashDedup(sections);

  // Section counts
  const sectionsTotal          = sections.length;
  const sectionsDedupEligible  = sections.filter(s => s.kind === 'dedup-eligible').length;
  const sectionsScoreEligible  = sections.filter(s => s.kind === 'score-eligible').length;
  const sectionsPreserve       = sections.filter(s => s.kind === 'preserve').length;
  const eligibilityRate        = sectionsTotal > 0
    ? (sectionsDedupEligible + sectionsScoreEligible) / sectionsTotal
    : 0;

  // Per-heading drop counts for every DEDUP_ELIGIBLE_HEADINGS entry
  const dedupDropByHeading = {};
  for (const h of DEDUP_ELIGIBLE_HEADINGS) dedupDropByHeading[h] = 0;
  const droppedSections = sections.filter(s => s.dropped);
  for (const s of droppedSections) {
    const h = s.heading || '(preamble)';
    if (h in dedupDropByHeading) dedupDropByHeading[h]++;
  }

  // Dropped sections as object array (v2.2.6 shape)
  const droppedSectionsObjects = droppedSections.map(s => ({
    heading:       s.heading || null,
    kind:          s.kind || 'unknown',
    body_bytes:    s.raw ? Buffer.byteLength(s.raw, 'utf8') : 0,
    dropped_reason: 'minhash_dedup',
  }));

  return {
    compressed: reassembleSections(sections),
    droppedSections: droppedSectionsObjects,
    droppedCount,
    sectionsTotal,
    sectionsDedupEligible,
    sectionsScoreEligible,
    sectionsPreserve,
    eligibilityRate,
    dedupDropByHeading,
  };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[inject-tokenwright] stdin exceeded limit; failing open\n');
    // oversize_stdin: we don't have parsed context yet, so minimal payload
    // We attempt to emit with what we know: no orchId yet at this point
    // but we can at least try after parsing
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
process.stdin.on('end', () => {
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
    const level = resolveLevel(cfg);
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

    // S1 kill switch: tokenwright.l1_compression_enabled (v2.2.19).
    // Default false until heading-list audit is complete (revival planned for v2.2.20).
    // See .orchestray/kb/artifacts/v2219-compression-rca.md §Symptom 1.
    const l1Enabled = cfg.tokenwright && typeof cfg.tokenwright.l1_compression_enabled === 'boolean'
      ? cfg.tokenwright.l1_compression_enabled
      : false; // default-off
    if (!l1Enabled) {
      emitSkip(cfg, orchId, agentType, 'kill_switch_config', 'tokenwright.l1_compression_enabled=false');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    // Level: off
    if (level === 'off') {
      emitSkip(cfg, orchId, agentType, 'level_off', 'ORCHESTRAY_COMPRESSION_LEVEL=off');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    // Level: debug-passthrough
    if (level === 'debug-passthrough') {
      emitSkip(cfg, orchId, agentType, 'level_debug_passthrough', 'level=debug-passthrough');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : null;
    if (prompt === null) {
      emitSkip(cfg, orchId, agentType, 'no_prompt_field', 'toolInput.prompt_not_string');
      emitPassthrough(toolInput); process.exit(0); return;
    }

    const inBytes  = Buffer.byteLength(prompt, 'utf8');
    const tag      = level === 'aggressive' ? 'aggressive-l1' : level === 'experimental' ? 'experimental-l1' : 'safe-l1';
    const stateDir = path.join(cwd, '.orchestray', 'state');

    // Double-fire guard
    if (doubleFireGuardEnabled(cfg)) {
      const spawnTs   = Date.now();
      const dedupToken = crypto.createHash('sha256')
        .update(prompt + agentType + String(spawnTs)).digest('hex').slice(0, 16);
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

    // Run L1 compression
    const {
      compressed,
      droppedSections,
      droppedCount,
      sectionsTotal,
      sectionsDedupEligible,
      sectionsScoreEligible,
      sectionsPreserve,
      eligibilityRate,
      dedupDropByHeading,
    } = runL1(prompt);

    // Invariant check post-compression
    let compressionSkippedPath = null;
    let finalPrompt = compressed;

    if (invariantCheckEnabled(cfg)) {
      const loadBearingSet = (cfg.compression && Array.isArray(cfg.compression.load_bearing_sections))
        ? cfg.compression.load_bearing_sections
        : DEFAULT_LOAD_BEARING_SECTIONS;

      const { violated, violatedSection, violationKind } = verifyLoadBearing({
        originalPrompt:   prompt,
        compressedPrompt: compressed,
        loadBearingSet,
      });

      if (violated) {
        emitCompressionInvariantViolated({
          orchestration_id: orchId,
          agent_type:       agentType,
          violated_section: violatedSection,
          violation_kind:   violationKind,
          input_bytes_pre:  inBytes,
          input_bytes_post: Buffer.byteLength(compressed, 'utf8'),
          load_bearing_set: loadBearingSet,
        });
        // Fallback to original if configured (default true)
        const fallback = !(cfg.compression && cfg.compression.invariant_check_fallback_to_original === false);
        if (fallback) {
          finalPrompt = prompt;
          compressionSkippedPath = 'invariant_violation_fallback';
        }
      }
    }

    const outBytes   = Buffer.byteLength(finalPrompt, 'utf8');
    const ratio      = inBytes > 0 ? outBytes / inBytes : 1;
    // S2 wire (v2.2.19): bootstrapEstimate — wired but inert when
    // l1_compression_enabled=false (default since v2.2.19 safe-l1 kill-switch).
    // Activates with v2.2.20 L1 revival per heading-list audit. When active,
    // uses rolling-median from historical actuals; falls back to bytes/4
    // when < 3 samples (W9: inBytes passed so cold-cache avoids STATIC_FALLBACK=500).
    const inTokEst   = bootstrapEstimate(agentType, { cwd, config: cfg, inBytes });
    const outTokEst  = Math.round(outBytes / 4);
    const ttlHours   = (cfg.compression && typeof cfg.compression.pending_journal_ttl_hours === 'number')
      ? cfg.compression.pending_journal_ttl_hours : 24;

    // Journal sweep before write
    const pendingPath = path.join(stateDir, 'tokenwright-pending.jsonl');
    const { kept, truncationEvent } = readAndSweepJournal(pendingPath, cfg);

    if (truncationEvent) {
      emitTokenwrightJournalTruncated(Object.assign({ orchestration_id: orchId }, truncationEvent));
    }

    // Append new pending entry
    const newEntry = {
      spawn_key:           spawnKey(agentType, prompt),
      orchestration_id:    orchId,
      task_id:             null,
      agent_type:          agentType,
      technique_tag:       tag,
      input_token_estimate: inTokEst,
      timestamp:           new Date().toISOString(),
      expires_at:          Date.now() + (ttlHours * 3600 * 1000),
    };
    writeJournal(pendingPath, [...kept, newEntry]);

    emitPromptCompression({
      orchestration_id:            orchId,
      task_id:                     null,
      agent_type:                  agentType,
      input_bytes:                 inBytes,
      output_bytes:                outBytes,
      ratio,
      technique_tag:               tag,
      input_token_estimate:        inTokEst,
      output_token_estimate:       outTokEst,
      dropped_sections:            droppedSections,
      layer1_dedup_blocks_dropped: droppedCount,
      sections_total:              sectionsTotal,
      sections_dedup_eligible:     sectionsDedupEligible,
      sections_score_eligible:     sectionsScoreEligible,
      sections_preserve:           sectionsPreserve,
      eligibility_rate:            eligibilityRate,
      dedup_drop_by_heading:       dedupDropByHeading,
      compression_skipped_path:    compressionSkippedPath,
      tokenwright_version:         '2.2.6-l1',
    });

    emitPassthrough(Object.assign({}, toolInput, { prompt: finalPrompt }));
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
