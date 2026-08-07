#!/usr/bin/env node
'use strict';

/**
 * commit-pattern-applications.js — Phase 3 orch-close batch committer
 * (design: pattern-application-evidence-design.md §4.3).
 *
 * Wired into bin/audit-on-orch-complete.js's fan-out (runs once per
 * orchestration_complete, after archive-orch-events.js so the per-orch
 * events.jsonl slice is already on disk). Joins pattern-offers.jsonl ×
 * pattern-acks.jsonl × the orch's event slice through the §5 bounds
 * (bin/_lib/pattern-credit-compute.js), then:
 *   - increments times_applied (+1, capped, one per orch) for credited slugs
 *   - increments times_offered (regardless of credit) for every offered slug
 *   - increments times_contradicted for slugs named only in patterns_rejected
 *   - journals every frontmatter field write for bin/pattern-counter-revert.js
 *   - emits pattern_application_recorded / pattern_application_withheld /
 *     pattern_never_offered
 *
 * Kill switches (default-on, §10.1):
 *   ORCHESTRAY_PATTERN_EVIDENCE_DISABLED=1        — skip entirely
 *   ORCHESTRAY_PATTERN_EVIDENCE_COMMIT_DISABLED=1 — compute + emit, no frontmatter writes
 *   config.pattern_evidence.enabled: false        — same as the first
 *   config.pattern_evidence.commit: false         — same as the second
 *
 * Concurrency (§10.3): each pattern file's read-modify-write is wrapped in
 * bin/_lib/atomic-append.js's _withAdvisoryLock, fail-CLOSED on contention
 * (skip that pattern's commit rather than risk a double increment).
 *
 * Idempotency (§5.2 belt-and-braces): the orchestration-level dedup in
 * bin/audit-on-orch-complete.js already prevents this script re-running for
 * the same orchestration_id, but this script additionally CLAIMS the
 * orchestration in the journal — one locked read-and-append via
 * atomicAppendJsonlIfAbsent, before any frontmatter write. Two committers for
 * the same orchestration_id therefore cannot both increment: the loser sees
 * the winner's claim row and exits. An unlocked read-then-write check was not
 * enough, because the blocking row used to be written only AFTER the
 * frontmatter mutation (RV-1 E1: reproduced as times_applied 0 -> 2).
 *
 * Fail-open contract: every error path logs to stderr and returns 0 — this
 * runs as a spawned child of the orch-boundary hook and must never throw.
 *
 * NOT_A_HOOK in the PreToolUse/PostToolUse sense — invoked as a plain child
 * process by bin/audit-on-orch-complete.js, same as its five siblings.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { _withAdvisoryLock, atomicAppendJsonlIfAbsent } = require('./_lib/atomic-append');
const { readHookInputRaw }            = require('./_lib/hook-stdin');
const ledger                          = require('./_lib/pattern-evidence-ledger');
const { computeCredits }              = require('./_lib/pattern-credit-compute');
const patternFiles                    = require('./_lib/pattern-file-resolve');
const frontmatter                     = require('./mcp-server/lib/frontmatter');

const SCHEMA_VERSION = 1;
const MAX_EVENTS_FILE_BYTES = 64 * 1024 * 1024; // matches sibling audit scripts

const DEFAULT_PATTERN_EVIDENCE_CONFIG = {
  enabled: true,
  commit: true,
  max_credits_per_orchestration: 5,
  max_self_report_per_orchestration: 2,
  min_how_length: 10,
  ambient_promotion: { enabled: true, min_how_length: 40, max_per_spawn: 1 },
  never_offered_window_orchestrations: 20,
};

// ---------------------------------------------------------------------------
// Config + kill switches
// ---------------------------------------------------------------------------

function loadConfig(cwd) {
  const cfg = Object.assign({}, DEFAULT_PATTERN_EVIDENCE_CONFIG);
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const block = parsed && parsed.pattern_evidence;
    if (block && typeof block === 'object') {
      for (const key of Object.keys(DEFAULT_PATTERN_EVIDENCE_CONFIG)) {
        if (key === 'ambient_promotion' && block.ambient_promotion && typeof block.ambient_promotion === 'object') {
          cfg.ambient_promotion = Object.assign({}, cfg.ambient_promotion, block.ambient_promotion);
        } else if (block[key] !== undefined) {
          cfg[key] = block[key];
        }
      }
    }
  } catch (_e) { /* fail-open: defaults */ }
  return cfg;
}

