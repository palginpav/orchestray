#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * pattern-roi-aggregate.js — Pattern-ROI aggregator and calibration-suggestion writer.
 *
 * Pillar B of Orchestray v2.1.6 self-improving foundations.
 *
 * This script is READ-ONLY with respect to:
 *   - .orchestray/patterns/*.md     (never written)
 *   - .orchestray/config.json       (never written)
 *   - ~/.orchestray/shared/         (never written)
 *
 * It writes TWO artefacts:
 *   - .orchestray/patterns/roi-snapshot.json          (machine-readable)
 *   - .orchestray/kb/artifacts/calibration-suggestion-{YYYYMMDD-HHMMZ}.md  (human-readable, UTC timestamp)
 *
 * ROI formula
 * -----------
 *   roi_score = (-delta_cost_norm) * 0.5 + app_rate * 0.3 + decayed_confidence * 0.2
 *
 *   delta_cost_norm = tanh(delta_cost / COST_NORM_SCALE)   clamped to [-1, 1]
 *     where COST_NORM_SCALE = 1.0 USD (reasonable per-orchestration baseline).
 *     Negative delta_cost (pattern saves money) → positive contribution.
 *
 *   Rationale:
 *     - Cost delta (50% weight): primary signal — patterns that correlate with
 *       cheaper orchestrations are high-ROI. tanh normalization keeps outlier
 *       orchestrations from dominating; COST_NORM_SCALE of $1 reflects typical
 *       orchestration cost range.
 *     - Application rate (30% weight): a pattern that is consistently applied
 *       (rather than skipped) is useful by revealed preference.
 *     - Decayed confidence (20% weight): prior knowledge from the pattern author
 *       still carries weight but is dominated by the observed outcome signals.
 *
 * Throttling
 * ----------
 *   State file: .orchestray/state/roi-last-run.json
 *   Default: skip if last run < 1 day ago.
 *   Override: --force flag.
 *
 *   NOTE: the throttle stamp is written before pattern loading and computation.
 *   This means even a run that produces no output (e.g., no patterns exist yet
 *   on a fresh install) will advance the throttle clock by one day. Use --force
 *   to bypass this when you need to force a run on a fresh project.
 *
 * CLI usage
 * ---------
 *   node bin/pattern-roi-aggregate.js [--window-days=N] [--project-root=PATH] [--dry-run] [--force]
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { parse: parseFrontmatter }    = require('./mcp-server/lib/frontmatter');
const { recordDegradation }          = require('./_lib/degraded-journal');
const { writeEvent }                 = require('./_lib/audit-event-writer');
const { loadAutoLearningConfig }     = require('./_lib/config-schema');
const { normalizeEvent }             = require('./read-event');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COST_NORM_SCALE = 1.0;          // USD — tanh normalization denominator
const DEFAULT_WINDOW_DAYS = 30;
const MIN_DAYS_BETWEEN_RUNS = 1;      // throttle: skip if ran within N days
const SNAPSHOT_SCHEMA_VERSION = 1;

/** Per-file read cap for events.jsonl files (10 MiB). Files larger than this are skipped. */
const MAX_EVENTS_FILE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers — pure
// ---------------------------------------------------------------------------

/**
 * Clamp a number to [min, max].
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * tanh-based normalization for cost delta.
 * Maps any real number to (-1, 1) with unit scale.
 * @param {number} x
 * @param {number} scale
 * @returns {number}
 */
function tanhNorm(x, scale) {
  const s = (scale && scale > 0) ? scale : 1;
  return Math.tanh(x / s);
}

/**
 * Compute decayed_confidence using the same formula as pattern-health.js.
 *   decayed_confidence = confidence × 0.5^(age_days / half_life_days)
 * @param {number} confidence   - raw confidence (0–1)
 * @param {string|null} lastApplied - ISO timestamp or null
 * @param {number} halfLifeDays - default 90
 * @param {Date|number} now
 * @returns {number}
 */
function computeDecayedConfidence(confidence, lastApplied, halfLifeDays, now) {
  const nowMs = (now instanceof Date) ? now.getTime() : Number(now);
  const hl    = (typeof halfLifeDays === 'number' && halfLifeDays > 0) ? halfLifeDays : 90;

  if (!lastApplied) {
    // Never applied: use created_from as a proxy for age if available.
    // Fall back to full-confidence (no aging signal yet).
    return clamp(confidence, 0, 1);
  }

  const age_days = (nowMs - new Date(lastApplied).getTime()) / (1000 * 60 * 60 * 24);
  const decayed  = confidence * Math.pow(0.5, age_days / hl);
  return clamp(decayed, 0, 1);
}

