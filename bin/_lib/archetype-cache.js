'use strict';

/**
 * archetype-cache.js — Core ArchetypeCache implementation for v2.1.8
 *
 * Advisory-active mode: cached archetypes are served to the PM as non-binding
 * hints when confidence >= 0.85 AND prior_applications_count >= 3.
 *
 * Six guardrails enforced at lookup time:
 *   1. min_prior_applications (default 3)
 *   2. confidence_floor (default 0.85)
 *   3. (signature quality — enforced via computeSignature determinism)
 *   4. per-archetype blacklist
 *   5. global kill switch (enabled: false)
 *   6. observability via getDashboardStats()
 *
 * State files:
 *   .orchestray/state/archetype-cache.jsonl   — application records (LRU + TTL source)
 *   .orchestray/audit/events.jsonl            — advisory_served events (via atomicAppendJsonl)
 *
 * Fail-open: every exported function wraps its body in try/catch and returns
 * a safe fallback on any error. Callers never need their own try/catch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { writeEvent } = require('./audit-event-writer');
const { resolveSafeCwd } = require('./resolve-project-cwd');
const { recordDegradation } = require('./degraded-journal');

// ─── Config helpers ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled: true,
  min_prior_applications: 3,
  confidence_floor: 0.85,
  max_entries: 30,
  ttl_days: 30,
  blacklist: [],
};

/**
 * Load archetype_cache config from .orchestray/config.json.
 * Falls back to DEFAULT_CONFIG on any parse error.
 *
 * @param {string} cwd - Project root
 * @returns {object} Merged config
 */
function loadConfig(cwd) {
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const ccv = parsed && parsed.context_compression_v218;
    if (!ccv || ccv.enabled === false) {
      return Object.assign({}, DEFAULT_CONFIG, { enabled: false });
    }
    const ac = ccv.archetype_cache;
    if (!ac) return DEFAULT_CONFIG;
    return {
      enabled: ac.enabled !== false,
      min_prior_applications: Number.isFinite(ac.min_prior_applications)
        ? ac.min_prior_applications : DEFAULT_CONFIG.min_prior_applications,
      confidence_floor: Number.isFinite(ac.confidence_floor)
        ? ac.confidence_floor : DEFAULT_CONFIG.confidence_floor,
      max_entries: Number.isFinite(ac.max_entries)
        ? ac.max_entries : DEFAULT_CONFIG.max_entries,
      ttl_days: Number.isFinite(ac.ttl_days)
        ? ac.ttl_days : DEFAULT_CONFIG.ttl_days,
      blacklist: Array.isArray(ac.blacklist) ? ac.blacklist : [],
    };
  } catch (_e) {
    return DEFAULT_CONFIG;
  }
}

// ─── Signature computation ────────────────────────────────────────────────────

/**
 * English stop-words removed during top-5 keyword extraction.
 * Kept minimal to avoid over-filtering domain terms.
 */
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','it','its','be','by','as','are','was','were','has','have','had',
  'do','does','did','will','would','could','should','may','might','can',
  'this','that','these','those','i','we','you','they','he','she','my','our',
  'your','their','his','her','from','into','not','no','so','if','then','than',
  'up','out','about','after','before','all','also','any','both','each','more',
  'some','such','via','per','just','new','add','run','use','get','set','let',
  'now','how','what','when','where','which','who','why','how',
]);

/**
 * Map file count to a bucket label.
 * @param {number} count
 * @returns {string} XS|S|M|L|XL
 */
function fileCountBucket(count) {
  if (count <= 1) return 'XS';
  if (count <= 4) return 'S';
  if (count <= 12) return 'M';
  if (count <= 40) return 'L';
  return 'XL';
}

/**
 * Extract top-5 content words from a task description string.
 * Stop-words removed, alphabetically sorted for determinism.
 *
 * @param {string} taskDesc
 * @returns {string} Comma-joined sorted list of up to 5 keywords
 */
function extractKeywordCluster(taskDesc) {
  try {
    const words = String(taskDesc || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

    // Frequency count
    const freq = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
    }

    const top5 = Object.entries(freq)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([w]) => w)
      .sort(); // alphabetical for determinism

    return top5.join(',');
  } catch (_e) {
    return '';
  }
}

