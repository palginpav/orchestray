#!/usr/bin/env node
'use strict';

/**
 * gate-release-completeness.js — PreToolUse:Bash hook (v2.3.12 W13 / B4).
 *
 * Fires before a Bash `git commit` whose inline message is a release commit
 * (`release: vX.Y.Z`). Enforces that the release commit is COMPLETE before it
 * lands — the recurring class of user corrections (README not swept, CHANGELOG
 * missing/with deferral language, version files out of parity, publish forgotten).
 *
 * Checks (all on the about-to-be-committed state):
 *   1. version parity   — package.json version === VERSION === message version.
 *   2. CHANGELOG present — CHANGELOG.md has an entry for the release version.
 *   3. no-deferral       — that CHANGELOG section has no deferral language.
 *   4. README sweep      — README.md is staged (git diff --cached), unless
 *                          acked via `--no-readme-change` in the command or
 *                          env ORCHESTRAY_RELEASE_NO_README=1.
 *   5. publish ack (info)— if ORCHESTRAY_RELEASE_PUBLISH_ACK matches the version,
 *                          note it; absence does NOT block (publish stays an
 *                          explicit per-release operator action). The gate NEVER
 *                          runs `npm publish`.
 *
 * Semantics:
 *   exit 2  → one or more checks failed; the commit is blocked, stderr lists why.
 *   exit 0  → not a release commit, kill-switched, or all checks pass.
 *
 * Fail-open ONLY on infrastructure errors (no stdin, cwd unresolved, parse
 * failure). Real check failures fail CLOSED (block) — that is the point.
 *
 * Kill switch: ORCHESTRAY_RELEASE_GATE_DISABLED=1.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveSafeCwd } = require('../_lib/resolve-project-cwd');
const { writeEvent } = require('../_lib/audit-event-writer');
const { recordDegradation } = require('../_lib/degraded-journal');
// v2.3.12 W13 follow-up (review F1): reuse the canonical deferral detector so
// release-gate detection matches the SubagentStop no-deferral firewall exactly.
// Its strict/non-strict logic only flags the noisy phrases ("for now", "punt")
// when a release cue sits within the context window — avoiding false-blocks on
// benign CHANGELOG prose like "supported for now".
const { findDeferral } = require('../validate-no-deferral');
const { readHookInputRaw } = require('../_lib/hook-stdin');

function readStdin() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = readHookInputRaw();
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function getCommand(payload) {
  const ti = payload && payload.tool_input;
  if (ti && typeof ti.command === 'string') return ti.command;
  return null;
}

/**
 * Extract the release version from an inline `-m`/`--message` release commit.
 * Returns the X.Y.Z string, or null when the command is not a recognizable
 * inline release commit.
 *
 * F-RT-05: also matches combined short-flag clusters that include -m, such as
 * `git commit -am "release: v1.2.3"` (where -am combines -a and -m). The prior
 * regex required a standalone `-m ` token and missed combined forms entirely.
 */
function extractReleaseVersion(command) {
  if (typeof command !== 'string') return null;
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(command)) return null;
  // Inline message only (cannot read -F file contents from here).
  // Matches -m, -am, -mFOO (no-space form), or any short-flag cluster
  // ending in m, followed by optional whitespace/quotes and the release prefix.
  const m = command.match(/-[a-zA-Z]*m\s*['"]?\s*release:\s*v?(\d+\.\d+\.\d+)/i);
  return m ? m[1] : null;
}

// W7 (v2.3.31): emit an audit event on refusal so an operator can reconstruct
// whether a release commit was actually blocked. Fail-open on the emit itself
// — an audit-write failure must never turn this gate into a broken one
// (matches bin/gate-developer-git.js:648-663).
function emitAuditEvent(cwd, record) {
  try {
    const safeCwd = resolveSafeCwd(cwd);
    writeEvent(record, { cwd: safeCwd });
  } catch (err) {
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'gate-release-completeness', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) {}
  }
}

function readFileSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch (_e) { return null; }
}

/** Extract the CHANGELOG section body for a version heading. */
function changelogSection(changelog, version) {
  if (!changelog) return null;
  const lines = changelog.split('\n');
  // Find a heading line containing the version (e.g. "## v2.3.12" / "## [2.3.12]").
  const verRe = new RegExp('(^|\\s|\\[|v)' + version.replace(/\./g, '\\.') + '(\\s|\\]|$)');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i]) && verRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Staged file list via `git diff --cached --name-only` (bounded). null on error. */
function stagedFiles(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_e) {
    return null;
  }
}

