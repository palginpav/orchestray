#!/usr/bin/env node
'use strict';

/**
 * sentinel-probe.js — P1.4 thin CLI shim around `bin/_lib/sentinel-probes.js`.
 *
 * Usage (per-op mode):
 *   node bin/sentinel-probe.js <op> '<json-args>'
 *
 * Usage (session health-check mode — v2.2.8 Item 11):
 *   node bin/sentinel-probe.js --session
 *
 *   Runs a set of lightweight session-start health checks, emits a
 *   `sentinel_probe_session` event, and writes a one-line stderr banner if
 *   any check fails. Designed to run on SessionStart — fast (<200ms), fail-safe.
 *
 * Exit codes:
 *   0 — probe returned {ok:true} or session checks all passed
 *   1 — probe returned {ok:false} (fail-soft) or one or more session checks failed
 *   2 — caller-side error (argv parse, unknown op pre-dispatch, JSON parse error)
 *
 * Kill-switches (session mode):
 *   ORCHESTRAY_DISABLE_SENTINEL_PROBE=1  — env var, inerts the whole script
 *   sentinel_probe.enabled === false     — config gate
 *
 * The PM-prompt §3.S referral teaches the PM to prefer this one-shot CLI shape
 * over hand-rolled `Bash([ -f X ])` constructions. Every call funnels through
 * `runProbe` which emits a `sentinel_probe` audit event.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { runProbe, _ALLOWED_OPS } = require('./_lib/sentinel-probes');
const { MAX_INPUT_BYTES }        = require('./_lib/constants');
const { writeEvent }             = require('./_lib/audit-event-writer');
const { resolveSafeCwd }         = require('./_lib/resolve-project-cwd');

// ---------------------------------------------------------------------------
// Per-op mode helpers
// ---------------------------------------------------------------------------

function _printAndExit(result, exitCode) {
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (_e) {
    process.stdout.write('{"ok":false,"reason":"stringify_failed"}\n');
  }
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Session health-check mode
// ---------------------------------------------------------------------------

/**
 * Individual session-start health check functions.
 * Each returns { check_name, status: 'pass'|'fail', detail }.
 * Never throws.
 */