/**
 * Compute a 12-hex-char stable signature from the four required components.
 *
 * Components:
 *   1. agentSet    — sorted, comma-joined agent type list
 *   2. fileBucket  — XS/S/M/L/XL from file count
 *   3. keywords    — top-5 alphabetically sorted content words
 *   4. scoreBucket — complexity score rounded to nearest integer
 *
 * @param {object} task
 * @param {string[]} [task.agentSet]      - Agent types expected (will be sorted)
 * @param {number}  [task.fileCount]      - Number of files in pre-decomp scan
 * @param {string}  [task.description]    - User task description text
 * @param {number}  [task.complexityScore]- PM Section 12 complexity score
 * @returns {string} 12-hex-char signature, or '' on error
 */
function computeSignature(task) {
  try {
    const agentSet = Array.isArray(task.agentSet)
      ? [...task.agentSet].sort().join(',')
      : '';
    const fileBucket = fileCountBucket(Number.isFinite(task.fileCount) ? task.fileCount : 0);
    const keywords = extractKeywordCluster(task.description || '');
    const scoreBucket = Number.isFinite(task.complexityScore)
      ? String(Math.round(task.complexityScore))
      : '0';

    const raw = [agentSet, fileBucket, keywords, scoreBucket].join('||');
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  } catch (_e) {
    return '';
  }
}

/**
 * Expose the four components for debugging/dashboard use.
 *
 * @param {object} task - Same shape as computeSignature parameter
 * @returns {object} { agentSet, fileBucket, keywords, scoreBucket, signature }
 */
function describeSignature(task) {
  try {
    const agentSet = Array.isArray(task.agentSet)
      ? [...task.agentSet].sort().join(',')
      : '';
    const fileBucket = fileCountBucket(Number.isFinite(task.fileCount) ? task.fileCount : 0);
    const keywords = extractKeywordCluster(task.description || '');
    const scoreBucket = Number.isFinite(task.complexityScore)
      ? String(Math.round(task.complexityScore))
      : '0';
    const signature = computeSignature(task);
    return { agentSet, fileBucket, keywords, scoreBucket, signature };
  } catch (_e) {
    return { agentSet: '', fileBucket: 'XS', keywords: '', scoreBucket: '0', signature: '' };
  }
}

// ─── Weighted-Jaccard similarity ──────────────────────────────────────────────

const COMPONENT_WEIGHTS = { agents: 0.4, files: 0.2, keywords: 0.2, score: 0.2 };

/**
 * Compute weighted-Jaccard confidence between a candidate record and a query task.
 *
 * Each of the four components is scored 0 or 1 (exact match per component),
 * then weighted. Score-bucket allows ±1 tolerance per spec guardrail 3.
 *
 * @param {object} record   - Stored application record (has agentSet, fileBucket, keywords, scoreBucket)
 * @param {object} querySig - Result of describeSignature() for the query task
 * @returns {number} 0.0–1.0
 */
function computeConfidence(record, querySig) {
  try {
    // Agent set: exact match after normalising
    const recAgents = String(record.agentSet || '');
    const qAgents   = String(querySig.agentSet || '');
    const agentScore = recAgents === qAgents ? 1.0 : 0.0;

    // File bucket: exact match
    const fileBucketScore = record.fileBucket === querySig.fileBucket ? 1.0 : 0.0;

    // Keywords: Jaccard over the two sets
    const recKw = new Set(String(record.keywords || '').split(',').filter(Boolean));
    const qKw   = new Set(String(querySig.keywords || '').split(',').filter(Boolean));
    let kwScore = 0.0;
    if (recKw.size === 0 && qKw.size === 0) {
      kwScore = 1.0;
    } else {
      let intersection = 0;
      for (const w of recKw) { if (qKw.has(w)) intersection++; }
      const union = recKw.size + qKw.size - intersection;
      kwScore = union > 0 ? intersection / union : 0.0;
    }

    // Score bucket: match within ±1
    const recScore = parseInt(record.scoreBucket || '0', 10);
    const qScore   = parseInt(querySig.scoreBucket || '0', 10);
    const scoreScore = Math.abs(recScore - qScore) <= 1 ? 1.0 : 0.0;

    return (
      COMPONENT_WEIGHTS.agents   * agentScore +
      COMPONENT_WEIGHTS.files    * fileBucketScore +
      COMPONENT_WEIGHTS.keywords * kwScore +
      COMPONENT_WEIGHTS.score    * scoreScore
    );
  } catch (_e) {
    return 0.0;
  }
}

