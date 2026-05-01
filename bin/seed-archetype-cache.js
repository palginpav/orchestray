#!/usr/bin/env node
'use strict';

/**
 * seed-archetype-cache.js — Cold-cache seeder for archetype-cache.jsonl (v2.2.20 T6).
 *
 * Ships 10 static seed archetypes covering the primary Orchestray task families.
 * Runs once per project via the SessionStart hook, guarded by a sentinel file.
 * On re-runs with --force, merges using no-downgrade strategy.
 *
 * Usage (hook): node bin/seed-archetype-cache.js
 *   Runs with sentinel guard. Exits 0 always (fail-open).
 *
 * Usage (CLI): node bin/seed-archetype-cache.js [flags]
 *   --force         Bypass sentinel; merge seeds over existing cache
 *   --dry-run       Print what would be written; do not write
 *   --from-events   Run history mine pass (included by default; --from-events alone skips shipped seeds)
 *   --from-shipped  Write shipped seeds only (skip history mine)
 *   --help          Print usage
 *
 * Exit codes: always 0 (fail-open — must never block SessionStart)
 *
 * Note: historyMinePass reads .orchestray/audit/events.jsonl in full
 * (not streaming). Bounded to a single execution per project by the
 * sentinel guard at .orchestray/state/.archetype-seeder-done.
 *
 * Sentinel: .orchestray/state/.archetype-seeder-done
 * Kill switch: ORCHESTRAY_ARCHETYPE_SEEDER_DISABLED=1 (env) or
 *              context_compression_v218.archetype_cache.seeder_disabled: true (config)
 *
 * For a clean reseed:
 *   rm .orchestray/state/archetype-cache.jsonl
 *   rm .orchestray/state/.archetype-seeder-done
 *   node bin/seed-archetype-cache.js
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');

// ─── Constants ────────────────────────────────────────────────────────────────

const SEEDS_FILE    = path.join(__dirname, '_lib', '_seeds', 'archetype-seeds.json');
const CACHE_REL     = path.join('.orchestray', 'state', 'archetype-cache.jsonl');
const SENTINEL_REL  = path.join('.orchestray', 'state', '.archetype-seeder-done');
const EVENTS_REL    = path.join('.orchestray', 'audit', 'events.jsonl');
const CONFIG_REL    = path.join('.orchestray', 'config.json');

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadConfig(cwd) {
  try {
    const cfgPath = path.join(cwd, CONFIG_REL);
    if (!fs.existsSync(cfgPath)) return {};
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const ccv = raw && raw.context_compression_v218;
    if (!ccv) return {};
    return ccv.archetype_cache || {};
  } catch (_e) {
    return {};
  }
}

function isSeederDisabledByConfig(cwd) {
  try {
    const ac = loadConfig(cwd);
    return ac.seeder_disabled === true;
  } catch (_e) {
    return false;
  }
}

// ─── Cache file helpers ───────────────────────────────────────────────────────

function readCacheLines(cwd) {
  try {
    const p = path.join(cwd, CACHE_REL);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const records = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t)); } catch (_e) { /* skip corrupt */ }
    }
    return records;
  } catch (_e) {
    return [];
  }
}

function writeCacheLines(cwd, records, dryRun) {
  if (dryRun) {
    process.stdout.write('[dry-run] Would write ' + records.length + ' records to ' + CACHE_REL + '\n');
    return;
  }
  const dir = path.join(cwd, '.orchestray', 'state');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(cwd, CACHE_REL), content, 'utf8');
}

function writeSentinel(cwd, dryRun) {
  if (dryRun) {
    process.stdout.write('[dry-run] Would write sentinel ' + SENTINEL_REL + '\n');
    return;
  }
  const dir = path.join(cwd, '.orchestray', 'state');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, SENTINEL_REL), '', 'utf8');
}

// ─── Seed loading ─────────────────────────────────────────────────────────────

function loadSeeds() {
  const raw = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf8'));
  return raw;
}

// ─── Merge strategy (no-downgrade) ───────────────────────────────────────────

/**
 * Merge seedRecords into existingRecords.
 * - Existing record: preserve higher prior_applications_count and failed_uses.
 *   Do NOT reset last_used_ts, last_orch_id, or last_outcome.
 * - Missing record: add with fresh timestamps.
 *
 * @param {object[]} existingRecords
 * @param {object[]} seedRecords  - Seeds (without last_used_ts / created_ts)
 * @param {number}   now          - Date.now()
 * @returns {{ merged: object[], addedCount: number, skippedCount: number }}
 */
