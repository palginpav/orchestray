#!/usr/bin/env node
'use strict';

/**
 * audit-housekeeper-drift.js — SessionStart hook (P3.3, v2.2.0, Clause 3).
 *
 * Compares current `agents/orchestray-housekeeper.md` SHA-256 + `tools:`
 * line against the baseline pinned in `bin/_lib/_housekeeper-baseline.js`.
 * On mismatch:
 *   - Emits `housekeeper_drift_detected` audit event.
 *   - Writes quarantine sentinel `.orchestray/state/housekeeper-quarantined`
 *     so `bin/gate-agent-spawn.js` refuses housekeeper spawns until resolved.
 *   - Writes a stderr warning visible to the user.
 *
 * Missing baseline → emits `housekeeper_baseline_missing` AND writes the
 * sentinel (fail-CLOSED).
 *
 * Hook itself ALWAYS exits 0 (so SessionStart is never blocked by housekeeper
 * bookkeeping). The fail-CLOSED behavior is enforced by gate-agent-spawn.js
 * which reads the quarantine sentinel.
 *
 * Kill switches (Clause 5):
 *   - `haiku_routing.housekeeper_enabled === false` → no-op
 *   - `ORCHESTRAY_HOUSEKEEPER_DISABLED=1` → no-op
 *
 * Stdin: standard SessionStart hook payload (we don't use it).
 * Stdout: nothing.
 * Stderr: warning lines on drift.
 * Exit: always 0.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { writeEvent } = require('./_lib/audit-event-writer');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const AGENT_FILE_REL = path.join('agents', 'orchestray-housekeeper.md');
const SENTINEL_REL = path.join('.orchestray', 'state', 'housekeeper-quarantined');

function quarantineSentinel(cwd) {
  return path.join(cwd, SENTINEL_REL);
}

function writeSentinel(cwd, reason) {
  try {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(quarantineSentinel(cwd), JSON.stringify({
      reason,
      ts: new Date().toISOString(),
    }), 'utf8');
    return true;
  } catch (_e) { /* fail-open */ return false; }
}

function clearSentinel(cwd) {
  try { fs.unlinkSync(quarantineSentinel(cwd)); }
  catch (_e) { /* ENOENT or any error — silent */ }
}

function loadConfigEnabled(cwd) {
  // Default-on per locked-scope D-5: if config is missing, malformed, or
  // doesn't say `false`, treat as enabled.
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.haiku_routing &&
        cfg.haiku_routing.housekeeper_enabled === false) {
      return false;
    }
  } catch (_e) { /* fail-open: default-on */ }
  return true;
}

function extractToolsLine(body) {
  const m = body.match(/^tools:\s*\[.*\]$/m);
  return m ? m[0] : null;
}