function evidenceDisabled(cfg) {
  return process.env.ORCHESTRAY_PATTERN_EVIDENCE_DISABLED === '1' || cfg.enabled === false;
}

function commitDisabled(cfg) {
  return process.env.ORCHESTRAY_PATTERN_EVIDENCE_COMMIT_DISABLED === '1' || cfg.commit === false;
}

// ---------------------------------------------------------------------------
// Event-slice read — mirrors bin/audit-housekeeper-orphan.js's
// loadEventLines (archive-first, live fallback). Duplicated locally rather
// than shared: no existing lib exports this read, and the two call sites
// have slightly different byte caps / call conventions.
// ---------------------------------------------------------------------------

function loadOrchEventSlice(cwd, orchId) {
  const archive = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const live    = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  for (const candidate of [archive, live]) {
    let text;
    try {
      const stat = fs.statSync(candidate);
      if (stat.size === 0) continue;
      if (stat.size > MAX_EVENTS_FILE_BYTES) {
        process.stderr.write(`[commit-pattern-applications] ${candidate} exceeds cap; skipping\n`);
        continue;
      }
      text = fs.readFileSync(candidate, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        process.stderr.write(`[commit-pattern-applications] read ${candidate} failed: ${e.message}\n`);
      }
      continue;
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.orchestration_id === orchId) events.push(ev);
      } catch (_e) { /* skip malformed */ }
    }
    return events;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Idempotency — skip if this orchestration already has journal rows.
// ---------------------------------------------------------------------------

function alreadyCommitted(cwd, orchId) {
  try {
    const journalPath = ledger._journalPath(cwd);
    const raw = fs.readFileSync(journalPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.orchestration_id === orchId) return true;
      } catch (_e) { /* skip malformed */ }
    }
  } catch (_e) { /* missing journal — not committed yet */ }
  return false;
}

/**
 * §5.2 — claim this orchestration under the journal's advisory lock, BEFORE
 * any frontmatter write. The read and the append happen inside one lock, so a
 * concurrent committer either wins the claim or sees it and stands down.
 *
 * The claim row carries `kind: 'claim'` and no field/before/after;
 * bin/pattern-counter-revert.js skips it.
 *
 * @returns {boolean} true when this process owns the orchestration.
 */