function mergeNoDowngrade(existingRecords, seedRecords, now) {
  let addedCount   = 0;
  let skippedCount = 0;
  const merged = existingRecords.slice(); // copy

  for (const seed of seedRecords) {
    const existing = merged.find(r => r.archetype_id === seed.archetype_id);
    if (existing) {
      // Preserve higher counts — real data wins
      existing.prior_applications_count = Math.max(
        existing.prior_applications_count || 0,
        seed.prior_applications_count
      );
      existing.failed_uses = Math.max(
        existing.failed_uses || 0,
        seed.failed_uses
      );
      // Preserve real last_used_ts, last_orch_id, last_outcome
      skippedCount++;
    } else {
      merged.push(Object.assign({}, seed, {
        last_used_ts: now,
        created_ts:   now,
      }));
      addedCount++;
    }
  }

  return { merged, addedCount, skippedCount };
}

// ─── History-mine pass ────────────────────────────────────────────────────────

/**
 * Map pm_decision values to outcome strings.
 */
function pmDecisionToOutcome(decision) {
  if (decision === 'overridden') return 'overridden';
  if (decision === 'accepted' || decision === 'adapted') return 'success';
  // Unrecognised decision values (e.g. 'deferred', 'skipped') must not silently
  // misreport as 'success'. Return 'unknown' and let callers decide whether to
  // skip the elevation (see historyMinePass caller).
  return 'unknown';
}

/**
 * Mine events.jsonl (and rotated archives) for archetype_cache_advisory_served events.
 * Elevates prior_applications_count for matching seed records.
 *
 * @param {string}   cwd
 * @param {object[]} records  - Mutable array of existing cache records
 * @returns {number} Number of elevations applied
 */
function historyMinePass(cwd, records) {
  let elevations = 0;
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    if (!fs.existsSync(auditDir)) return 0;

    // Collect events.jsonl + rotated archives
    const eventsFiles = [];
    const mainEvents = path.join(auditDir, 'events.jsonl');
    if (fs.existsSync(mainEvents)) eventsFiles.push(mainEvents);

    try {
      for (const f of fs.readdirSync(auditDir)) {
        if (f.startsWith('events.jsonl.pre-')) {
          eventsFiles.push(path.join(auditDir, f));
        }
      }
    } catch (_e) { /* ignore readdir errors */ }

    for (const evFile of eventsFiles) {
      try {
        const raw = fs.readFileSync(evFile, 'utf8');
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          let ev;
          try { ev = JSON.parse(t); } catch (_e) { continue; }

          if (ev.type !== 'archetype_cache_advisory_served') continue;

          const archetypeId = ev.archetype_id;
          const rec = records.find(r => r.archetype_id === archetypeId);
          if (!rec) continue; // only elevate seeds already in records

          rec.prior_applications_count = (rec.prior_applications_count || 0) + 1;
          if (ev.pm_decision === 'overridden') {
            rec.failed_uses = (rec.failed_uses || 0) + 1;
          }
          rec.last_orch_id = ev.orchestration_id || rec.last_orch_id;
          const outcome = pmDecisionToOutcome(ev.pm_decision);
          // Skip writing 'unknown' outcomes to the persisted cache — they would
          // misrepresent future decision values (e.g. 'deferred', 'skipped') as
          // an intentional state. Only persist recognised outcomes.
          if (outcome !== 'unknown') {
            rec.last_outcome = outcome;
          }

          // Update last_used_ts if event timestamp is newer
          if (ev.timestamp) {
            const evTs = Date.parse(ev.timestamp);
            if (Number.isFinite(evTs) && evTs > (rec.last_used_ts || 0)) {
              rec.last_used_ts = evTs;
            }
          }

          elevations++;
        }
      } catch (_e) { /* skip unreadable file */ }
    }
  } catch (_e) { /* fail-open */ }

  return elevations;
}

// ─── Warm-cache detection ─────────────────────────────────────────────────────

function isCacheWarm(cwd) {
  try {
    const p = path.join(cwd, CACHE_REL);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, 'utf8');
    // Any non-empty, non-whitespace line = warm
    return raw.split('\n').some(l => l.trim().length > 0);
  } catch (_e) {
    return false;
  }
}

// ─── Main seeder logic ────────────────────────────────────────────────────────

/**
 * Run the seeder.
 *
 * @param {object}  opts
 * @param {string}  [opts.cwd]         - Project root (defaults to resolveSafeCwd)
 * @param {boolean} [opts.force]       - Bypass sentinel
 * @param {boolean} [opts.dryRun]      - Print but do not write
 * @param {boolean} [opts.fromEvents]  - Mine events only (skip shipped seeds)
 * @param {boolean} [opts.fromShipped] - Write shipped seeds only (skip mine)
 * @param {string}  [opts.trigger]     - 'session_start' | 'cli'
 * @returns {{ seed_count, mined_count, merged_count, skipped_count }}
 */
