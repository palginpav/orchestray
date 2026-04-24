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
      'unknown top-level key "' + key + '" in .orchestray/config.json' + hint +
        ' (silence with config_drift_silence: ["' + key + '"])'
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

function runCli() {
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

module.exports = { runDriftDetection, warnOnce, WARNED_KEYS };

if (require.main === module) {
  runCli();
}