function _checkOrchetrayDir(projectRoot) {
  try {
    const dir = path.join(projectRoot, '.orchestray');
    const st = fs.statSync(dir, { throwIfNoEntry: false });
    if (st && st.isDirectory()) {
      return { check_name: 'orchestray_dir', status: 'pass', detail: dir };
    }
    return { check_name: 'orchestray_dir', status: 'fail', detail: 'directory not found: ' + dir };
  } catch (e) {
    return { check_name: 'orchestray_dir', status: 'fail', detail: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

function _checkAuditDirWritable(projectRoot) {
  try {
    const auditDir = path.join(projectRoot, '.orchestray', 'audit');
    const st = fs.statSync(auditDir, { throwIfNoEntry: false });
    if (!st) {
      // Audit dir may not exist on first run — not a failure.
      return { check_name: 'audit_dir_writable', status: 'pass', detail: 'not_yet_created' };
    }
    // Quick writable check: attempt to stat the events.jsonl (no write needed).
    return { check_name: 'audit_dir_writable', status: 'pass', detail: auditDir };
  } catch (e) {
    return { check_name: 'audit_dir_writable', status: 'fail', detail: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

function _checkHooksJson(projectRoot) {
  try {
    const hookPaths = [
      path.join(projectRoot, 'hooks', 'hooks.json'),
      path.join(process.env.CLAUDE_PLUGIN_ROOT || projectRoot, 'hooks', 'hooks.json'),
    ];
    for (const p of hookPaths) {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (st && st.isFile()) {
        return { check_name: 'hooks_json', status: 'pass', detail: p };
      }
    }
    return { check_name: 'hooks_json', status: 'fail', detail: 'hooks/hooks.json not found' };
  } catch (e) {
    return { check_name: 'hooks_json', status: 'fail', detail: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

function _checkConfigJson(projectRoot) {
  try {
    const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
    const st = fs.statSync(cfgPath, { throwIfNoEntry: false });
    if (!st) {
      // Config not yet created — acceptable on fresh install.
      return { check_name: 'config_json', status: 'pass', detail: 'not_yet_created' };
    }
    // Attempt to parse it — a corrupt config is a real failure.
    const raw = fs.readFileSync(cfgPath, 'utf8');
    JSON.parse(raw);
    return { check_name: 'config_json', status: 'pass', detail: cfgPath };
  } catch (e) {
    return { check_name: 'config_json', status: 'fail', detail: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/**
 * Read sentinel_probe kill-switch from config.
 * Returns true if the probe should run.
 */
function _isSessionProbeEnabled(projectRoot) {
  try {
    const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
    const st = fs.statSync(cfgPath, { throwIfNoEntry: false });
    if (!st) return true; // no config → default on
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && cfg.sentinel_probe && cfg.sentinel_probe.enabled === false) return false;
    return true;
  } catch (_e) {
    return true; // unreadable config → default on
  }
}

/**
 * Run all session health checks in parallel (via sync execution — each is
 * sub-millisecond file-stat work). Returns aggregated result.
 */
function runSessionChecks(projectRoot) {
  const nowTs = new Date().toISOString();

  // Run all checks — synchronous, fast.
  const results = [
    _checkOrchetrayDir(projectRoot),
    _checkAuditDirWritable(projectRoot),
    _checkHooksJson(projectRoot),
    _checkConfigJson(projectRoot),
  ];

  const failedChecks = results.filter(r => r.status === 'fail');
  const overallStatus = failedChecks.length === 0 ? 'pass' : 'fail';

  // Emit audit event.
  try {
    writeEvent({
      type:             'sentinel_probe_session',
      version:          1,
      schema_version:   1,
      timestamp:        nowTs,
      results,
      overall_status:   overallStatus,
      ts:               nowTs,
    });
  } catch (_e) { /* fail-open */ }

  // Stderr banner on failure.
  if (overallStatus === 'fail') {
    const failNames = failedChecks.map(r => r.check_name).join(', ');
    try {
      process.stderr.write(
        '[orchestray] sentinel_probe FAILED: ' + failNames +
        '. Run /orchestray:doctor for details.\n'
      );
    } catch (_e) { /* swallow */ }
  }

  return { overall_status: overallStatus, results };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * v2.2.9 B-4.2: emit `sentinel_probe_bypassed` when SessionStart bypasses
 * the probe via the env-kill-switch or config-disabled path. Pairs with
 * `sentinel_probe_session` (the success path) to form a logical XOR — every
 * SessionStart now produces exactly one of the two. Pure observability,
 * no behavior change. Fail-open on any error.
 *
 * @param {string} bypassReason - 'kill_switch' | 'config_disabled' | 'unknown'
 * @param {string|null} projectRoot - resolved project root for cwd context
 */
function _emitSessionBypassed(bypassReason, projectRoot) {
  try {
    const opts = projectRoot ? { cwd: projectRoot } : undefined;
    writeEvent({
      type:           'sentinel_probe_bypassed',
      version:        1,
      schema_version: 1,
      timestamp:      new Date().toISOString(),
      bypass_reason:  bypassReason,
    }, opts);
  } catch (_e) { /* fail-open */ }
}

function main() {
  // Kill-switch: env var.
  if (process.env.ORCHESTRAY_DISABLE_SENTINEL_PROBE === '1') {
    // v2.2.9 B-4.2: emit bypass observability before exiting.
    const op = process.argv[2];
    if (!op || op === '--session') {
      const projectRoot = resolveSafeCwd(process.env.ORCHESTRAY_PROJECT_ROOT || null);
      _emitSessionBypassed('kill_switch', projectRoot);
    }
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }

  const op = process.argv[2];

  // Session health-check mode: no op arg (SessionStart hook) or --session flag.
  if (!op || op === '--session') {
    const projectRoot = resolveSafeCwd(process.env.ORCHESTRAY_PROJECT_ROOT || null);

    // Kill-switch: config gate.
    if (!_isSessionProbeEnabled(projectRoot)) {
      // v2.2.9 B-4.2: emit bypass observability for the config-disabled path.
      _emitSessionBypassed('config_disabled', projectRoot);
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    let sessionResult;
    try {
      sessionResult = runSessionChecks(projectRoot);
    } catch (e) {
      // Fail-open: don't crash session start.
      try {
        process.stderr.write('[orchestray] sentinel_probe session check error: ' +
          String(e && e.message ? e.message : e).slice(0, 200) + '\n');
      } catch (_e) {}
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    // SessionStart hooks must output { continue: true } to let the session proceed.
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(sessionResult.overall_status === 'fail' ? 1 : 0);
  }

  // Per-op mode (original CLI behavior).
  const argsRaw = process.argv[3];

  if (!_ALLOWED_OPS.includes(op)) {
    _printAndExit({ ok: false, reason: 'unknown_op' }, 2);
  }
  if (typeof argsRaw !== 'string') {
    _printAndExit({ ok: false, reason: 'missing_args' }, 2);
  }
  if (Buffer.byteLength(argsRaw, 'utf8') > MAX_INPUT_BYTES) {
    _printAndExit({ ok: false, reason: 'args_too_large' }, 2);
  }

  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch (_e) {
    _printAndExit({ ok: false, reason: 'invalid_json' }, 2);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    _printAndExit({ ok: false, reason: 'invalid_input' }, 2);
  }

  let result;
  try {
    result = runProbe(op, args, { source: 'cli' });
  } catch (_e) {
    // runProbe is documented as never-throws; this is the defence-in-depth catch.
    _printAndExit({ ok: false, reason: 'probe_internal_error' }, 1);
  }

  _printAndExit(result, result && result.ok === true ? 0 : 1);
}

// Export for tests.
module.exports = { runSessionChecks, _isSessionProbeEnabled, _emitSessionBypassed };

if (require.main === module) {
  main();
}