function main() {
  if (process.env.ORCHESTRAY_RELEASE_GATE_DISABLED === '1') process.exit(0);

  const payload = readStdin();
  if (!payload) process.exit(0); // no payload → fail open (infrastructure)

  const command = getCommand(payload);
  const version = extractReleaseVersion(command);
  if (!version) {
    // Surface a non-blocking note when the command looks like a release commit
    // but cannot be verified: either the message is in a file (-F/--file) or
    // the command has a recognisable release pattern that our regex could not
    // fully parse (e.g. heredoc, unusual quoting, env-variable expansion).
    // F-RT-05: broadened from -F-only to any plausible-but-unparseable release commit.
    if (typeof command === 'string' && /\bgit\b[\s\S]*\bcommit\b/.test(command)) {
      const isFileFlag = /(?:^|\s)(?:-F\b|--file\b)/.test(command) && !/(?:^|\s)-m\b/.test(command);
      const hasReleaseCue = /\brelease:\s*v?\d+\.\d+\.\d+/i.test(command);
      if (isFileFlag || hasReleaseCue) {
        process.stderr.write(
          '[orchestray] gate-release-completeness: note — `git commit' +
          (isFileFlag ? ' -F/--file`' : '`') +
          ' cannot be verified for release completeness (message is not inline or could not be parsed). ' +
          'If this is a release, confirm version parity, CHANGELOG, and README sweep manually.\n'
        );
      }
    }
    process.exit(0); // not a parseable inline release commit → not applicable
  }

  let cwd;
  try { cwd = resolveSafeCwd(process.cwd()); } catch (_e) { process.exit(0); }

  const failures = [];
  const notes = [];

  // 1. Version parity.
  const pkgRaw = readFileSafe(path.join(cwd, 'package.json'));
  let pkgVersion = null;
  try { pkgVersion = pkgRaw ? JSON.parse(pkgRaw).version : null; } catch (_e) { pkgVersion = null; }
  const versionFile = readFileSafe(path.join(cwd, 'VERSION'));
  const versionFileTrim = versionFile ? versionFile.trim() : null;
  if (pkgVersion !== version) {
    failures.push(`version parity: package.json version is ${JSON.stringify(pkgVersion)}, expected ${version}.`);
  }
  // VERSION is install-generated and not tracked in every repo. Only enforce
  // parity when the file actually exists (absent ⇒ package.json is authoritative).
  if (versionFileTrim !== null && versionFileTrim !== version) {
    failures.push(`version parity: VERSION file is ${JSON.stringify(versionFileTrim)}, expected ${version}.`);
  }

  // 2 + 3. CHANGELOG present + no deferral language in this version's section.
  const changelog = readFileSafe(path.join(cwd, 'CHANGELOG.md'));
  const section = changelogSection(changelog, version);
  if (!section) {
    failures.push(`CHANGELOG.md has no entry for v${version} — add a user-facing changelog section.`);
  } else {
    const def = findDeferral(section);
    if (def.matched) {
      failures.push(`CHANGELOG v${version} section contains deferral language ("${def.phrase}") — release scope ships in full; resolve or remove it.`);
    }
  }

  // 4. README sweep (unless acked).
  const readmeAcked =
    /--no-readme-change\b/.test(command) ||
    process.env.ORCHESTRAY_RELEASE_NO_README === '1';
  if (!readmeAcked) {
    const staged = stagedFiles(cwd);
    if (staged === null) {
      // git unavailable / not a repo / timeout — inconclusive, do not block.
      notes.push('README sweep check skipped (could not read staged files).');
    } else if (!staged.some(f => f === 'README.md' || f.endsWith('/README.md'))) {
      failures.push('README.md is not staged in this release commit — sweep it for new user-visible surface, or ack with `--no-readme-change` (ORCHESTRAY_RELEASE_NO_README=1).');
    }
  }

  // 5. publish ack (informational only — never blocks, never publishes).
  if (process.env.ORCHESTRAY_RELEASE_PUBLISH_ACK === version) {
    notes.push(`npm publish acknowledged for v${version} (ORCHESTRAY_RELEASE_PUBLISH_ACK).`);
  } else {
    notes.push(`Reminder: npm publish for v${version} is a separate explicit step (gate never publishes).`);
  }

  if (failures.length > 0) {
    emitAuditEvent(cwd, {
      timestamp: new Date().toISOString(),
      type: 'release_completeness_blocked',
      hook: 'gate-release-completeness',
      version,
      rule_id: 'release_completeness_failed',
      failures,
      session_id: (payload && payload.session_id) || null,
    });
    process.stderr.write(
      '[orchestray] gate-release-completeness: BLOCKED — release commit for v' + version + ' is incomplete:\n' +
      failures.map(f => '  - ' + f).join('\n') + '\n' +
      (notes.length ? notes.map(n => '  · ' + n).join('\n') + '\n' : '') +
      'Kill switch: ORCHESTRAY_RELEASE_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({ continue: false, reason: 'release_completeness_failed' }));
    process.exit(2);
  }

  // All checks pass.
  if (notes.length) process.stderr.write('[orchestray] gate-release-completeness: OK (v' + version + ').\n' + notes.map(n => '  · ' + n).join('\n') + '\n');
  process.exit(0);
}

// Exported for tests.
module.exports = { extractReleaseVersion, changelogSection, findDeferral };

if (require.main === module) {
  main();
}