/**
 * Compute the ROI score.
 * @param {number} deltaCost        - avg_cost_applied - avg_cost_baseline (negative = cheaper)
 * @param {number} appRate          - times_applied / (applied + skipped), 0–1
 * @param {number} decayedConf      - decayed confidence, 0–1
 * @returns {number} roi_score ∈ [-0.5, 1.0]
 *   Minimum: (-1)*0.5 + 0*0.3 + 0*0.2 = -0.5 (worst possible: max positive delta, never applied, zero confidence)
 *   Maximum: (1)*0.5 + 1*0.3 + 1*0.2 = 1.0  (best possible: max negative delta, always applied, full confidence)
 */
function computeRoiScore(deltaCost, appRate, decayedConf) {
  const deltaNorm = clamp(tanhNorm(deltaCost, COST_NORM_SCALE), -1, 1);
  return (-deltaNorm) * 0.5 + appRate * 0.3 + decayedConf * 0.2;
}

// ---------------------------------------------------------------------------
// Config reader — minimal, read-only
// ---------------------------------------------------------------------------

/**
 * Read the roi_aggregator config block. Fail-closed (return defaults) on any error.
 * @param {string} projectRoot
 * @returns {{ windowDays: number, minDaysBetweenRuns: number }}
 */
function readConfig(projectRoot) {
  const defaults = { windowDays: DEFAULT_WINDOW_DAYS, minDaysBetweenRuns: MIN_DAYS_BETWEEN_RUNS };
  try {
    const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
    if (!fs.existsSync(cfgPath)) return defaults;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const roi = cfg && cfg.auto_learning && cfg.auto_learning.roi_aggregator;
    if (!roi) return defaults;
    const windowDays = (typeof roi.lookback_days === 'number' && roi.lookback_days > 0)
      ? clamp(roi.lookback_days, 1, 365)
      : defaults.windowDays;
    const minDays = (typeof roi.min_days_between_runs === 'number' && roi.min_days_between_runs > 0)
      ? clamp(roi.min_days_between_runs, 1, 90)
      : defaults.minDaysBetweenRuns;
    return { windowDays, minDaysBetweenRuns: minDays };
  } catch (_e) {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

const ROI_LAST_RUN_FILE = 'roi-last-run.json';

/**
 * Read last-run timestamp from state file.
 * @param {string} projectRoot
 * @returns {Date|null}
 */
function readLastRun(projectRoot) {
  try {
    const p = path.join(projectRoot, '.orchestray', 'state', ROI_LAST_RUN_FILE);
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && data.last_run) return new Date(data.last_run);
  } catch (_e) {}
  return null;
}

/**
 * Write last-run timestamp to state file.
 * @param {string} projectRoot
 * @param {Date} now
 */
function writeLastRun(projectRoot, now) {
  try {
    const stateDir = path.join(projectRoot, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const p = path.join(stateDir, ROI_LAST_RUN_FILE);
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ last_run: now.toISOString() }), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_e) {
    // fail-open: throttle state loss is not critical
  }
}

// ---------------------------------------------------------------------------
// Pattern loader
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PatternMeta
 * @property {string} slug
 * @property {string} category
 * @property {number} confidence
 * @property {number} timesApplied
 * @property {string|null} lastApplied
 * @property {string|null} createdFrom
 * @property {number} halfLifeDays
 * @property {number} decayedConfidence
 * @property {string} filePath
 */

/**
 * Load all non-deprecated, non-proposed patterns from .orchestray/patterns/*.md.
 * Skips malformed files (logs to degraded journal).
 * @param {string} projectRoot
 * @param {Date} now
 * @returns {PatternMeta[]}
 */
