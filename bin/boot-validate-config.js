#!/usr/bin/env node
'use strict';

/**
 * bin/boot-validate-config.js — SessionStart hook wrapper around
 * `bin/validate-config.js`.
 *
 * v2.1.13 R-ZOD. Runs the zod-schema validation as a Claude Code
 * SessionStart hook. Writes a loud summary to stderr on any failure and
 * exits non-zero so the user sees the issue at session start.
 *
 * This is a thin shim so the `SessionStart` hook entry in `hooks.json` can
 * have a stable path (`bin/boot-validate-config.js`) even if the underlying
 * validator CLI's behavior (arg parsing, exit codes) evolves.
 *
 * v2.1.13 R-CONFIG-DRIFT (W9). After zod validation, runs an unknown-key /
 * renamed-key detector (bin/_lib/config-drift.js). Drift is reported as
 * WARNINGS on stderr — we do NOT fail the boot on drift. Each unknown key
 * warns at most once per boot (in-process dedup Set). Users can silence
 * specific keys via `config.config_drift_silence: ["key1", ...]`.
 *
 * Exit codes mirror validate-config.js (drift does NOT change the exit code):
 *   0 — all checks passed (drift warnings may still have been emitted)
 *   1 — at least one artifact failed zod validation
 *   2 — internal error (e.g., validator module missing, I/O, etc.)
 */

const fs = require('fs');
const path = require('path');

// Session-scoped dedup set: key = warning identity. Lives for the lifetime
// of this Node process (one SessionStart tick). No disk persistence needed —
// the dedup requirement is per-boot, and boot == one invocation of this
// script.
const WARNED_KEYS = new Set();

// ---------------------------------------------------------------------------
// Contracts hard-fail banner (v2.2.12)
//
// Fires once per install: when the installed version is >= 2.2.12 and the
// sentinel .orchestray/state/.contracts-hardfail-banner-shown does not exist.
// After printing, writes the sentinel with an ISO timestamp so subsequent
// sessions are silent. Fail-open: sentinel write failure is non-fatal.
// ---------------------------------------------------------------------------

/**
 * Compare semver strings. Returns true if `a` >= `b` (major.minor.patch only).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function semverGte(a, b) {
  const parse = (s) => String(s || '0').split('.').map(n => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch >= bPatch;
}

/**
 * Emit the contracts hard-fail upgrade banner once per install.
 * @param {string} cwd  — project root (CLAUDE_PROJECT_DIR or process.cwd())
 */
function maybeEmitContractsHardfailBanner(cwd) {
  try {
    // Read installed version from package.json
    const pkgPath = path.join(__dirname, '..', 'package.json');
    let version = '0.0.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = pkg.version || '0.0.0';
    } catch (_) { /* version stays 0.0.0 — banner won't fire */ }

    if (!semverGte(version, '2.2.12')) return;

    const sentinelPath = path.join(cwd, '.orchestray', 'state', '.contracts-hardfail-banner-shown');
    if (fs.existsSync(sentinelPath)) return;

    // Print banner to stderr
    process.stderr.write(
      '[orchestray v' + version + '] Contracts validation is now hard-fail by default.' +
      ' Set ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED=1 to revert to warn-only.\n'
    );

    // Emit telemetry event (best-effort)
    try {
      const { writeEvent } = require('./_lib/audit-event-writer');
      writeEvent({
        type:    'contracts_hardfail_banner_shown',
        version: 1,
        installed_version: version,
        schema_version: 1,
      }, { cwd });
    } catch (_) { /* fail-open */ }

    // Write sentinel (best-effort; failure still counts as "banner shown once")
    try {
      fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
      fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n', { flag: 'wx' });
    } catch (_) { /* sentinel write failed — acceptable */ }
  } catch (_) { /* entire banner path must never crash boot */ }
}

/**
 * Emit one drift warning to stderr, deduped by key.
 * @param {string} dedupKey  — stable identity of the warning (e.g. "unknown:foo")
 * @param {string} message   — full stderr line (without trailing newline)
 */
function warnOnce(dedupKey, message) {
  if (WARNED_KEYS.has(dedupKey)) return;
  WARNED_KEYS.add(dedupKey);
  process.stderr.write('[orchestray] config drift: ' + message + '\n');
}

/**
 * Run drift detection against `.orchestray/config.json` under cwd.
 * Safe to call when the file is missing or malformed — no-ops.
 *
 * @param {string} cwd
 * @returns {{ unknownCount: number, renamedCount: number }}
 */
