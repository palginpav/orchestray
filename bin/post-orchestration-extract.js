#!/usr/bin/env node
'use strict';

/**
 * post-orchestration-extract.js — PreCompact hook: auto-extract pattern proposals.
 *
 * Wired as the LAST entry in the PreCompact chain. After `pre-compact-archive.js`
 * and `record-pattern-skip.js` have run, this script:
 *
 *   1. Checks kill-switch, feature gate, and circuit breaker.
 *   2. Reads `.orchestray/audit/events.jsonl`, scopes to the current orchestration.
 *   3. Runs Layer A quarantine (`quarantineEvents`).
 *   4. Calls the extraction backend (stub in v2.1.6; real subagent wired in Group D / W7).
 *   5. Validates each proposal via Layer B (`validateProposal`) + category allowlist.
 *   6. Writes accepted proposals to `.orchestray/proposed-patterns/<slug>.md`.
 *   7. Emits `auto_extract_staged` audit event.
 *
 * Config plumbing note: `auto_learning.*` config keys are read directly from
 * `.orchestray/config.json` here because W7 will wire them through config-schema.js.
 * Missing keys are treated as `false` / absent (default-off per design §4).
 *
 * Backend stub note: `spawnExtractor` below is a shim. In v2.1.6 it returns
 * `{ proposals: [], skipped: [{ reason: 'backend_not_configured' }] }` unless
 * ORCHESTRAY_AUTO_EXTRACT_BACKEND is set by tests. Group D / W7 replaces the stub
 * with an actual `execFileSync('claude', ['--agent', 'haiku', ...])` call.
 *
 * Fail-open discipline: every error path calls recordDegradation() and exits 0.
 * Never throws to the hook runner.
 *
 * Input:  JSON on stdin (Claude Code PreCompact hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 *
 * v2.1.6 — W3 auto-extraction hook.
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { quarantineEvents }            = require('./_lib/event-quarantine');
const { validateProposal }            = require('./_lib/proposal-validator');
const { checkAndIncrement }           = require('./_lib/learning-circuit-breaker');
const { recordDegradation }           = require('./_lib/degraded-journal');
const { loadAutoLearningConfig }      = require('./_lib/config-schema');
const { EXTRACTION_BREAKER_SCOPE }    = require('./_lib/auto-learning-scopes');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { normalizeEvent }              = require('./read-event');
// v2.1.7 Bundle A: live Haiku backend
const { runExtractor }          = require('./_lib/haiku-extractor-transport');
const { parseExtractorOutput }  = require('./_lib/extractor-output-parser');

// ---------------------------------------------------------------------------
// Category allowlist — auto-extraction may only propose from this subset.
// `anti-pattern` and `user-correction` are reserved for humans / curator (B1 §3).
// Resolve B1's open decision (option b): post-validation allowlist in this file.
// ---------------------------------------------------------------------------
const AUTO_EXTRACT_CATEGORY_ALLOWLIST = new Set([
  'decomposition',
  'routing',
  'specialization',
  'design-preference',
]);

// ---------------------------------------------------------------------------
// B4-02: Size cap for events.jsonl read — guards against OOM on unbounded growth.
// Mirrors the 10 MiB default from atomic-append.js MAX_JSONL_READ_BYTES.
// Tests can lower the cap for the lifetime of a test via _setMaxEventsBytesForTest().
// ---------------------------------------------------------------------------
const AUTO_EXTRACT_MAX_EVENTS_FILE_BYTES = 10 * 1024 * 1024;

/** @type {number|null} */
let _maxEventsByteOverride = null;

/**
 * Override the events-file size cap for testing. Call with null to restore the default.
 * Only intended for use in tests — do not call from production code paths.
 *
 * @param {number|null} n
 */
function _setMaxEventsBytesForTest(n) {
  _maxEventsByteOverride = n;
}

// (W7: DEFAULT_BREAKER_MAX / DEFAULT_BREAKER_WINDOW_MS removed — values now come
//  from loadAutoLearningConfig via config-schema.js: safety.circuit_breaker.*)