function loadPatterns(projectRoot, now) {
  const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
  if (!fs.existsSync(patternsDir)) return null; // signals "no patterns dir"

  let files;
  try {
    files = fs.readdirSync(patternsDir).filter(f => f.endsWith('.md'));
  } catch (_e) {
    return null;
  }

  if (files.length === 0) return []; // dir exists but empty

  const results = [];
  for (const fname of files) {
    const fpath = path.join(patternsDir, fname);
    try {
      const content = fs.readFileSync(fpath, 'utf8');
      const parsed  = parseFrontmatter(content);
      if (!parsed.hasFrontmatter) {
        recordDegradation({
          kind: 'pattern_roi_corrupt_pattern_frontmatter',
          severity: 'warn',
          detail: { reason: 'pattern_no_frontmatter', file: fname },
          projectRoot,
        });
        continue;
      }
      const fm = parsed.frontmatter;
      // Skip deprecated patterns — they don't participate in ROI
      if (fm.deprecated === true) continue;
      // Skip proposed patterns (shouldn't be in patterns/ but guard anyway)
      if (fm.proposed === true) continue;

      const slug        = fm.name || fname.replace(/\.md$/, '');
      const confidence  = (typeof fm.confidence === 'number') ? fm.confidence : 0.5;
      const halfLife    = (typeof fm.decay_half_life_days === 'number' && fm.decay_half_life_days > 0)
        ? fm.decay_half_life_days : 90;
      const lastApplied = fm.last_applied || null;
      const decayed     = computeDecayedConfidence(confidence, lastApplied, halfLife, now);

      results.push({
        slug,
        category:        fm.category || 'unknown',
        confidence,
        timesApplied:    (typeof fm.times_applied === 'number') ? fm.times_applied : 0,
        lastApplied,
        createdFrom:     fm.created_from || null,
        halfLifeDays:    halfLife,
        decayedConfidence: decayed,
        filePath:        fpath,
      });
    } catch (err) {
      recordDegradation({
        kind: 'pattern_roi_corrupt_pattern_frontmatter',
        severity: 'warn',
        detail: { reason: 'pattern_load_failed', file: fname, error: String(err).slice(0, 100) },
        projectRoot,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Event loader
// ---------------------------------------------------------------------------

/**
 * Load all events.jsonl lines from history directories and optionally the current
 * audit/events.jsonl file within the time window.
 *
 * @param {string} projectRoot
 * @param {Date} windowStart  - events before this date are ignored
 * @returns {{ events: Object[], count: number }}  raw parsed event objects in window
 */
function loadEvents(projectRoot, windowStart) {
  const events = [];

  // Collect file paths to read
  const filePaths = [];

  // History: .orchestray/history/**/events.jsonl
  const historyDir = path.join(projectRoot, '.orchestray', 'history');
  if (fs.existsSync(historyDir)) {
    try {
      const dirs = fs.readdirSync(historyDir);
      for (const d of dirs) {
        const evFile = path.join(historyDir, d, 'events.jsonl');
        if (fs.existsSync(evFile)) filePaths.push(evFile);
      }
    } catch (_e) {}
  }

  // Current audit/events.jsonl (optional freshness source)
  const auditEvFile = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
  if (fs.existsSync(auditEvFile)) filePaths.push(auditEvFile);

  if (filePaths.length === 0) return { events, count: 0 };

  const windowStartMs = windowStart.getTime();

  for (const fp of filePaths) {
    // C3-03: Guard against oversized events.jsonl files.
    try {
      const stat = fs.statSync(fp);
      if (stat.size > MAX_EVENTS_FILE_BYTES) {
        recordDegradation({
          kind: 'pattern_roi_events_file_oversize',
          severity: 'warn',
          detail: { file: path.relative(projectRoot, fp), size: stat.size, cap: MAX_EVENTS_FILE_BYTES, dedup_key: 'oversize|' + fp },
          projectRoot,
        });
        continue;
      }
    } catch (_statErr) {
      // stat failed — let readFileSync handle it below.
    }

    try {
      const content = fs.readFileSync(fp, 'utf8');
      const lines   = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          // R-EVENT-NAMING (v2.1.13): legacy `event`/`ts` → canonical `type`/`timestamp`.
          const ev = normalizeEvent(JSON.parse(trimmed));
          if (!ev || typeof ev !== 'object') continue;
          // Filter to window
          const ts = ev.timestamp;
          if (ts && new Date(ts).getTime() < windowStartMs) continue;
          events.push(ev);
        } catch (_parseErr) {
          // Malformed JSONL line — log to degraded journal and continue
          recordDegradation({
            kind: 'pattern_roi_malformed_jsonl_line',
            severity: 'warn',
            detail: { reason: 'roi_malformed_jsonl', file: path.relative(projectRoot, fp) },
            projectRoot,
          });
        }
      }
    } catch (readErr) {
      recordDegradation({
        kind: 'pattern_roi_events_file_read_error',
        severity: 'warn',
        detail: { reason: 'roi_events_read_failed', file: path.relative(projectRoot, fp), error: String(readErr).slice(0, 80) },
        projectRoot,
      });
    }
  }

  return { events, count: filePaths.length };
}

// ---------------------------------------------------------------------------
// ROI computation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structural score loader
// ---------------------------------------------------------------------------

/**
 * Load per-orchestration structural_score averages from agent_metrics.jsonl.
 * Returns a Map of orchestration_id → avg structural_score (or null if missing).
 *
 * Only considers rows with row_type === 'structural_score'. Returns empty Map if
 * the file is absent or cannot be read (field is new; backfilling is not a goal).
 *
 * @param {string} projectRoot
 * @returns {Map<string, number>}
 */
function loadStructuralScores(projectRoot) {
  const result = new Map();
  try {
    const metricsPath = path.join(projectRoot, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    if (!fs.existsSync(metricsPath)) return result;
    const stat = fs.statSync(metricsPath);
    if (stat.size > 10 * 1024 * 1024) return result; // cap at 10 MiB
    const content = fs.readFileSync(metricsPath, 'utf8');
    // orchId → { sum, count }
    const acc = new Map();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row.row_type !== 'structural_score') continue;
        const oid = row.orchestration_id;
        const s   = row.structural_score;
        if (!oid || typeof s !== 'number') continue;
        const entry = acc.get(oid) || { sum: 0, count: 0 };
        entry.sum   += s;
        entry.count += 1;
        acc.set(oid, entry);
      } catch (_e) { /* skip malformed */ }
    }
    for (const [oid, { sum, count }] of acc) {
      result.set(oid, parseFloat((sum / count).toFixed(4)));
    }
  } catch (_e) {
    // fail-open: structural_score is a new field
  }
  return result;
}

/**
 * Compute per-pattern ROI metrics from the loaded events.
 *
 * @param {PatternMeta[]} patterns
 * @param {Object[]} events
 * @returns {Object[]} Array of ROI records (one per pattern)
 */
function computeRoi(patterns, events, now) {
  // Index events by type for fast lookup
  const byType = {};
  for (const ev of events) {
    const t = ev.type;
    if (!t) continue;
    if (!byType[t]) byType[t] = [];
    byType[t].push(ev);
  }

  const applicationEvents = byType['pattern_record_application'] || [];
  const skipEvents         = byType['pattern_skip_enriched']      || [];
  const agentStopEvents    = byType['agent_stop']                  || [];

  // Build orchestration → total cost map from agent_stop events
  // (agent_stop carries estimated_cost_usd)
  const orchCostMap = {};  // orchestration_id → sum of estimated_cost_usd
  for (const ev of agentStopEvents) {
    const oid  = ev.orchestration_id;
    const cost = typeof ev.estimated_cost_usd === 'number' ? ev.estimated_cost_usd : 0;
    if (!oid) continue;
    orchCostMap[oid] = (orchCostMap[oid] || 0) + cost;
  }

  // Collect orchestration IDs in the event window
  const allOrchIds = new Set(events.map(ev => ev.orchestration_id).filter(Boolean));

  const results = [];

  for (const p of patterns) {
    const slug = p.slug;

    // applications for this slug
    const applied = applicationEvents.filter(ev => ev.slug === slug || ev.pattern_name === slug);
    const skipped = skipEvents.filter(ev => ev.pattern_name === slug);

    const timesAppliedRecent  = applied.length;
    const timesSkippedRecent  = skipped.length;
    const denominator         = timesAppliedRecent + timesSkippedRecent;
    const appRate             = denominator > 0 ? timesAppliedRecent / denominator : 0;

    // Orchestrations where this pattern was applied
    const appliedOrchIds = new Set(applied.map(ev => ev.orchestration_id).filter(Boolean));

    // Compute avg cost for orchestrations where pattern was applied vs not
    const costsApplied  = [];
    const costsBaseline = [];

    for (const oid of allOrchIds) {
      if (oid in orchCostMap) {
        const cost = orchCostMap[oid];
        if (appliedOrchIds.has(oid)) {
          costsApplied.push(cost);
        } else {
          costsBaseline.push(cost);
        }
      }
    }

    const avgCostApplied  = costsApplied.length > 0
      ? costsApplied.reduce((a, b) => a + b, 0) / costsApplied.length
      : null;
    const avgCostBaseline = costsBaseline.length > 0
      ? costsBaseline.reduce((a, b) => a + b, 0) / costsBaseline.length
      : null;

    // delta_cost: null if we don't have both sides
    let deltaCost = null;
    if (avgCostApplied !== null && avgCostBaseline !== null) {
      deltaCost = avgCostApplied - avgCostBaseline;
    }

    const roi = computeRoiScore(
      deltaCost !== null ? deltaCost : 0,
      appRate,
      p.decayedConfidence
    );

    const HIGH_ROI_THRESHOLD = 0.35;

    results.push({
      slug,
      category:              p.category,
      confidence:            p.confidence,
      decayed_confidence:    parseFloat(p.decayedConfidence.toFixed(4)),
      times_applied_recent:  timesAppliedRecent,
      times_skipped_recent:  timesSkippedRecent,
      app_rate:              parseFloat(appRate.toFixed(4)),
      avg_cost_applied:      avgCostApplied !== null ? parseFloat(avgCostApplied.toFixed(4)) : null,
      avg_cost_baseline:     avgCostBaseline !== null ? parseFloat(avgCostBaseline.toFixed(4)) : null,
      delta_cost:            deltaCost !== null ? parseFloat(deltaCost.toFixed(4)) : null,
      roi_score:             parseFloat(roi.toFixed(4)),
      high_roi_flag:         roi >= HIGH_ROI_THRESHOLD,
      // structural_score: avg across all agent spawns in orchestrations where
      // this pattern was applied (null when no structural_score rows exist yet).
      structural_score:      null, // populated below after structural scores are loaded
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Snapshot writer
// ---------------------------------------------------------------------------

/**
 * Write roi-snapshot.json atomically.
 * @param {string} projectRoot
 * @param {Object} snapshot
 */
function writeSnapshot(projectRoot, snapshot) {
  const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
  fs.mkdirSync(patternsDir, { recursive: true });
  const destPath = path.join(patternsDir, 'roi-snapshot.json');
  const tmpPath  = destPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tmpPath, destPath);
}

// ---------------------------------------------------------------------------
// Calibration suggestion writer
// ---------------------------------------------------------------------------

/**
 * Format ISO date as YYYYMMDD-HHMMZ (UTC), so artefact filenames stay consistent
 * with the UTC ISO string in the generated_at frontmatter field on all timezones.
 * @param {Date} d
 * @returns {string}
 */
function formatTs(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    'Z'
  );
}

/**
 * Build and write the calibration-suggestion-{ts}.md file.
 * @param {string} projectRoot
 * @param {Object[]} roiRecords
 * @param {Object} snapshotMeta  - { window_days, generated_at, orchestration_count }
 * @param {Date} now
 * @returns {{ path: string, count: number }|null} written path + suggestion count, or null if no suggestions
 */
function writeCalibrationSuggestion(projectRoot, roiRecords, snapshotMeta, now) {
  const sorted    = [...roiRecords].sort((a, b) => b.roi_score - a.roi_score);
  const top5      = sorted.slice(0, 5);
  const bottom5   = sorted.slice(-5).reverse();

  // Build suggestions
  const suggestions = [];

  // Suggestion: increase confidence for top-5 with decayed_confidence < 0.8 that have applied > 0
  for (const rec of top5) {
    if (rec.decayed_confidence < 0.8 && rec.times_applied_recent > 0) {
      suggestions.push({
        type: 'increase_confidence',
        slug: rec.slug,
        current_confidence: rec.confidence,
        decayed_confidence: rec.decayed_confidence,
        roi_score: rec.roi_score,
        evidence: `${rec.times_applied_recent} application(s), ${rec.times_skipped_recent} skip(s) in window`,
      });
    }
  }

  // Suggestion: deprecate bottom-5 with app_rate < 0.1 AND decayed_confidence < 0.4
  for (const rec of bottom5) {
    if (rec.app_rate < 0.1 && rec.decayed_confidence < 0.4) {
      suggestions.push({
        type: 'deprecate',
        slug: rec.slug,
        app_rate: rec.app_rate,
        decayed_confidence: rec.decayed_confidence,
        roi_score: rec.roi_score,
        evidence: `${rec.times_applied_recent} application(s), ${rec.times_skipped_recent} skip(s) in window`,
      });
    }
  }

  // Suggestion: adjust anti_pattern_gate threshold if > half of anti-patterns show app_rate ≈ 0
  const antiPatterns   = roiRecords.filter(r => r.category === 'anti-pattern');
  const lowAppRate     = antiPatterns.filter(r => r.app_rate < 0.05);
  if (antiPatterns.length > 0 && lowAppRate.length > antiPatterns.length / 2) {
    suggestions.push({
      type: 'adjust_gate',
      anti_pattern_count: antiPatterns.length,
      low_app_rate_count: lowAppRate.length,
      evidence: `${lowAppRate.length}/${antiPatterns.length} anti-patterns have app_rate < 0.05 (users consistently skipping)`,
    });
  }

  if (suggestions.length === 0) return null;

  const suggestionCount = suggestions.length;

  const ts    = formatTs(now);
  const kbDir = path.join(projectRoot, '.orchestray', 'kb', 'artifacts');
  fs.mkdirSync(kbDir, { recursive: true });
  const destPath = path.join(kbDir, `calibration-suggestion-${ts}.md`);

  // Build markdown body
  const lines = [];

  // Frontmatter
  lines.push('---');
  lines.push('status: suggestion');
  lines.push('enforced: false');
  lines.push('source: pattern-roi-aggregate');
  lines.push(`generated_at: ${now.toISOString()}`);
  lines.push(`window_days: ${snapshotMeta.window_days}`);
  lines.push(`schema_version: ${SNAPSHOT_SCHEMA_VERSION}`);
  lines.push('---');
  lines.push('');

  // Title and summary
  lines.push('# Pattern ROI Calibration Suggestions');
  lines.push('');
  lines.push(
    `> SUGGESTED — NOT APPLIED. Generated from ${snapshotMeta.orchestration_count} orchestrations ` +
    `in the last ${snapshotMeta.window_days} days. ` +
    `All suggestions require human review and manual application.`
  );
  lines.push('');

  // Top-5 table
  lines.push('## Top 5 Patterns by ROI');
  lines.push('');
  lines.push('| Slug | ROI Score | App Rate | Decayed Conf | Applied (recent) | Skipped (recent) | Structural Score |');
  lines.push('|------|-----------|----------|--------------|-----------------|-----------------|-----------------|');
  for (const r of top5) {
    const ss = r.structural_score !== null ? r.structural_score.toFixed(3) : 'n/a';
    lines.push(`| ${r.slug} | ${r.roi_score.toFixed(3)} | ${r.app_rate.toFixed(2)} | ${r.decayed_confidence.toFixed(2)} | ${r.times_applied_recent} | ${r.times_skipped_recent} | ${ss} |`);
  }
  lines.push('');

  // Bottom-5 table
  lines.push('## Bottom 5 Patterns by ROI');
  lines.push('');
  lines.push('| Slug | ROI Score | App Rate | Decayed Conf | Applied (recent) | Skipped (recent) | Structural Score |');
  lines.push('|------|-----------|----------|--------------|-----------------|-----------------|-----------------|');
  for (const r of bottom5) {
    const ss = r.structural_score !== null ? r.structural_score.toFixed(3) : 'n/a';
    lines.push(`| ${r.slug} | ${r.roi_score.toFixed(3)} | ${r.app_rate.toFixed(2)} | ${r.decayed_confidence.toFixed(2)} | ${r.times_applied_recent} | ${r.times_skipped_recent} | ${ss} |`);
  }
  lines.push('');

  // Suggested actions
  lines.push('## Suggested Actions');
  lines.push('');
  lines.push('> All items below are SUGGESTED — NOT APPLIED. Apply manually after review.');
  lines.push('');

  for (const s of suggestions) {
    if (s.type === 'increase_confidence') {
      lines.push(
        `- SUGGESTED — NOT APPLIED: Consider increasing \`pattern.${s.slug}.confidence\` ` +
        `(currently ${s.current_confidence}, decayed to ${s.decayed_confidence.toFixed(3)}; ` +
        `high-ROI observed roi_score=${s.roi_score.toFixed(3)}). ` +
        `Evidence: ${s.evidence}.`
      );
    } else if (s.type === 'deprecate') {
      lines.push(
        `- SUGGESTED — NOT APPLIED: Consider deprecating \`pattern.${s.slug}\` ` +
        `(app_rate=${s.app_rate.toFixed(3)}, decayed_confidence=${s.decayed_confidence.toFixed(3)}, ` +
        `roi_score=${s.roi_score.toFixed(3)}). ` +
        `Evidence: ${s.evidence}.`
      );
    } else if (s.type === 'adjust_gate') {
      lines.push(
        `- SUGGESTED — NOT APPLIED: Consider adjusting \`anti_pattern_gate.min_decayed_confidence\` — ` +
        `${s.evidence}. This may indicate the gate threshold is too aggressive or patterns are misclassified.`
      );
    }
  }

  lines.push('');

  const tmpPath = destPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, lines.join('\n'), 'utf8');
  fs.renameSync(tmpPath, destPath);

  return { path: destPath, count: suggestionCount };
}

// ---------------------------------------------------------------------------
// Audit event emitter
// ---------------------------------------------------------------------------

/**
 * Append a single event to audit/events.jsonl directly (not via stdin-hook path).
 * @param {string} projectRoot
 * @param {Object} event
 */
function emitAuditEvent(projectRoot, event) {
  try {
    const auditDir  = path.join(projectRoot, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    writeEvent({
      timestamp:        new Date().toISOString(),
      orchestration_id: _resolveOrchId(projectRoot),
      ...event,
    }, { cwd: projectRoot });
  } catch (_e) {
    // fail-open
  }
}

/**
 * Resolve orchestration_id from state file (best-effort).
 * @param {string} projectRoot
 * @returns {string}
 */
function _resolveOrchId(projectRoot) {
  try {
    const orchFile = path.join(projectRoot, '.orchestray', 'audit', 'current-orchestration.json');
    const data     = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return data.orchestration_id || 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MainOptions
 * @property {string}  [projectRoot]  - defaults to process.cwd()
 * @property {number}  [windowDays]   - defaults to config or 30
 * @property {boolean} [dryRun]       - skip file writes
 * @property {boolean} [force]        - skip throttle check
 * @property {Date}    [now]          - injectable for tests
 */

/**
 * Run the ROI aggregator.
 * @param {MainOptions} opts
 * @returns {{ ok: boolean, reason?: string, snapshot?: Object, suggestionPath?: string|null }}
 */
function main(opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const now         = (opts.now instanceof Date) ? opts.now : new Date();
  const dryRun      = !!opts.dryRun;
  const force       = !!opts.force;

  // Config gate (W10 deferred from W7): honour auto_learning flags.
  // Fail-open: any error loading config allows the run to proceed.
  try {
    const alConfig = loadAutoLearningConfig(projectRoot);
    if (alConfig.global_kill_switch) {
      emitAuditEvent(projectRoot, {
        type:           'pattern_roi_skipped',
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        reason:         'kill_switch',
      });
      return { ok: true, reason: 'pattern_roi_skipped:{reason:\'kill_switch\'}' };
    }
    if (!alConfig.roi_aggregator.enabled && !force) {
      emitAuditEvent(projectRoot, {
        type:           'pattern_roi_skipped',
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        reason:         'feature_disabled',
      });
      return { ok: true, reason: 'pattern_roi_skipped:{reason:\'feature_disabled\'}' };
    }
  } catch (_configErr) {
    // Fail-open: if config loading throws, proceed with the run.
  }

  // Read config (overrides if present)
  const cfg         = readConfig(projectRoot);
  const windowDays  = (typeof opts.windowDays === 'number' && opts.windowDays > 0)
    ? opts.windowDays : cfg.windowDays;
  const minDaysBetweenRuns = cfg.minDaysBetweenRuns;

  // Throttle check
  if (!force) {
    const lastRun = readLastRun(projectRoot);
    if (lastRun) {
      const daysSince = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < minDaysBetweenRuns) {
        emitAuditEvent(projectRoot, {
          type:           'pattern_roi_skipped',
          schema_version: SNAPSHOT_SCHEMA_VERSION,
          reason:         'throttled',
          last_run:       lastRun.toISOString(),
        });
        return { ok: true, reason: 'throttled (last run: ' + lastRun.toISOString() + ')' };
      }
    }
  }

  // Touch throttle state on every non-throttled run (even dry-run)
  if (!dryRun) {
    writeLastRun(projectRoot, now);
  }

  // Load patterns
  const patterns = loadPatterns(projectRoot, now);
  if (patterns === null) {
    emitAuditEvent(projectRoot, {
      type:           'pattern_roi_skipped',
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      reason:         'no_patterns',
    });
    return { ok: true, reason: 'no_patterns' };
  }
  if (patterns.length === 0) {
    emitAuditEvent(projectRoot, {
      type:           'pattern_roi_skipped',
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      reason:         'no_patterns',
    });
    return { ok: true, reason: 'no_patterns (empty dir)' };
  }

  // Load events
  const windowStart  = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const { events }   = loadEvents(projectRoot, windowStart);

  if (events.length === 0) {
    emitAuditEvent(projectRoot, {
      type:           'pattern_roi_skipped',
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      reason:         'no_events',
    });
    return { ok: true, reason: 'no_events' };
  }

  // Compute ROI
  const roiRecords = computeRoi(patterns, events, now);

  // Populate structural_score per pattern from agent_metrics.jsonl
  // structural_score rows are keyed by orchestration_id, not pattern slug.
  // We attach the avg structural_score of orchestrations where this pattern was applied.
  const structuralByOrch = loadStructuralScores(projectRoot);
  for (const rec of roiRecords) {
    const applied = (events || []).filter(
      (ev) => ev.type === 'pattern_record_application' &&
               (ev.slug === rec.slug || ev.pattern_name === rec.slug)
    );
    const orchIds = new Set(applied.map((ev) => ev.orchestration_id).filter(Boolean));
    const scores  = [];
    for (const oid of orchIds) {
      if (structuralByOrch.has(oid)) scores.push(structuralByOrch.get(oid));
    }
    rec.structural_score = scores.length > 0
      ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4))
      : null;
  }

  // Build snapshot
  const sortedByRoi = [...roiRecords].sort((a, b) => b.roi_score - a.roi_score);
  const top5Slugs   = sortedByRoi.slice(0, 5).map(r => r.slug);
  const bottom5     = [...roiRecords].sort((a, b) => a.roi_score - b.roi_score).slice(0, 5);
  const bottom5Slugs = bottom5.map(r => r.slug);

  // Count distinct orchestration IDs in window
  const orchIds = new Set(events.map(e => e.orchestration_id).filter(Boolean));

  const snapshot = {
    generated_at:                 now.toISOString(),
    window_days:                  windowDays,
    orchestration_count_in_window: orchIds.size,
    snapshot_schema_version:      SNAPSHOT_SCHEMA_VERSION,
    patterns:                     sortedByRoi,
    top_5_by_roi:                 top5Slugs,
    bottom_5_by_roi:              bottom5Slugs,
  };

  let suggestionPath = null;

  if (!dryRun) {
    // Write snapshot
    writeSnapshot(projectRoot, snapshot);

    // Write calibration suggestion (if suggestions exist)
    const suggestionResult = writeCalibrationSuggestion(
      projectRoot,
      roiRecords,
      { window_days: windowDays, generated_at: now.toISOString(), orchestration_count: orchIds.size },
      now
    );
    if (suggestionResult) {
      suggestionPath = suggestionResult.path;

      // CHG-C02: emit calibration_suggestion_emitted event (design §5).
      emitAuditEvent(projectRoot, {
        type:             'calibration_suggestion_emitted',
        schema_version:   SNAPSHOT_SCHEMA_VERSION,
        artefact_path:    path.relative(projectRoot, suggestionResult.path),
        window_days:      windowDays,
        suggestion_count: suggestionResult.count,
      });
    }
  }

  // Emit pattern_roi_snapshot event
  emitAuditEvent(projectRoot, {
    type:             'pattern_roi_snapshot',
    schema_version:   SNAPSHOT_SCHEMA_VERSION,
    window_days:      windowDays,
    patterns_scanned: roiRecords.length,
    artefact_path:    dryRun ? null : path.join('.orchestray', 'patterns', 'roi-snapshot.json'),
    top_roi:          top5Slugs,
    bottom_roi:       bottom5Slugs,
  });

  return { ok: true, snapshot, suggestionPath };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Parse CLI args
  const argv       = process.argv.slice(2);
  let windowDays   = DEFAULT_WINDOW_DAYS;
  let projectRoot  = process.cwd();
  let dryRun       = false;
  let force        = false;

  for (const arg of argv) {
    if (arg.startsWith('--window-days=')) {
      const n = parseInt(arg.split('=')[1], 10);
      if (!isNaN(n) && n > 0) windowDays = n;
    } else if (arg.startsWith('--project-root=')) {
      projectRoot = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    }
  }

  let result;
  try {
    result = main({ projectRoot, windowDays, dryRun, force });
  } catch (err) {
    recordDegradation({
      kind: 'pattern_roi_uncaught_error',
      severity: 'warn',
      detail: { reason: 'roi_uncaught_error', error: String(err).slice(0, 200) },
      projectRoot,
    });
    try {
      const auditDir  = path.join(projectRoot, '.orchestray', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      writeEvent({
        timestamp:      new Date().toISOString(),
        type:           'pattern_roi_skipped',
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        reason:         'error',
        orchestration_id: 'unknown',
      }, { cwd: projectRoot });
    } catch (_e2) {}
    process.exit(0);
  }

  if (!result.ok) {
    process.exit(1);
  }

  if (result.reason) {
    process.stderr.write('[orchestray] pattern-roi-aggregate: ' + result.reason + '\n');
  }

  process.exit(0);
}

module.exports = {
  main,
  // Exported for tests
  _internal: {
    computeDecayedConfidence,
    computeRoiScore,
    loadPatterns,
    loadEvents,
    computeRoi,
    loadStructuralScores,
    writeSnapshot,
    writeCalibrationSuggestion,
    readLastRun,
    writeLastRun,
    formatTs,
    tanhNorm,
    clamp,
    emitAuditEvent,
  },
};
