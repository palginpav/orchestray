'use strict';

/**
 * audit-backup-sweep.js — retention sweep for `.orchestray/audit/events.jsonl.bak-*`
 * leftovers (v2.3.23).
 *
 * Why this exists
 * ----------------
 * `bin/_lib/normalize-bare-event-rows.js`'s repair path (and
 * `bin/_lib/config-repair.js`'s analogous config backup) take a timestamped
 * backup before every mutating rewrite, but neither ever removes an old one.
 * The v2.3.21 bare-event backfill left a single 10.1 MB
 * `events.jsonl.bak-<ms>` file behind with no retention policy — harmless
 * individually, unbounded accumulation over time. This module is the sweep:
 * keep the N most recent, remove the rest.
 *
 * Scope — deliberately narrow
 * ----------------------------
 * Only matches the exact `events.jsonl.bak-<digits>` shape both backup
 * writers use. Never touches:
 *   - `events.jsonl` (the live log itself)
 *   - `events.jsonl.<N>` (rotation generations — `bin/archive-orch-events.js`
 *     owns retention for those; a different filename shape entirely, no `bak-`)
 *   - `events.jsonl.pre-v222-reset-*` (a one-off migration snapshot, not a
 *     `.bak-` file — deliberately excluded by the regex requiring digits-only
 *     after `bak-`)
 *   - anything else in `.orchestray/audit/`
 *
 * Wiring
 * ------
 * Called from `bin/dark-event-banner.js`'s SessionStart handler, alongside
 * `repairBareEventRows()` — the same automatic path that already touches the
 * audit dir on every session, rather than opening a new `hooks.json` entry
 * (mirrors that module's own v2.3.21 rationale for folding related audit-dir
 * housekeeping into one already-wired hook).
 *
 * Kill switch (env + config, matching `bare_event_key_repair`'s convention)
 * ---------------------------------------------------------------------------
 *   - `ORCHESTRAY_AUDIT_BACKUP_SWEEP_DISABLED=1`
 *   - `.orchestray/config.json` -> `{"audit": {"backup_sweep": {"enabled": false}}}`
 *   Default-on per feedback_default_on_shipping.md; fail-open to enabled on
 *   any read/parse error.
 *
 * Fail-open contract
 * -------------------
 * `sweepAuditBackups()` never throws. A missing audit dir, an unreadable
 * config, or a failed unlink are all absorbed — the caller always gets a
 * result object back, never an exception.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENV_DISABLED = 'ORCHESTRAY_AUDIT_BACKUP_SWEEP_DISABLED';
const DEFAULT_RETAIN_COUNT = 3;

// Exact shape both backup writers use (normalize-bare-event-rows.js,
// config-repair.js's analogue for config.json): `<file>.bak-<epoch-ms>`.
const BACKUP_RE = /^events\.jsonl\.bak-(\d+)$/;

function isSweepDisabled(cwd) {
  if (process.env[ENV_DISABLED] === '1') return true;
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.audit && cfg.audit.backup_sweep && cfg.audit.backup_sweep.enabled === false) {
      return true;
    }
  } catch (_e) { /* fail-open: default-on */ }
  return false;
}

function loadRetainCount(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const n = cfg && cfg.audit && cfg.audit.backup_sweep && cfg.audit.backup_sweep.retain_count;
    if (Number.isInteger(n) && n >= 0) return n;
  } catch (_e) { /* fall back to default */ }
  return DEFAULT_RETAIN_COUNT;
}

/**
 * Sweep `.orchestray/audit/events.jsonl.bak-*` leftovers, keeping the
 * `retain_count` most recent (ordered by the epoch-ms timestamp encoded in
 * the filename, NOT mtime — the same value the writer stamped it with) and
 * removing the rest.
 *
 * @param {string} cwd - project root
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{
 *   ran: boolean, disabled: boolean,
 *   retained: string[], removed: string[], error: string|null,
 * }}
 */
function sweepAuditBackups(cwd, opts) {
  opts = opts || {};
  const result = { ran: false, disabled: false, retained: [], removed: [], error: null };

  try {
    if (isSweepDisabled(cwd)) {
      result.disabled = true;
      return result;
    }

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    let entries;
    try {
      entries = fs.readdirSync(auditDir);
    } catch (_e) {
      // No audit dir yet (or unreadable) — nothing to sweep, not an error.
      result.ran = true;
      return result;
    }

    const backups = [];
    for (const name of entries) {
      const m = name.match(BACKUP_RE);
      if (m) backups.push({ name, ms: Number(m[1]) });
    }

    // Newest first; tie-break on name so the ordering is deterministic.
    backups.sort((a, b) => b.ms - a.ms || b.name.localeCompare(a.name));

    const retainCount = loadRetainCount(cwd);
    const toRetain = backups.slice(0, retainCount);
    const toRemove = backups.slice(retainCount);

    result.retained = toRetain.map((b) => b.name);

    for (const b of toRemove) {
      const fp = path.join(auditDir, b.name);
      try {
        if (!opts.dryRun) fs.unlinkSync(fp);
        result.removed.push(b.name);
      } catch (err) {
        // Best-effort: one failed unlink doesn't abort the rest of the sweep.
        result.error = result.error || ('unlink failed for ' + b.name + ': ' + (err && err.message ? err.message : err));
      }
    }

    result.ran = true;
    return result;
  } catch (err) {
    // Belt-and-braces — sweepAuditBackups must never throw.
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

module.exports = {
  sweepAuditBackups,
  isSweepDisabled,
  loadRetainCount,
  ENV_DISABLED,
  DEFAULT_RETAIN_COUNT,
  BACKUP_RE,
};
