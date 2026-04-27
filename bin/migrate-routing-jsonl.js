#!/usr/bin/env node
'use strict';

/**
 * v2.2.3 P0-1 Fix B — routing.jsonl auto-seed migrator.
 *
 * Reads `.orchestray/state/routing.jsonl` and PURGES entries where the seeded
 * model conflicts with the agent's frontmatter `model:` declaration.
 *
 * Background: pre-v2.2.3 the resolver's `CANONICAL_AGENTS_ALLOWLIST` excluded
 * the four Haiku-default agents (haiku-scout, orchestray-housekeeper,
 * project-intent, pattern-extractor). When PM omitted the `model:` parameter,
 * Stage-1 routing.jsonl missed (no entry yet) → Stage-2 frontmatter read was
 * skipped (allowlist miss) → Stage-3 defaulted to sonnet → auto-seeded
 * routing.jsonl with `sonnet` for that agent_type. Subsequent spawns hit
 * Stage-1, found the seeded sonnet, locked sonnet permanently. Self-amplifying.
 *
 * Even after the v2.2.3 resolver fix lands, every install carries poisoned
 * routing.jsonl entries from pre-fix runs. This migrator runs once per session
 * (via SessionStart hook) and removes the stale entries so the resolver gets
 * a fresh chance at frontmatter resolution.
 *
 * Behavior:
 * - Reads `.orchestray/state/routing.jsonl` (if absent, exits 0).
 * - For each entry, reads `agents/<entry.agent_type>.md` frontmatter (if absent
 *   or unreadable, KEEPS the entry — fail-safe).
 * - If frontmatter `model:` is a concrete tier (haiku/sonnet/opus, not inherit)
 *   and entry.model differs, PURGE the entry and emit a
 *   `routing_jsonl_migrator_purge` audit event.
 * - Writes the surviving entries back atomically (tmp + rename).
 * - Exit 0 always (fail-open). Errors are logged to stderr.
 *
 * Idempotent: running twice on the same file is a no-op the second time.
 *
 * Per `feedback_default_on_shipping.md`: ships default-on, no flag to opt out.
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');

const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

function isValidModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();
  return VALID_TIERS.some(tier => m.includes(tier));
}

function normalizeTier(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  return VALID_TIERS.find(tier => m.includes(tier)) || null;
}

/**
 * Read agent frontmatter `model:` field, or null if not declared / inherit / invalid.
 * Mirrors Stage-2 of `bin/gate-agent-spawn.js`.
 */
function readAgentFrontmatterModel(cwd, agentType) {
  if (!agentType || typeof agentType !== 'string') return null;
  // Reject path-traversal attempts. The agent_type field is operator-supplied
  // (via the PM's Agent() call). Same defense as gate-agent-spawn.js Stage-2.
  if (agentType.includes('/') || agentType.includes('\\') || agentType.includes('..')) {
    return null;
  }
  const candidatePath = path.join(cwd, 'agents', agentType + '.md');
  const relCheck = path.relative(path.join(cwd, 'agents'), candidatePath);
  if (relCheck.startsWith('..')) return null;
  if (!fs.existsSync(candidatePath)) return null;
  let content;
  try {
    content = fs.readFileSync(candidatePath, 'utf8');
  } catch (_e) {
    return null;
  }
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fmBlock = fmMatch[1];
  const modelMatch = fmBlock.match(/^model:\s*(.+)$/m);
  if (!modelMatch) return null;
  const fmModel = modelMatch[1].trim();
  if (!isValidModel(fmModel)) return null;
  if (fmModel === 'inherit') return null;
  return normalizeTier(fmModel);
}

/**
 * Migrate routing.jsonl in the given cwd. Returns a summary object.
 * { total, purged, kept, frontmatterMisses, sentinelWritten }
 */