function claimOrchestration(cwd, orchId, nowIso) {
  try {
    return atomicAppendJsonlIfAbsent(
      ledger._journalPath(cwd),
      { timestamp: nowIso, orchestration_id: orchId, kind: 'claim', committer: 'commit-pattern-applications' },
      (row) => !!row && row.orchestration_id === orchId
    );
  } catch (e) {
    // Fail-CLOSED: an unclaimable journal must not become a free double-credit.
    process.stderr.write(`[commit-pattern-applications] claim failed for "${orchId}": ${e && e.message}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Locked per-pattern-file field batch write. §10.3: fail-closed on lock
// contention (skip rather than risk a double increment).
// ---------------------------------------------------------------------------

/**
 * @param {string} patternFile
 * @param {Array<{field: string, transform: (current:number)=>*}>} ops
 * @returns {{ ok: true, changes: Array<{field,before,after}> } | { ok: false, error: string }}
 */
function applyFieldOps(patternFile, ops) {
  const lockPath = patternFile + '.evidence.lock';
  const result = _withAdvisoryLock(lockPath, () => {
    let content;
    try { content = fs.readFileSync(patternFile, 'utf8'); }
    catch (e) { return { ok: false, error: (e && e.code) || 'read_failed' }; }

    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) return { ok: false, error: 'malformed_frontmatter' };

    const fm = Object.assign({}, parsed.frontmatter);
    const changes = [];
    for (const { field, transform } of ops) {
      // Raw current value passed through as-is (null/undefined/string) —
      // only the counter transforms below coerce to a number internally.
      // Coercing here would corrupt non-numeric fields like last_applied
      // (null) on revert, since the journal's `before` must be the value to
      // restore, not a counter default.
      // before_absent distinguishes "was not in the frontmatter" from "was
      // null": revert deletes the key in the first case, since writing null
      // back fails schemas/pattern.schema.js (.optional() rejects null).
      const beforeAbsent = fm[field] === undefined;
      const before = beforeAbsent ? null : fm[field];
      const after = transform(before);
      fm[field] = after;
      changes.push({ field, before, after, before_absent: beforeAbsent });
    }

    const next = frontmatter.stringify({ frontmatter: fm, body: parsed.body });
    const tmp = patternFile + '.tmp';
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, patternFile);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_e2) { /* swallow */ }
      return { ok: false, error: (e && e.code) || 'write_failed' };
    }
    return { ok: true, changes };
  });

  if (result && result.skipped) return { ok: false, error: 'lock_contention_skipped' };
  return result;
}

/** Read a single numeric frontmatter field without mutating (observe-only path). */
function readNumericField(patternFile, field) {
  try {
    const parsed = frontmatter.parse(fs.readFileSync(patternFile, 'utf8'));
    const v = parsed.frontmatter && parsed.frontmatter[field];
    return typeof v === 'number' ? v : 0;
  } catch (_e) { return 0; }
}

// Resolves across all three offer-eligible tiers (local > team > shared).
// Local-only resolution left every team/shared slug unwritable while still
// offer-eligible, so its counters never moved (RV-1 E6).
function resolvePatternEntry(cwd, slug) {
  return patternFiles.resolvePatternEntry(cwd, slug);
}

function resolvePatternFile(cwd, slug) {
  return patternFiles.resolvePatternFile(cwd, slug);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let payload = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = readHookInputRaw();
      if (raw && raw.trim().length > 0) payload = JSON.parse(raw);
    }
  } catch (_e) { /* fail-open */ }

  const cwd = resolveSafeCwd(payload && payload.cwd);

  let orchId = null;
  try {
    const orchData = JSON.parse(fs.readFileSync(getCurrentOrchestrationFile(cwd), 'utf8'));
    if (orchData && typeof orchData.orchestration_id === 'string') orchId = orchData.orchestration_id;
  } catch (_e) { /* fail-open */ }
  if (!orchId) return 0;

  const cfg = loadConfig(cwd);
  if (evidenceDisabled(cfg)) return 0;

  const doCommit = !commitDisabled(cfg);
  const nowIso = new Date().toISOString();

  if (alreadyCommitted(cwd, orchId)) return 0;

  const offers = ledger.readOffersForOrch(cwd, orchId);
  const acks   = ledger.readAcksForOrch(cwd, orchId);
  if (offers.length === 0 && acks.length === 0) {
    emitNeverOffered(cwd, orchId, cfg); // still useful signal even without local activity
    return 0;
  }

  // §5.2 — claim before any frontmatter write; the loser of the race stops
  // here. Claimed only once there is something to commit, so an empty close
  // does not permanently block a later real one. Observe-only mode writes
  // nothing, so it neither claims nor blocks.
  if (doCommit && !claimOrchestration(cwd, orchId, nowIso)) return 0;

  const orchEvents = loadOrchEventSlice(cwd, orchId);
  const result = computeCredits(offers, acks, orchEvents, cfg);

  // Build the per-slug op batch: union of credited, offered, contradicted.
  const opsBySlug = new Map(); // slug -> [{field, transform}]
  const beforeAfter = new Map(); // slug -> { times_applied_before, times_applied_after }

  function addOp(slug, field, transform) {
    if (!opsBySlug.has(slug)) opsBySlug.set(slug, []);
    opsBySlug.get(slug).push({ field, transform });
  }

  const asNum = (v) => (typeof v === 'number' ? v : 0);

  for (const c of result.credited) {
    addOp(c.slug, 'times_applied', (v) => asNum(v) + 1);
    addOp(c.slug, 'last_applied', () => nowIso);
  }
  // schemas/pattern.schema.js documents times_offered as "count of distinct
  // ORCHESTRATIONS", matching times_applied's own per-orchestration cap and
  // migrate-pattern-counter-epoch.js's Set(orchestration_id) backfill — NOT
  // a per-spawn count. computeCredits().offered_counts carries the raw
  // distinct-spawn-count (useful signal in its own right); the frontmatter
  // increment is capped to +1 per orchestration regardless of that count, so
  // the metric's semantics stay identical across the migration boundary.
  for (const slug of Object.keys(result.offered_counts)) {
    addOp(slug, 'times_offered', (v) => asNum(v) + 1);
  }
  for (const slug of result.contradicted) {
    addOp(slug, 'times_contradicted', (v) => asNum(v) + 1);
  }

  for (const [slug, ops] of opsBySlug) {
    const entry = resolvePatternEntry(cwd, slug);
    if (!entry) {
      process.stderr.write(`[commit-pattern-applications] pattern file not found for slug "${slug}"; skipping\n`);
      continue;
    }
    const patternFile = entry.file;
    const beforeApplied = readNumericField(patternFile, 'times_applied');
    if (!doCommit) {
      beforeAfter.set(slug, { before: beforeApplied, after: beforeApplied });
      continue;
    }
    const applied = applyFieldOps(patternFile, ops);
    if (!applied || !applied.ok) {
      process.stderr.write(`[commit-pattern-applications] field write failed for "${slug}": ${applied && applied.error}\n`);
      beforeAfter.set(slug, { before: beforeApplied, after: beforeApplied });
      continue;
    }
    for (const change of applied.changes) {
      ledger.appendJournal(cwd, {
        timestamp: nowIso,
        orchestration_id: orchId,
        slug,
        tier: entry.tier,
        field: change.field,
        before: change.before,
        before_absent: !!change.before_absent,
        after: change.after,
        committer: 'commit-pattern-applications',
      });
      if (change.field === 'times_applied') {
        beforeAfter.set(slug, { before: change.before, after: change.after });
      }
    }
    if (!beforeAfter.has(slug)) beforeAfter.set(slug, { before: beforeApplied, after: beforeApplied });
  }

  // Emit pattern_application_recorded for every credited slug.
  for (const c of result.credited) {
    const ba = beforeAfter.get(c.slug) || { before: 0, after: 0 };
    writeEvent({
      version: SCHEMA_VERSION,
      type: 'pattern_application_recorded',
      orchestration_id: orchId,
      timestamp: nowIso,
      slug: c.slug,
      pattern_name: c.slug,
      evidence_grade: c.evidence_grade,
      offer_kind: c.offer_kind,
      spawn_ids: c.spawn_ids,
      agent_roles: c.agent_roles,
      times_applied_before: ba.before,
      times_applied_after: ba.after,
      schema_version: SCHEMA_VERSION,
    }, { cwd });
  }

  // Emit pattern_application_withheld for every withheld slug.
  for (const w of result.withheld) {
    writeEvent({
      version: SCHEMA_VERSION,
      type: 'pattern_application_withheld',
      orchestration_id: orchId,
      timestamp: nowIso,
      slug: w.slug,
      pattern_name: w.slug,
      reason: w.reason,
      offer_kind: w.offer_kind,
      spawn_ids: w.spawn_ids || [],
      schema_version: SCHEMA_VERSION,
    }, { cwd });
  }

  emitNeverOffered(cwd, orchId, cfg);

  return 0;
}

/**
 * §8.5 — corpus patterns with times_offered === 0, at most once per orch.
 * Simplification (documented in the Phase-3 handoff): reads the CURRENT
 * on-disk times_offered rather than tracking a true N-orchestration rolling
 * window — window_orchestrations is carried on the event as context for
 * downstream consumers, not enforced as a lookback here.
 */
function emitNeverOffered(cwd, orchId, cfg) {
  try {
    // Same three tiers the offer scanner draws from — a shared-tier pattern
    // that is never offered is exactly as interesting as a local one.
    const files = patternFiles.listPatternFiles(cwd);
    if (files.length === 0) return;

    const neverOffered = [];
    for (const entry of files) {
      if (readNumericField(entry.file, 'times_offered') === 0) neverOffered.push(entry.slug);
    }
    if (neverOffered.length === 0) return;

    writeEvent({
      version: SCHEMA_VERSION,
      type: 'pattern_never_offered',
      orchestration_id: orchId,
      timestamp: new Date().toISOString(),
      window_orchestrations: cfg.never_offered_window_orchestrations,
      slugs: neverOffered,
      corpus_size: files.length,
      schema_version: SCHEMA_VERSION,
    }, { cwd });
  } catch (e) {
    process.stderr.write(`[commit-pattern-applications] never-offered scan failed: ${e && e.message}\n`);
  }
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`[commit-pattern-applications] top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = { main, loadConfig, loadOrchEventSlice, applyFieldOps, resolvePatternFile, alreadyCommitted, claimOrchestration };