// ---------------------------------------------------------------------------
// Audit event helpers
// ---------------------------------------------------------------------------

/**
 * Emit a single audit event to events.jsonl.  Fail-open: never throws.
 *
 * @param {string} eventsPath
 * @param {object} event
 */
function _emitEvent(eventsPath, event) {
  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    atomicAppendJsonl(eventsPath, event);
  } catch (_e) {
    // Fail-open.
  }
}

// ---------------------------------------------------------------------------
// Config reader — W7: config now loaded through loadAutoLearningConfig() from
// config-schema.js. All auto_learning.* reads use the validated shape.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// K7 — Resilience path exclusion filter
//
// The Haiku extractor MUST NOT see the resilience dossier or the compact-signal
// lock. Filter them from quarantined events before passing to the backend.
// ---------------------------------------------------------------------------

/** Paths that must never reach the extractor (K7 from v2.1.7 arbitration). */
const K7_EXCLUDED_PATHS = [
  '.orchestray/state/resilience-dossier.json',
  '.orchestray/state/compact-signal.lock',
];

/**
 * Return true if an event references a K7-excluded path in any of its common
 * path fields. Checked after quarantine (Layer A), as defense-in-depth.
 *
 * SEC-03: uses canonicalised path comparison (path.normalize + path.resolve)
 * rather than bare String.includes to resist traversal variants, Windows-style
 * separators, and case-mangled paths. Paths containing '..' after normalisation
 * are also rejected unconditionally.
 *
 * @param {object} ev
 * @param {string} [projectRoot] - Absolute project root for path.resolve (defaults to cwd).
 * @returns {boolean}
 */