function migrate(cwd) {
  const routingPath = path.join(cwd, '.orchestray', 'state', 'routing.jsonl');
  const sentinelPath = path.join(cwd, '.orchestray', 'state', '.routing-jsonl-migrated-v223');
  const result = {
    total: 0, purged: 0, kept: 0, frontmatterMisses: 0,
    sentinelWritten: false, skipped: false, reason: null,
  };

  // Sentinel: skip if already migrated this session-or-later. The sentinel is
  // a one-shot per install; once routing.jsonl has been swept, the resolver fix
  // ensures fresh entries respect frontmatter, so re-running is wasted I/O.
  if (fs.existsSync(sentinelPath)) {
    result.skipped = true;
    result.reason = 'sentinel_present';
    return result;
  }

  if (!fs.existsSync(routingPath)) {
    // No routing file → write sentinel anyway so we don't re-check next session.
    try {
      fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
      fs.writeFileSync(sentinelPath, new Date().toISOString(), 'utf8');
      result.sentinelWritten = true;
    } catch (_e) { /* fail-open */ }
    result.skipped = true;
    result.reason = 'no_routing_file';
    return result;
  }

  let raw;
  try {
    raw = fs.readFileSync(routingPath, 'utf8');
  } catch (e) {
    process.stderr.write('[orchestray] migrate-routing-jsonl: read error: ' + e.message + '\n');
    return result;
  }

  const lines = raw.split('\n').filter(Boolean);
  result.total = lines.length;
  const survivors = [];
  const purgedEntries = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_pe) {
      // Malformed line → keep it (don't lose data; let downstream readers decide).
      survivors.push(line);
      result.kept++;
      continue;
    }

    const agentType = entry && entry.agent_type;
    if (!agentType) {
      survivors.push(line);
      result.kept++;
      continue;
    }

    const fmTier = readAgentFrontmatterModel(cwd, agentType);
    if (fmTier === null) {
      // No frontmatter declaration (or inherit/invalid) → keep the entry.
      // This is the conservative path: only purge when frontmatter clearly
      // disagrees with the seed.
      survivors.push(line);
      result.kept++;
      result.frontmatterMisses++;
      continue;
    }

    const entryTier = normalizeTier(entry.model);
    if (entryTier === fmTier) {
      // Agreement → keep.
      survivors.push(line);
      result.kept++;
      continue;
    }

    // Disagreement → purge. Record details for audit emission.
    result.purged++;
    purgedEntries.push({
      agent_type: agentType,
      task_id: entry.task_id || null,
      orchestration_id: entry.orchestration_id || null,
      seeded_model: entryTier || (entry.model || 'unknown'),
      frontmatter_model: fmTier,
      timestamp: entry.timestamp || entry.ts || null,
    });
  }

  // Atomic write: tmp file + rename. If write fails, original is untouched.
  if (result.purged > 0) {
    const tmpPath = routingPath + '.tmp.' + process.pid;
    try {
      const out = survivors.length ? (survivors.join('\n') + '\n') : '';
      fs.writeFileSync(tmpPath, out, 'utf8');
      fs.renameSync(tmpPath, routingPath);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_eu) {}
      process.stderr.write(
        '[orchestray] migrate-routing-jsonl: write failed: ' + e.message +
        '; routing.jsonl untouched\n'
      );
      // Don't write sentinel — let the next session retry.
      return result;
    }

    // Emit one audit event per purged entry. Use the canonical writeEvent
    // helper so the event flows through dedup + tier2-index.
    try {
      const { writeEvent } = require('./_lib/audit-event-writer');
      for (const p of purgedEntries) {
        writeEvent({
          type: 'routing_jsonl_migrator_purge',
          orchestration_id: p.orchestration_id || 'unknown',
          timestamp: new Date().toISOString(),
          level: 'info',
          subagent_type: p.agent_type,
          task_id: p.task_id,
          seeded_model: p.seeded_model,
          frontmatter_model: p.frontmatter_model,
          original_entry_timestamp: p.timestamp,
          source: 'session_start_migrator',
        }, { cwd });
      }
    } catch (eEmit) {
      process.stderr.write(
        '[orchestray] migrate-routing-jsonl: audit emission failed: ' +
        (eEmit && eEmit.message) + '; purge already applied\n'
      );
    }

    process.stderr.write(
      '[orchestray] migrate-routing-jsonl: purged ' + result.purged +
      ' stale routing.jsonl entries (kept ' + result.kept + '). ' +
      'See .orchestray/audit/events.jsonl for routing_jsonl_migrator_purge entries.\n'
    );
  }

  // Write sentinel even when 0 purged — file has been verified clean.
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, new Date().toISOString(), 'utf8');
    result.sentinelWritten = true;
  } catch (_e) { /* fail-open */ }

  return result;
}

// CLI entry — exit 0 always (fail-open). Print summary on stderr only when
// non-trivial work happened (purges or errors). Silent on the common case.
if (require.main === module) {
  try {
    const cwdArg = process.argv[2] || process.cwd();
    const cwd = resolveSafeCwd(cwdArg);
    migrate(cwd);
  } catch (e) {
    process.stderr.write(
      '[orchestray] migrate-routing-jsonl: top-level error (' +
      (e && e.message) + '); failing open\n'
    );
  }
  process.exit(0);
}

module.exports = { migrate, readAgentFrontmatterModel };