function runDriftDetection(cwd) {
  const cfgPath = path.join(cwd, '.orchestray', 'config.json');
  if (!fs.existsSync(cfgPath)) return { unknownCount: 0, renamedCount: 0 };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (_) {
    // JSON parse errors are already reported by the zod-phase runner.
    // Drift detection cannot run on unparseable input.
    return { unknownCount: 0, renamedCount: 0 };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { unknownCount: 0, renamedCount: 0 };
  }

  const silence = Array.isArray(parsed.config_drift_silence)
    ? parsed.config_drift_silence
    : [];

  const { detectDrift } = require('./_lib/config-drift.js');
  const { unknown, renamed, suggestions } = detectDrift(parsed, { silence });

  for (const key of unknown) {
    const suggested = suggestions[key];
    const hint = suggested ? ' — did you mean "' + suggested + '"?' : '';
    warnOnce(
      'unknown:' + key,
      'unknown top-level key "' + key + '" in .orchestray/config.json' + hint + '. ' +
        'To silence, add "' + key + '" to config_drift_silence in .orchestray/config.json.'
    );
  }
  for (const r of renamed) {
    warnOnce(
      'renamed:' + r.key,
      '"' + r.key + '" is renamed to "' + r.to + '"' +
        (r.since ? ' (since ' + r.since + ')' : '') +
        ' — rename the key in .orchestray/config.json'
    );
  }

  return { unknownCount: unknown.length, renamedCount: renamed.length };
}

/**
 * §16.3 boot-validate probe: verify that the custom-agents and canonical-agents
 * library modules load without error. A require() failure at boot is much more
 * informative than a cryptic TypeError inside gate-agent-spawn mid-session.
 *
 * On failure: emits stderr error AND records kill_switch_reason so the operator
 * knows exactly which module caused the boot failure.
 *
 * Fail pattern: if either module throws, we set a module-level flag and the
 * runCli() function emits the error. We do NOT exit here — the zod validation
 * exit code takes precedence; the module error is an additional stderr warning.
 */
let _customAgentsLibError = null;
let _canonicalAgentsLibError = null;
try {
  require('./_lib/custom-agents');
} catch (e) {
  _customAgentsLibError = e;
}
try {
  require('./_lib/canonical-agents');
} catch (e) {
  _canonicalAgentsLibError = e;
}

function runCli() {
  // §16.3: emit errors for library load failures (custom-agents gate deps).
  if (_customAgentsLibError) {
    const msg = _customAgentsLibError && _customAgentsLibError.stack
      ? _customAgentsLibError.stack
      : String(_customAgentsLibError);
    process.stderr.write(
      '[orchestray] boot-validate-config: CRITICAL — _lib/custom-agents failed to load.\n' +
      '  The custom-agents gate (gate-agent-spawn.js) will be broken this session.\n' +
      '  Error: ' + msg + '\n' +
      '  Run `npm install` in the plugin directory to fix missing dependencies.\n'
    );
  }
  if (_canonicalAgentsLibError) {
    const msg = _canonicalAgentsLibError && _canonicalAgentsLibError.stack
      ? _canonicalAgentsLibError.stack
      : String(_canonicalAgentsLibError);
    process.stderr.write(
      '[orchestray] boot-validate-config: CRITICAL — _lib/canonical-agents failed to load.\n' +
      '  The custom-agents gate (gate-agent-spawn.js) will be broken this session.\n' +
      '  Error: ' + msg + '\n' +
      '  Run `npm install` in the plugin directory to fix missing dependencies.\n'
    );
  }

  try {
    const { run } = require('./validate-config.js');
    // Human-readable output in SessionStart context; use --json if the user
    // explicitly sets ORCHESTRAY_BOOT_VALIDATE_JSON=1.
    const json = process.env.ORCHESTRAY_BOOT_VALIDATE_JSON === '1';
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const code = run({ cwd, json });
    if (code !== 0) {
      process.stderr.write(
        '\n[orchestray] boot-validate-config: one or more files failed zod validation.\n' +
        '  Re-run with: node bin/validate-config.js --cwd ' + cwd + '\n' +
        '  See `.orchestray/config.json`, `.orchestray/patterns/*.md`,\n' +
        '  and `specialists/*.md` for details.\n'
      );
    }

    // Drift detection runs regardless of zod pass/fail — a drift warning
    // alongside a zod error is informative, not redundant. Drift never
    // influences the exit code.
    try {
      runDriftDetection(cwd);
    } catch (driftErr) {
      // Drift detection must NEVER take the boot down. Log and move on.
      const dmsg = driftErr && driftErr.stack ? driftErr.stack : String(driftErr);
      process.stderr.write(
        '[orchestray] boot-validate-config: drift detector internal error (ignored):\n' +
        dmsg + '\n'
      );
    }

    // Contracts hard-fail upgrade banner (v2.2.12 — once per install).
    maybeEmitContractsHardfailBanner(cwd);

    process.exit(code);
  } catch (err) {
    // Most likely cause: internal validator missing or broken.
    // Emit a targeted stderr message and exit 2 so the boot signals clearly.
    const msg = err && err.stack ? err.stack : String(err);
    process.stderr.write(
      '[orchestray] boot-validate-config internal error:\n' + msg + '\n' +
      '  Most likely cause: a schema module failed to load. Run `npm install` in the plugin directory.\n'
    );
    process.exit(2);
  }
}

module.exports = { runDriftDetection, warnOnce, WARNED_KEYS, maybeEmitContractsHardfailBanner, semverGte };

if (require.main === module) {
  runCli();
}