function runSeeder(opts) {
  opts = opts || {};
  const cwd       = opts.cwd       || resolveSafeCwd(null);
  const force     = !!opts.force;
  const dryRun    = !!opts.dryRun;
  const fromEvents  = !!opts.fromEvents;
  const fromShipped = !!opts.fromShipped;
  // Default: run both shipped + mine (unless one exclusive flag set)
  const runShipped = fromEvents ? false : true;
  const runMine    = fromShipped ? false : true;

  const trigger = opts.trigger || 'cli';

  const sentinelPath = path.join(cwd, SENTINEL_REL);

  // Sentinel guard (skip if already seeded)
  if (!force && fs.existsSync(sentinelPath)) {
    return { seed_count: 0, mined_count: 0, merged_count: 0, skipped_count: 0 };
  }

  // Warm-cache guard (skip if cache has existing records and no force)
  if (!force && isCacheWarm(cwd)) {
    if (!dryRun) writeSentinel(cwd, dryRun);
    return { seed_count: 0, mined_count: 0, merged_count: 0, skipped_count: 0 };
  }

  const now = Date.now();

  // Load existing records (for force / merge mode)
  let existingRecords = force ? readCacheLines(cwd) : [];

  let seedCount    = 0;
  let addedCount   = 0;
  let skippedCount = 0;

  // Step 1: Merge shipped seeds
  if (runShipped) {
    const seeds = loadSeeds();
    seedCount = seeds.length;
    const result = mergeNoDowngrade(existingRecords, seeds, now);
    existingRecords = result.merged;
    addedCount      = result.addedCount;
    skippedCount    = result.skippedCount;
  }

  // Step 2: History mine pass
  let minedCount = 0;
  if (runMine) {
    minedCount = historyMinePass(cwd, existingRecords);
  }

  // Step 3: Write cache
  if (runShipped || runMine) {
    writeCacheLines(cwd, existingRecords, dryRun);
  }

  // Step 4: Write sentinel (cache write first, sentinel second)
  if (!dryRun) writeSentinel(cwd, dryRun);

  const mergedCount = addedCount;

  // Step 5: Emit audit event
  if (!dryRun) {
    try {
      writeEvent({
        type:         'archetype_cache_seeder_ran',
        version:      1,
        seed_count:   seedCount,
        mined_count:  minedCount,
        merged_count: mergedCount,
        skipped_count: skippedCount,
        trigger:      trigger,
        dry_run:      false,
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }

  return {
    seed_count:    seedCount,
    mined_count:   minedCount,
    merged_count:  mergedCount,
    skipped_count: skippedCount,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write([
    'Usage: node bin/seed-archetype-cache.js [flags]',
    '',
    'Flags:',
    '  --force         Bypass sentinel; merge seeds over existing cache',
    '  --dry-run       Print what would be written; do not write',
    '  --from-events   Mine history only (skip shipped seeds)',
    '  --from-shipped  Write shipped seeds only (skip history mine)',
    '  --help          Print this message',
    '',
    'For a clean reseed:',
    '  rm .orchestray/state/archetype-cache.jsonl',
    '  rm .orchestray/state/.archetype-seeder-done',
    '  node bin/seed-archetype-cache.js',
    '',
    'Sentinel:    .orchestray/state/.archetype-seeder-done',
    'Kill switch: ORCHESTRAY_ARCHETYPE_SEEDER_DISABLED=1',
  ].join('\n') + '\n');
}

if (require.main === module) {
  // Kill switch: env var (checked first, before any file I/O)
  if (process.env.ORCHESTRAY_ARCHETYPE_SEEDER_DISABLED === '1') {
    process.exit(0);
  }

  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const force      = args.includes('--force');
  const dryRun     = args.includes('--dry-run');
  const fromEvents  = args.includes('--from-events');
  const fromShipped = args.includes('--from-shipped');
  const isHook     = !force && !dryRun && !fromEvents && !fromShipped;
  const trigger    = isHook ? 'session_start' : 'cli';

  try {
    const cwd = resolveSafeCwd(null);

    // Config kill switch (secondary, only checked when running as hook)
    if (isSeederDisabledByConfig(cwd)) {
      process.exit(0);
    }

    const result = runSeeder({ cwd, force, dryRun, fromEvents, fromShipped, trigger });

    if (dryRun || args.length > 0) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } catch (_e) {
    // Fail-open: never block SessionStart
  }

  process.exit(0);
}

// ─── Library API (for tests) ──────────────────────────────────────────────────

module.exports = {
  runSeeder,
  mergeNoDowngrade,
  historyMinePass,
  loadSeeds,
  isCacheWarm,
  // Exposed for test overrides
  _CACHE_REL:    CACHE_REL,
  _SENTINEL_REL: SENTINEL_REL,
};