function runDriftCheck(cwd) {
  // Kill-switch short-circuit (Clause 5)
  if (process.env.ORCHESTRAY_HOUSEKEEPER_DISABLED === '1') return;
  if (!loadConfigEnabled(cwd)) return;

  // Locate baseline RELATIVE TO CWD so test sandboxes (which copy the
  // baseline into a tmp tree) are honored. Falls back to the script-relative
  // path when no cwd-side file exists, so production sessions still work.
  //
  // F-002 (v2.2.0 fix-pass): emit `reason` as a documented enum
  // (`missing|unreadable|malformed`) plus `baseline_path` and
  // `quarantine_sentinel_written` per the schema row at
  // agents/pm-reference/event-schemas.md §`housekeeper_baseline_missing`.
  // The original `baseline_module_unavailable` opaque string carried no
  // analytical signal; the trichotomy distinguishes deletion from corruption
  // from contract drift.
  const BASELINE_REL = path.join('bin', '_lib', '_housekeeper-baseline.js');
  let baseline;
  let baselineLoadError = null;
  let baselineReason = null;
  try {
    const cwdBaseline = path.join(cwd, BASELINE_REL);
    let resolvedBaselinePath;
    let cwdBaselineExists = false;
    try { cwdBaselineExists = fs.existsSync(cwdBaseline); } catch (_e) { /* fail-open */ }
    if (cwdBaselineExists) {
      resolvedBaselinePath = cwdBaseline;
    } else {
      // Production fallback: load from where this script lives.
      resolvedBaselinePath = path.resolve(__dirname, '_lib', '_housekeeper-baseline.js');
    }

    // Distinguish "file missing on disk" (reason: missing) from "require()
    // failed" (reason: unreadable). The fallback path means a missing
    // cwd-side baseline alone is not enough — both must be absent.
    let resolvedExists = false;
    try { resolvedExists = fs.existsSync(resolvedBaselinePath); } catch (_e) { /* fail-open */ }
    if (!resolvedExists) {
      baselineReason = 'missing';
      throw new Error('baseline file not present at ' + resolvedBaselinePath);
    }

    // Bust require cache so tests with multiple sandboxes get fresh modules.
    try { delete require.cache[require.resolve(resolvedBaselinePath)]; } catch (_e) { /* ignore */ }
    try {
      baseline = require(resolvedBaselinePath);
    } catch (requireErr) {
      baselineReason = 'unreadable';
      throw requireErr;
    }
    if (!baseline || typeof baseline.BASELINE_AGENT_SHA !== 'string' ||
        typeof baseline.BASELINE_TOOLS_LINE !== 'string') {
      baselineReason = 'malformed';
      throw new Error('baseline module exports missing fields');
    }
  } catch (e) {
    baselineLoadError = e;
    if (!baselineReason) baselineReason = 'unreadable';
    // Fail-CLOSED: emit + sentinel + stderr.
    const sentinelWritten = writeSentinel(cwd, 'baseline_missing');
    writeEvent({
      version: 1,
      type: 'housekeeper_baseline_missing',
      hook: 'audit-housekeeper-drift',
      baseline_path: BASELINE_REL,
      reason: baselineReason,
      quarantine_sentinel_written: sentinelWritten === true,
      detail: String(e && e.message ? e.message : e).slice(0, 200),
    }, { cwd });
    process.stderr.write(
      '[orchestray] audit-housekeeper-drift: baseline missing — ' +
      'spawns quarantined. Restore bin/_lib/_housekeeper-baseline.js.\n'
    );
    return;
  }

  // Locate the agent file.
  const agentPath = path.join(cwd, AGENT_FILE_REL);
  if (!fs.existsSync(agentPath)) {
    writeEvent({
      version: 1,
      type: 'housekeeper_drift_detected',
      hook: 'audit-housekeeper-drift',
      previous_sha: baseline.BASELINE_AGENT_SHA,
      current_sha: null,
      previous_tools: baseline.BASELINE_TOOLS_LINE,
      current_tools: null,
      reason: 'agent_file_missing',
    }, { cwd });
    writeSentinel(cwd, 'agent_file_missing');
    process.stderr.write(
      '[orchestray] audit-housekeeper-drift: agents/orchestray-housekeeper.md ' +
      'missing — housekeeper spawns quarantined.\n'
    );
    return;
  }

  // Compute current SHA + tools-line.
  let body;
  try { body = fs.readFileSync(agentPath, 'utf8'); }
  catch (e) {
    process.stderr.write(
      '[orchestray] audit-housekeeper-drift: agent file unreadable (' +
      String(e && e.message) + '); skipping check\n'
    );
    return;
  }

  const currentSha = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const currentTools = extractToolsLine(body);
  const shaDrift = currentSha !== baseline.BASELINE_AGENT_SHA;
  const toolsDrift = currentTools !== baseline.BASELINE_TOOLS_LINE;

  if (shaDrift || toolsDrift) {
    let reason;
    if (shaDrift && toolsDrift) reason = 'sha_and_tools';
    else if (shaDrift) reason = 'sha_only';
    else reason = 'tools_only';

    writeEvent({
      version: 1,
      type: 'housekeeper_drift_detected',
      hook: 'audit-housekeeper-drift',
      previous_sha: baseline.BASELINE_AGENT_SHA,
      current_sha: currentSha,
      previous_tools: baseline.BASELINE_TOOLS_LINE,
      current_tools: currentTools,
      reason,
    }, { cwd });
    writeSentinel(cwd, reason);
    process.stderr.write(
      '[orchestray] audit-housekeeper-drift: drift detected (' + reason + ') — ' +
      'spawns quarantined until baseline updated. Resolve via a commit ' +
      'tagged [housekeeper-tools-extension] updating agents/orchestray-housekeeper.md ' +
      'AND bin/_lib/_housekeeper-baseline.js together.\n'
    );
    return;
  }

  // No drift — recovery: clear sentinel if present.
  clearSentinel(cwd);
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => { process.exit(0); });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      // Don't block SessionStart on giant payload — drop and exit 0.
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let cwd;
    try {
      let parsed = {};
      try { parsed = input ? JSON.parse(input) : {}; } catch (_) { parsed = {}; }
      cwd = resolveSafeCwd(parsed && parsed.cwd);
    } catch (_) { cwd = process.cwd(); }

    try { runDriftCheck(cwd); }
    catch (e) {
      // Last-resort: never let SessionStart fail because of bookkeeping.
      try {
        process.stderr.write(
          '[orchestray] audit-housekeeper-drift: unexpected error (' +
          String(e && e.message) + '); failing open\n'
        );
      } catch (_e) { /* ignore */ }
    }

    process.exit(0);
  });
}

module.exports = {
  runDriftCheck,
  quarantineSentinel,
  extractToolsLine,
  loadConfigEnabled,
};

if (require.main === module) {
  main();
}