// ─── State file helpers ───────────────────────────────────────────────────────

/**
 * @param {string} cwd
 * @returns {string} Absolute path to archetype-cache.jsonl
 */
function getCacheFilePath(cwd) {
  return path.join(cwd, '.orchestray', 'state', 'archetype-cache.jsonl');
}

/**
 * Read all non-expired application records from archetype-cache.jsonl.
 * Fails open: returns [] on any error.
 *
 * @param {string} cwd
 * @param {number} ttlDays
 * @returns {object[]} Array of record objects
 */
function readRecords(cwd, ttlDays) {
  try {
    const filePath = getCacheFilePath(cwd);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    const records = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        // TTL filter
        if (rec.last_used_ts && rec.last_used_ts < cutoff) continue;
        records.push(rec);
      } catch (_e) { /* skip corrupt lines */ }
    }
    return records;
  } catch (_e) {
    return [];
  }
}

/**
 * Rewrite archetype-cache.jsonl with only the supplied records.
 * Enforces max_entries via LRU eviction (remove oldest last_used_ts).
 * Fails open on write error.
 *
 * @param {string}   cwd
 * @param {object[]} records
 * @param {number}   maxEntries
 */
function writeRecords(cwd, records, maxEntries) {
  try {
    // LRU eviction: keep only maxEntries most recently used
    let toWrite = records;
    if (toWrite.length > maxEntries) {
      toWrite = [...records]
        .sort((a, b) => (b.last_used_ts || 0) - (a.last_used_ts || 0))
        .slice(0, maxEntries);
    }
    const dir = path.join(cwd, '.orchestray', 'state');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = getCacheFilePath(cwd);
    fs.writeFileSync(filePath, toWrite.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a successful or failed application of an archetype.
 * Creates or updates a record in archetype-cache.jsonl.
 * Enforces LRU eviction and TTL-based filtering.
 *
 * @param {string} archetypeId   - 12-hex signature string
 * @param {string} orchId        - Orchestration ID
 * @param {string} outcome       - 'success' | 'overridden' | 'failure'
 * @param {object} [sigDetails]  - Optional: { agentSet, fileBucket, keywords, scoreBucket }
 * @param {object} [eventCwd]    - Optional cwd override (for testing)
 */
function recordApplication(archetypeId, orchId, outcome, sigDetails, eventCwd) {
  try {
    const cwd = eventCwd || resolveSafeCwd(null);
    const cfg = loadConfig(cwd);
    // Guardrail 5: global kill switch
    if (!cfg.enabled) return;

    const records = readRecords(cwd, cfg.ttl_days);
    const existing = records.find(r => r.archetype_id === archetypeId);
    const now = Date.now();

    if (existing) {
      existing.last_used_ts = now;
      existing.last_orch_id = orchId;
      if (outcome === 'success') {
        existing.prior_applications_count = (existing.prior_applications_count || 0) + 1;
      } else if (outcome === 'failure') {
        existing.failed_uses = (existing.failed_uses || 0) + 1;
      }
      // override doesn't increment success but still updates last_used_ts
      existing.last_outcome = outcome;
    } else {
      const newRecord = {
        archetype_id: archetypeId,
        prior_applications_count: outcome === 'success' ? 1 : 0,
        failed_uses: outcome === 'failure' ? 1 : 0,
        last_outcome: outcome,
        last_used_ts: now,
        last_orch_id: orchId,
        created_ts: now,
      };
      if (sigDetails) {
        Object.assign(newRecord, {
          agentSet:    sigDetails.agentSet    || '',
          fileBucket:  sigDetails.fileBucket  || 'XS',
          keywords:    sigDetails.keywords    || '',
          scoreBucket: sigDetails.scoreBucket || '0',
        });
      }
      records.push(newRecord);
    }

    writeRecords(cwd, records, cfg.max_entries);
  } catch (_e) { /* fail-open */ }
}

/**
 * Find the best-matching archetype for a given task signature.
 * Enforces guardrails 1, 2, 4, 5 before returning a result.
 *
 * @param {string} taskSignature   - 12-hex signature from computeSignature()
 * @param {object} querySigDetails - From describeSignature(), for confidence scoring
 * @param {object} [configOverride]- Optional config override (for testing)
 * @param {string} [cwdOverride]   - Optional cwd override (for testing)
 * @returns {{ archetypeId: string, confidence: number, prior_applications_count: number } | null}
 */
function findMatch(taskSignature, querySigDetails, configOverride, cwdOverride) {
  try {
    const cwd = cwdOverride || resolveSafeCwd(null);
    const cfg = configOverride || loadConfig(cwd);

    // Guardrail 5: global kill switch
    if (!cfg.enabled) return null;

    const records = readRecords(cwd, cfg.ttl_days);
    if (records.length === 0) return null;

    let bestMatch = null;
    let bestConfidence = -1;

    for (const rec of records) {
      // Guardrail 1: min_prior_applications
      if ((rec.prior_applications_count || 0) < cfg.min_prior_applications) continue;

      // Guardrail 4: blacklist
      if (cfg.blacklist.includes(rec.archetype_id)) continue;

      const confidence = computeConfidence(rec, querySigDetails || {});

      // Guardrail 2: confidence_floor
      if (confidence < cfg.confidence_floor) continue;

      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = rec;
      }
    }

    if (!bestMatch) return null;

    return {
      archetypeId: bestMatch.archetype_id,
      confidence: bestConfidence,
      prior_applications_count: bestMatch.prior_applications_count,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * Emit an archetype_cache_advisory_served event to events.jsonl.
 * Also records a degraded entry when blacklisted (archetype_cache_blacklisted).
 *
 * @param {string} archetypeId
 * @param {string} orchId
 * @param {string} pmDecision  - 'accepted' | 'adapted' | 'overridden'
 * @param {string} [pmReasoningBrief] - ≤280 chars
 * @param {number} [confidence]
 * @param {number} [priorCount]
 * @param {string} [taskShapeHash]
 * @param {string} [cwdOverride]
 */
function recordAdvisoryServed(
  archetypeId, orchId, pmDecision, pmReasoningBrief,
  confidence, priorCount, taskShapeHash, cwdOverride
) {
  try {
    const cwd = cwdOverride || resolveSafeCwd(null);
    const eventsDir  = path.join(cwd, '.orchestray', 'audit');
    if (!fs.existsSync(eventsDir)) {
      try { fs.mkdirSync(eventsDir, { recursive: true }); } catch (_e) {}
    }

    const event = {
      timestamp: new Date().toISOString(),
      type: 'archetype_cache_advisory_served',
      orchestration_id: orchId || null,
      archetype_id: archetypeId,
      confidence: confidence != null ? confidence : null,
      task_shape_hash: taskShapeHash || archetypeId,
      prior_applications_count: priorCount != null ? priorCount : null,
      pm_decision: pmDecision,
      pm_reasoning_brief: pmReasoningBrief
        ? String(pmReasoningBrief).slice(0, 280)
        : null,
    };

    try {
      writeEvent(event, { cwd });
    } catch (writeErr) {
      // Advisory hint write failed — record degraded entry so the failure is observable.
      // Wrapped in its own try/catch so a recordDegradation failure cannot throw here.
      try {
        recordDegradation({
          kind: 'archetype_cache_hint_write_failed',
          severity: 'warn',
          projectRoot: cwdOverride || resolveSafeCwd(null),
          detail: {
            message: writeErr.message,
            dedup_key: 'achw-' + (orchId || 'unknown'),
          },
        });
      } catch (_de) { /* fail-open */ }
    }
  } catch (_e) { /* fail-open */ }
}

/**
 * Emit an archetype_cache_blacklisted degraded event.
 * Called when a match is found but the archetype_id is in the blacklist.
 *
 * @param {string} archetypeId
 * @param {string} [cwdOverride]
 */
function recordBlacklisted(archetypeId, cwdOverride) {
  try {
    const cwd = cwdOverride || resolveSafeCwd(null);
    // Route through recordDegradation so dedup guard and schema envelope fields
    // (schema, pid, orchestration_id) are applied consistently.
    recordDegradation({
      kind: 'archetype_cache_blacklisted',
      severity: 'info',
      projectRoot: cwd,
      detail: {
        archetype_id: archetypeId,
        dedup_key: 'acb-' + archetypeId,
      },
    });
  } catch (_e) { /* fail-open */ }
}

/**
 * Aggregate dashboard statistics from archetype-cache.jsonl and events.jsonl.
 * Used by /orchestray:patterns to display the "Archetype cache (advisory)" section.
 *
 * @param {string} [cwdOverride]
 * @returns {{
 *   advisories_served: number,
 *   decompositions_attempted: number,
 *   accepted: number,
 *   adapted: number,
 *   overridden: number,
 *   hit_rate_pct: string,
 *   override_rate_pct: string,
 *   adaptation_rate_pct: string,
 *   top5_archetypes: Array<{archetype_id: string, prior_applications_count: number}>
 * }}
 */
function getDashboardStats(cwdOverride) {
  const empty = {
    advisories_served: 0,
    decompositions_attempted: 0,
    accepted: 0,
    adapted: 0,
    overridden: 0,
    hit_rate_pct: '0.0',
    override_rate_pct: '0.0',
    adaptation_rate_pct: '0.0',
    top5_archetypes: [],
  };

  try {
    const cwd = cwdOverride || resolveSafeCwd(null);
    const cfg = loadConfig(cwd);
    if (!cfg.enabled) return empty;

    // Count advisory_served events from events.jsonl
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    let advisoriesServed = 0;
    let accepted = 0;
    let adapted = 0;
    let overridden = 0;

    // Count orchestration_start events as a proxy for decompositions attempted
    let decompositionsAttempted = 0;

    if (fs.existsSync(eventsPath)) {
      try {
        const raw = fs.readFileSync(eventsPath, 'utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed);
            const t = ev.type || ev.event;
            if (t === 'archetype_cache_advisory_served') {
              advisoriesServed++;
              if (ev.pm_decision === 'accepted') accepted++;
              else if (ev.pm_decision === 'adapted') adapted++;
              else if (ev.pm_decision === 'overridden') overridden++;
            } else if (t === 'orchestration_start') {
              decompositionsAttempted++;
            }
          } catch (_e) { /* skip */ }
        }
      } catch (_e) { /* fail-open */ }
    }

    // Also scan history dirs for events
    const historyGlob = path.join(cwd, '.orchestray', 'history');
    if (fs.existsSync(historyGlob)) {
      try {
        const orchDirs = fs.readdirSync(historyGlob, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const dir of orchDirs) {
          const evFile = path.join(historyGlob, dir, 'events.jsonl');
          if (!fs.existsSync(evFile)) continue;
          try {
            const raw = fs.readFileSync(evFile, 'utf8');
            for (const line of raw.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const ev = JSON.parse(trimmed);
                const t = ev.type || ev.event;
                if (t === 'archetype_cache_advisory_served') {
                  advisoriesServed++;
                  if (ev.pm_decision === 'accepted') accepted++;
                  else if (ev.pm_decision === 'adapted') adapted++;
                  else if (ev.pm_decision === 'overridden') overridden++;
                } else if (t === 'orchestration_start') {
                  decompositionsAttempted++;
                }
              } catch (_e) { /* skip */ }
            }
          } catch (_e) { /* skip */ }
        }
      } catch (_e) { /* fail-open */ }
    }

    // Top-5 archetypes by prior_applications_count from state file
    const records = readRecords(cwd, cfg.ttl_days);
    const top5 = [...records]
      .sort((a, b) => (b.prior_applications_count || 0) - (a.prior_applications_count || 0))
      .slice(0, 5)
      .map(r => ({ archetype_id: r.archetype_id, prior_applications_count: r.prior_applications_count || 0 }));

    const hitRatePct = decompositionsAttempted > 0
      ? ((advisoriesServed / decompositionsAttempted) * 100).toFixed(1)
      : '0.0';
    const overrideRatePct = advisoriesServed > 0
      ? ((overridden / advisoriesServed) * 100).toFixed(1)
      : '0.0';
    const adaptationRatePct = advisoriesServed > 0
      ? ((adapted / advisoriesServed) * 100).toFixed(1)
      : '0.0';

    return {
      advisories_served: advisoriesServed,
      decompositions_attempted: decompositionsAttempted,
      accepted,
      adapted,
      overridden,
      hit_rate_pct: hitRatePct,
      override_rate_pct: overrideRatePct,
      adaptation_rate_pct: adaptationRatePct,
      top5_archetypes: top5,
    };
  } catch (_e) {
    return empty;
  }
}

module.exports = {
  computeSignature,
  describeSignature,
  recordApplication,
  findMatch,
  recordAdvisoryServed,
  recordBlacklisted,
  getDashboardStats,
  // Exported for testing
  fileCountBucket,
  extractKeywordCluster,
  computeConfidence,
  loadConfig,
};