function _isK7Excluded(ev, projectRoot) {
  const root = projectRoot || process.cwd();
  // Pre-compute canonical absolute forms of the K7 exclusion list.
  const excludedCanonical = K7_EXCLUDED_PATHS.map(
    (p) => path.resolve(root, path.normalize(p))
  );

  function _checkCandidate(candidate) {
    if (typeof candidate !== 'string') return false;
    // Reject traversal attempts detected after normalisation.
    const normalised = path.normalize(candidate);
    if (normalised.includes('..')) return false; // traversal attempt — block
    const canonical = path.resolve(root, normalised);
    for (const excl of excludedCanonical) {
      // Match exact path OR any descendant (startsWith + separator guard).
      if (canonical === excl || canonical.startsWith(excl + path.sep)) return true;
    }
    return false;
  }

  for (const field of ['source_path', 'path']) {
    if (_checkCandidate(ev[field])) return true;
  }
  if (ev.detail && typeof ev.detail === 'object') {
    const dp = ev.detail.path || ev.detail.source_path;
    if (_checkCandidate(dp)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extraction backend abstraction — v2.1.7 live Haiku CLI transport
//
// Short-circuit cases (checked in order):
//   1. ORCHESTRAY_AUTO_EXTRACT_BACKEND=test (test injection — existing suite compat)
//   2. ORCHESTRAY_AUTO_EXTRACT_BACKEND=stub (env var stub — regression regression path)
//   3. extractConfig.backend === 'stub' (config — operator opt-out)
//
// In all other cases, the real backend runs via haiku-extractor-transport.js.
// ---------------------------------------------------------------------------

/** @type {Function|null} Test-injected backend (legacy compat for v2.1.6 test suite). */
let _testBackend = null;

/**
 * Set a test-only backend for spawnExtractor. Call with null to reset.
 * Only takes effect when ORCHESTRAY_AUTO_EXTRACT_BACKEND === 'test'.
 * Preserved for backward compatibility with v2.1.6 test suite.
 *
 * @param {Function|null} backend - (prompt, events, meta) => { proposals, skipped }
 */
function setExtractorBackend(backend) {
  _testBackend = backend;
}

/**
 * Invoke the extraction backend, parse its output, and return a flat result.
 *
 * @param {object}   opts
 * @param {object[]} opts.events          - K7-filtered quarantined events
 * @param {object}   opts.extractConfig   - Validated extract_on_complete config block
 * @param {string}   opts.projectRoot     - Project root for degraded-journal writes
 * @returns {{ proposals: object[], skipped: object[], backendElapsedMs: number }}
 */
function spawnExtractor({ events, extractConfig, projectRoot }) {
  const backendEnvOverride = process.env.ORCHESTRAY_AUTO_EXTRACT_BACKEND;

  // Test injection path (ORCHESTRAY_AUTO_EXTRACT_BACKEND=test) — v2.1.6 suite compat.
  // The test backend receives (prompt, events, meta) and returns { proposals, skipped }
  // in the v2.1.6 proposal shape, which goes directly through Layer B.
  if (backendEnvOverride === 'test' && typeof _testBackend === 'function') {
    try {
      const result = _testBackend('', events, {});
      return {
        proposals:        Array.isArray(result.proposals) ? result.proposals : [],
        skipped:          Array.isArray(result.skipped)   ? result.skipped   : [],
        backendElapsedMs: 0,
      };
    } catch (err) {
      return {
        proposals:        [],
        skipped:          [{ reason: 'backend_error', detail: err && err.message ? err.message.slice(0, 80) : 'unknown' }],
        backendElapsedMs: 0,
      };
    }
  }

  // Stub short-circuit: env-var override (test regression path) or config says stub.
  const isStub = backendEnvOverride === 'stub' || extractConfig.backend === 'stub';

  if (isStub) {
    return {
      proposals:        [],
      skipped:          [{ event_batch_id: 'unknown', reason: 'backend_not_configured' }],
      backendElapsedMs: 0,
    };
  }

  // ── Live Haiku CLI backend (A1 transport) ──────────────────────────────────
  // Apply K7 filter before handing to transport.
  const k7Filtered = events.filter(ev => !_isK7Excluded(ev));

  const timeoutMs      = extractConfig.timeout_ms       || 180_000;
  const maxOutputBytes = extractConfig.max_output_bytes  || 65_536;

  const transportResult = runExtractor({
    quarantinedEvents: k7Filtered,
    timeoutMs,
    maxOutputBytes,
  });

  const { stdout, stderr, code, timedOut, oversize, elapsedMs } = transportResult;

  // ── Timeout ────────────────────────────────────────────────────────────────
  if (timedOut) {
    recordDegradation({
      kind: 'auto_extract_backend_timeout',
      severity: 'warn',
      detail: { timeout_ms: timeoutMs, killed_at: elapsedMs },
      projectRoot,
    });
    return {
      proposals:        [],
      skipped:          [{ reason: 'backend_timeout' }],
      backendElapsedMs: elapsedMs,
    };
  }

  // ── Oversize ───────────────────────────────────────────────────────────────
  if (oversize) {
    recordDegradation({
      kind: 'auto_extract_backend_oversize',
      severity: 'warn',
      detail: { bytes_received: maxOutputBytes + 1 },
      projectRoot,
    });
    return {
      proposals:        [],
      skipped:          [{ reason: 'backend_oversize' }],
      backendElapsedMs: elapsedMs,
    };
  }

  // ── Non-zero exit code ─────────────────────────────────────────────────────
  if (code !== null && code !== 0) {
    recordDegradation({
      kind: 'auto_extract_backend_exit_nonzero',
      severity: 'error',
      detail: { exit_code: code, stderr_head: stderr.slice(0, 200) },
      projectRoot,
    });
    return {
      proposals:        [],
      skipped:          [{ reason: 'backend_exit_nonzero', detail: { exit_code: code } }],
      backendElapsedMs: elapsedMs,
    };
  }

  // ── Parse output ───────────────────────────────────────────────────────────
  const { proposals, parseErrors } = parseExtractorOutput(stdout);

  if (parseErrors.length > 0 && proposals.length === 0) {
    // Structural parse failure — all proposals dropped.
    recordDegradation({
      kind: 'auto_extract_parse_failed',
      severity: 'warn',
      detail: {
        first_200_bytes: stdout.slice(0, 200),
        backend:         extractConfig.backend || 'haiku-cli',
      },
      projectRoot,
    });
    return {
      proposals:        [],
      skipped:          [{ reason: 'parse_failed' }],
      backendElapsedMs: elapsedMs,
    };
  }

  return {
    proposals,
    skipped:          [],
    backendElapsedMs: elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Orchestration meta builder
// ---------------------------------------------------------------------------

/**
 * Derive orchestration_meta from quarantined events + current-orchestration.json.
 * Returns ONLY the scalar fields defined in the B1 spec §2.
 * No free-text. All fields are scalar/enum.
 *
 * @param {object[]} keptEvents
 * @param {object} orchData
 * @returns {object}
 */
function _buildOrchestrationMeta(keptEvents, orchData) {
  const orchId = orchData.orchestration_id || 'unknown';

  // duration_ms: from orchestration_start timestamp to now.
  let durationMs = 0;
  const startEvent = keptEvents.find(e => e.type === 'orchestration_start');
  if (startEvent && startEvent.timestamp) {
    durationMs = Date.now() - new Date(startEvent.timestamp).getTime();
    if (durationMs < 0) durationMs = 0;
  }

  // agents_used: group by agent_type from agent_start events.
  const agentMap = new Map();
  for (const ev of keptEvents) {
    if (ev.type === 'agent_start') {
      const type = ev.agent_type || 'unknown';
      if (!agentMap.has(type)) {
        agentMap.set(type, {
          type,
          count: 0,
          model: ev.model_used || null,
          effort: ev.effort || null,
        });
      }
      const entry = agentMap.get(type);
      entry.count += 1;
      if (!entry.model && ev.model_used) entry.model = ev.model_used;
    }
  }
  const agentsUsed = Array.from(agentMap.values());

  // phase_count: count of group_start events.
  const phaseCount = keptEvents.filter(e => e.type === 'group_start').length;

  // retry_count: count of replan_triggered events.
  const retryCount = keptEvents.filter(e => e.type === 'replan_triggered').length;

  return {
    orchestration_id: orchId,
    duration_ms:      durationMs,
    agents_used:      agentsUsed,
    phase_count:      phaseCount,
    retry_count:      retryCount,
  };
}

// ---------------------------------------------------------------------------
// Proposal file writer
// ---------------------------------------------------------------------------

/**
 * Build the frontmatter + body for a proposal file.
 *
 * BLK-01 fix: `approach` and `evidence_orch_id` are written to frontmatter
 * (not the body) so that acceptProposed() can reconstruct the full proposalObj
 * from frontmatter fields and Layer-C re-validation succeeds.
 * JSON.stringify is used for multiline-safe quoting of string values.
 *
 * @param {object} proposal
 * @param {string} orchId
 * @returns {string}
 */
function _buildProposalContent(proposal, orchId) {
  const now = new Date().toISOString();
  // Frontmatter fields — no PROTECTED_FIELDS, no trigger_actions, no deprecated.
  // approach and evidence_orch_id are in frontmatter (Option A) for round-trip
  // consistency with acceptProposed() which reads only frontmatter.
  const fm = [
    '---',
    `name: ${proposal.name}`,
    `category: ${proposal.category}`,
    `tip_type: ${proposal.tip_type || ''}`,
    `confidence: ${proposal.confidence}`,
    `description: ${JSON.stringify(proposal.description)}`,
    `approach: ${JSON.stringify(proposal.approach || '')}`,
    `evidence_orch_id: ${proposal.evidence_orch_id || orchId}`,
    `proposed: true`,
    `proposed_at: ${now}`,
    `proposed_from: ${orchId}`,
    `schema_version: 2`,
    `layer_b_markers: []`,
    '---',
    '',
  ].join('\n');

  // Body is empty — all structured data lives in frontmatter.
  return fm;
}

/**
 * Write a proposal file atomically (tmp + rename).
 *
 * @param {string} filePath
 * @param {string} content
 */
function _writeProposalFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Main extraction logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Run the extraction pipeline for the given project root.
 *
 * Returns early with exit-0 on any pre-flight failure.
 * Emits audit events throughout.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.eventsPath
 * @param {string} opts.orchFilePath
 * @returns {{ proposals_written: number, shadow: boolean }}
 */
function runExtraction({ projectRoot, eventsPath, orchFilePath }) {
  const auditDir  = path.join(projectRoot, '.orchestray', 'audit');
  const auditFile = path.join(auditDir, 'events.jsonl');

  // ── Gate 1: global kill switch (env first, config second) ──────────────────
  // loadAutoLearningConfig checks the env var first and returns global_kill_switch:true
  // if ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1. We still emit a distinct event for
  // the env-var case to preserve observability.
  const alConfig = loadAutoLearningConfig(projectRoot);

  if (process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH === '1') {
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'auto_extract_skipped',
      schema_version: 1,
      reason: 'kill_switch_env',
    });
    return { proposals_written: 0, shadow: false };
  }

  if (alConfig.global_kill_switch === true) {
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'auto_extract_skipped',
      schema_version: 1,
      reason: 'kill_switch_config',
    });
    return { proposals_written: 0, shadow: false };
  }

  // ── Gate 2: feature gate (extract_on_complete.enabled — default-off) ───────
  const extractConfig = alConfig.extract_on_complete;
  if (!extractConfig || extractConfig.enabled !== true) {
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'auto_extract_skipped',
      schema_version: 1,
      reason: 'feature_disabled',
    });
    return { proposals_written: 0, shadow: false };
  }

  // W7: config now loaded through config-schema.js loader. All values are validated
  // and clamped. CHG-01 shadow alias removed — canonical shadow_mode only.
  const shadowMode = extractConfig.shadow_mode === true;
  // Circuit breaker parameters come from safety.circuit_breaker (design §4).
  // max_extractions_per_24h is the rolling 24h cap; DEFAULT_WINDOW_MS in the
  // circuit breaker is already 24h. cooldown_minutes_on_trip is handled by the
  // breaker's internal sentinel/trip logic.
  const breakerMax   = alConfig.safety.circuit_breaker.max_extractions_per_24h;
  const breakerWinMs = 24 * 60 * 60 * 1000; // 24h rolling window (matches DEFAULT_WINDOW_MS)
  // Per-orchestration cap is validated and clamped by the loader.
  const perOrchCap = extractConfig.proposals_per_orchestration;

  // ── Gate 3: circuit breaker ────────────────────────────────────────────────
  const breakerResult = checkAndIncrement({
    scope:    EXTRACTION_BREAKER_SCOPE,
    max:      breakerMax,
    windowMs: breakerWinMs,
    cwd:      projectRoot,
  });
  if (!breakerResult.allowed) {
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'auto_extract_skipped',
      schema_version: 1,
      reason: 'circuit_breaker_tripped',
    });
    return { proposals_written: 0, shadow: false };
  }

  // ── Gate 4: events file existence + size cap ──────────────────────────────
  // B4-02: guard against OOM on unbounded events.jsonl growth.
  // Cap defaults to AUTO_EXTRACT_MAX_EVENTS_FILE_BYTES (10 MiB); tests can
  // lower it temporarily via _setMaxEventsBytesForTest().
  const effectiveMaxBytes = _maxEventsByteOverride !== null
    ? _maxEventsByteOverride
    : AUTO_EXTRACT_MAX_EVENTS_FILE_BYTES;
  try {
    const stat = fs.statSync(eventsPath);
    if (stat.size > effectiveMaxBytes) {
      _emitEvent(auditFile, {
        timestamp: new Date().toISOString(),
        type: 'auto_extract_skipped',
        schema_version: 1,
        reason: 'events_file_too_large',
        size_bytes: stat.size,
        max_bytes: effectiveMaxBytes,
      });
      return { proposals_written: 0, shadow: false };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { proposals_written: 0, shadow: false }; // silent no-op
    }
    throw err; // unexpected — let outer try/catch handle
  }

  let eventsRaw;
  try {
    eventsRaw = fs.readFileSync(eventsPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { proposals_written: 0, shadow: false }; // silent no-op
    }
    throw err; // unexpected — let outer try/catch handle
  }
  if (!eventsRaw || !eventsRaw.trim()) {
    return { proposals_written: 0, shadow: false }; // silent no-op
  }

  // ── Step 1: Parse JSONL ────────────────────────────────────────────────────
  const allLines = eventsRaw.split('\n');
  const allEvents = [];
  for (const line of allLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // R-EVENT-NAMING (v2.1.13): legacy `event`/`ts` → canonical `type`/`timestamp`.
      allEvents.push(normalizeEvent(JSON.parse(trimmed)));
    } catch (_e) {
      _emitEvent(auditFile, {
        timestamp: new Date().toISOString(),
        type: 'pattern_extraction_skipped',
        schema_version: 1,
        reason: 'malformed_jsonl_line',
      });
      // continue — process remaining lines
    }
  }

  // ── Step 2: Scope to current orchestration ─────────────────────────────────
  let orchData;
  try {
    orchData = JSON.parse(fs.readFileSync(orchFilePath, 'utf8'));
  } catch (_e) {
    // current-orchestration.json missing — not inside a completed orch; exit silently.
    return { proposals_written: 0, shadow: false };
  }
  const orchId = orchData && orchData.orchestration_id;
  if (!orchId) {
    return { proposals_written: 0, shadow: false };
  }

  // Keep only events matching this orchestration_id (or events without orch_id = PM-level).
  const scopedEvents = allEvents.filter(ev =>
    !ev.orchestration_id || ev.orchestration_id === orchId
  );

  // ── Step 3: Quarantine ─────────────────────────────────────────────────────
  const { kept, skipped: quarantineSkipped } = quarantineEvents(scopedEvents, {
    cwd: projectRoot,
    orchestrationId: orchId,
  });

  // Emit one event per distinct quarantine skip reason.
  const reasonCounts = new Map();
  for (const s of quarantineSkipped) {
    const r = s.reason || 'unknown';
    reasonCounts.set(r, (reasonCounts.get(r) || 0) + (s.count || 1));
  }
  for (const [reason, count] of reasonCounts) {
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'auto_extract_quarantine_skipped',
      schema_version: 1,
      orchestration_id: orchId,
      reason,
      count,
    });
  }

  // ── Step 4: Build orchestration_meta ──────────────────────────────────────
  const orchMeta = _buildOrchestrationMeta(kept, orchData);

  // ── Step 5: Bound check ────────────────────────────────────────────────────
  if (kept.length > 500) {
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'auto_extract_skipped',
      schema_version: 1,
      orchestration_id: orchId,
      reason: 'input_too_large',
      kept_count: kept.length,
    });
    return { proposals_written: 0, shadow: shadowMode };
  }

  // ── Step 6: Spawn extractor backend ───────────────────────────────────────
  // v2.1.7 Bundle A: live Haiku CLI transport. Stub path preserved via
  // ORCHESTRAY_AUTO_EXTRACT_BACKEND=stub env var or extractConfig.backend === 'stub'.
  let extractorResult;
  try {
    extractorResult = spawnExtractor({
      events:        kept,
      extractConfig,
      projectRoot,
    });
  } catch (err) {
    recordDegradation({
      kind: 'config_load_failed',
      severity: 'warn',
      detail: { reason: 'extractor_threw', error: err && err.message ? err.message.slice(0, 80) : 'unknown' },
      projectRoot,
    });
    extractorResult = { proposals: [], skipped: [], backendElapsedMs: 0 };
  }

  const proposals = Array.isArray(extractorResult.proposals) ? extractorResult.proposals : [];
  const backendElapsedMs = extractorResult.backendElapsedMs || 0;

  // ── Step 7: Validate each proposal ─────────────────────────────────────────
  const proposedPatternsDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
  const activePatternsDir   = path.join(projectRoot, '.orchestray', 'patterns');

  let writtenCount = 0;
  for (const proposal of proposals) {
    // Layer B — schema validation
    const valResult = validateProposal(proposal, { strict: true });
    if (!valResult.ok) {
      // F-07: only emit field names, never values
      const fields = (valResult.errors || []).map(e => e.field).join(',');
      _emitEvent(auditFile, {
        timestamp: new Date().toISOString(),
        type: 'pattern_extraction_skipped',
        schema_version: 1,
        orchestration_id: orchId,
        reason: 'validator_rejected',
        detail: fields,
      });
      continue;
    }

    // Category allowlist (option b — restricted to auto-extraction categories)
    if (!AUTO_EXTRACT_CATEGORY_ALLOWLIST.has(proposal.category)) {
      _emitEvent(auditFile, {
        timestamp: new Date().toISOString(),
        type: 'pattern_extraction_skipped',
        schema_version: 1,
        orchestration_id: orchId,
        reason: 'category_restricted_to_auto',
      });
      continue;
    }

    const slug = proposal.name;

    // Slug collision check: proposed-patterns/ and active patterns/
    const proposedPath = path.join(proposedPatternsDir, slug + '.md');
    const activePath   = path.join(activePatternsDir,   slug + '.md');
    const proposedExists = fs.existsSync(proposedPath);
    const activeExists   = fs.existsSync(activePath);
    if (proposedExists || activeExists) {
      _emitEvent(auditFile, {
        timestamp: new Date().toISOString(),
        type: 'pattern_extraction_skipped',
        schema_version: 1,
        orchestration_id: orchId,
        reason: 'slug_collision',
        slug,
      });
      continue;
    }

    // CHG-02 fix: enforce per-orchestration proposal cap (design §4).
    if (writtenCount >= perOrchCap) {
      _emitEvent(auditFile, {
        timestamp: new Date().toISOString(),
        type: 'pattern_extraction_skipped',
        schema_version: 1,
        orchestration_id: orchId,
        reason: 'per_orchestration_cap',
      });
      continue;
    }

    // Write proposal file (skip in shadow mode)
    if (!shadowMode) {
      const content = _buildProposalContent(proposal, orchId);
      _writeProposalFile(proposedPath, content);
    }

    // Emit pattern_proposed event
    _emitEvent(auditFile, {
      timestamp: new Date().toISOString(),
      type: 'pattern_proposed',
      schema_version: 1,
      orchestration_id: orchId,
      slug,
      shadow: shadowMode,
    });

    writtenCount += 1;
  }

  // ── Step 9: Emit auto_extract_staged (UX-01 signal for PM §22f / W7) ───────
  // v2.1.7: backend_elapsed_ms field added (event-schemas.md §auto-extract-staged).
  _emitEvent(auditFile, {
    timestamp: new Date().toISOString(),
    type: 'auto_extract_staged',
    schema_version: 1,
    orchestration_id: orchId,
    proposal_count: writtenCount,
    shadow: shadowMode,
    backend_elapsed_ms: backendElapsedMs,
  });

  return { proposals_written: writtenCount, shadow: shadowMode };
}

// ---------------------------------------------------------------------------
// Hook entrypoint (stdin → stdout)
// ---------------------------------------------------------------------------

// Export pipeline internals for tests.
module.exports = {
  runExtraction,
  spawnExtractor,
  setExtractorBackend,    // v2.1.6 compat — existing test suite uses this
  _isK7Excluded,
  _buildOrchestrationMeta,
  _buildProposalContent,
  AUTO_EXTRACT_CATEGORY_ALLOWLIST,
  AUTO_EXTRACT_MAX_EVENTS_FILE_BYTES,
  _setMaxEventsBytesForTest,
};

// Only run as a hook script when executed directly (not when require()'d in tests).
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] post-orchestration-extract: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      let event;
      try {
        event = JSON.parse(input);
      } catch (_e) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const projectRoot = process.env.ORCHESTRAY_PROJECT_ROOT || resolveSafeCwd(event && event.cwd);
      const eventsPath  = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
      const orchFile    = getCurrentOrchestrationFile(projectRoot);

      runExtraction({ projectRoot, eventsPath, orchFilePath: orchFile });
    } catch (err) {
      // Top-level fail-open — never block PreCompact.
      try {
        recordDegradation({
          kind: 'config_load_failed',
          severity: 'warn',
          detail: {
            reason: 'post_orchestration_extract_uncaught',
            error: err && err.message ? err.message.slice(0, 80) : 'unknown',
          },
        });
      } catch (_e) {
        // Absolute last resort.
      }
    }
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}
