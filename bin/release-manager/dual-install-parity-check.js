#!/usr/bin/env node
'use strict';

/**
 * dual-install-parity-check.js — v2.2.9 B-6.1 mechanical dual-install parity gate.
 *
 * Wires the recurring v2.2.6 / v2.2.7 / v2.2.8 dual-install footgun into a
 * mechanical SubagentStop check on the release-manager agent. Replaces the
 * previous prose-only "release-manager must verify dual-install parity"
 * convention with a hook-blocking gate.
 *
 * v2.2.15 FN-47 extension — SessionStart promotion:
 *   When invoked at SessionStart with `event.hook_event_name === 'SessionStart'`,
 *   compares `package.json#version` between the global install
 *   (`~/.claude/orchestray/`) and the local install (`.claude/orchestray/` of
 *   cwd). On version mismatch the script emits `dual_install_version_mismatch`
 *   and writes a friendly stderr advisory to surface to the operator (per
 *   `feedback_update_both_installs.md`: when both installs exist, /orchestray:update
 *   must update BOTH). It also surfaces any pending double-fire warning sentinel
 *   staged by bin/_lib/double-fire-guard.js so the user always sees the
 *   "your installs are racing" advisory exactly once.
 *
 *   Hard-block contract: SessionStart cannot interrupt a session, but the
 *   advisory is loud (stderr + structured stdout); we ALSO write the warning
 *   to `.orchestray/state/dual-install-version-mismatch.json` so subsequent
 *   release-manager spawns see it through the existing parity-check gate.
 *
 * Behavior:
 *   1. If `.claude/orchestray/bin/` does NOT exist in cwd: exit 0 with
 *      `skipped_no_install_tree` reason. Single-install repos (most CI
 *      checkouts, fresh clones, dev worktrees) never have the install tree
 *      mirrored locally; treating absence as a failure would block every
 *      such checkout from running the gate.
 *   2. Walk both `bin/` and `.claude/orchestray/bin/` recursively (every
 *      regular file, any extension). Skip a fixed allowlist of source-only
 *      artefacts that
 *      legitimately exist only in `bin/` (the installer itself, dev tooling,
 *      tests, install-time shell wrappers). Allowlist is explicit; everything
 *      else is required to round-trip.
 *   3. For every file present in `.claude/orchestray/bin/` but not in `bin/`:
 *      emit `dual_install_divergence_detected` with
 *      `divergence_type: "orphan"`. (We do not flag the reverse — files only
 *      in source are fine; the installer hasn't shipped them yet, that is
 *      not a parity violation.)
 *   4. For every file present in BOTH but with different SHA-256 hashes:
 *      emit `dual_install_divergence_detected` with
 *      `divergence_type: "content_mismatch"`.
 *   5. Exit 0 if zero divergences. Exit 2 if any. Stderr lists the offending
 *      files.
 *
 * Wiring (per v2.2.9 mechanisation plan §B-6.1):
 *   - SubagentStop hook on the release-manager agent (this script reads
 *     `subagent_type` from the hook payload and only acts when role matches).
 *   - Manual invocation (no payload) is allowed and runs the same check
 *     unconditionally — useful for `bin/install.js` pre-publish validation
 *     and for `npm test` style gates.
 *
 * Kill switch:
 *   - `ORCHESTRAY_DUAL_INSTALL_CHECK_DISABLED=1` is honored ONLY for non-
 *     release SubagentStop invocations. The flag does NOT bypass the
 *     release-manager gate — releases must always parity-check (this is
 *     scope-lock #3 of v2.2.9: "mechanically enforced, not assumed").
 *
 * Exit codes:
 *   0 — no divergences, or skipped (no install tree, or non-release with
 *       kill switch set).
 *   2 — divergences found AND blocking is in effect.
 *   1 — internal error (e.g. unreadable file). Fail-closed when in release
 *       context, fail-open otherwise.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { writeEvent } = require('../_lib/audit-event-writer');
const { resolveSafeCwd } = require('../_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('../_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('../_lib/constants');
const { loadDualInstallConfig } = require('../_lib/config-schema');

const RELEASE_MANAGER_ROLE = 'release-manager';

// Files / directories that legitimately exist only in `bin/` and must NOT
// be flagged as parity violations when absent from `.claude/orchestray/bin/`.
// These are the install-time and dev-time artefacts the v2.2.9 mechanisation
// plan §B-6.1 enumerates as expected source-only items.
const SOURCE_ONLY_ALLOWLIST = new Set([
  'install.js',
  'install-pre-commit-guard.sh',
  'replay-last-n.sh',
  // Dev-only directories — entries under these prefixes are skipped wholesale.
]);
const SOURCE_ONLY_DIR_PREFIXES = [
  '__tests__/',
  '_tools/',
  'learn-commands/',
  '_lib/__tests__/',
  'release-manager/',  // this gate itself + future release-manager helpers
];

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively, returning a Map of relative-path → absolute-path
 * for every regular file. Symlinks are followed to their target only if the
 * target is also a regular file inside the same root (defence against symlink
 * escapes). Returns an empty Map if the root does not exist.
 */
function walkTree(rootAbs) {
  const out = new Map();
  if (!rootAbs || !fs.existsSync(rootAbs)) return out;

  function recurse(dirAbs, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const ent of entries) {
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        recurse(childAbs, childRel);
      } else if (ent.isFile()) {
        out.set(childRel, childAbs);
      } else if (ent.isSymbolicLink()) {
        // Resolve and ensure target is a regular file inside the same root.
        try {
          const realPath = fs.realpathSync(childAbs);
          if (realPath.startsWith(rootAbs + path.sep) && fs.statSync(realPath).isFile()) {
            out.set(childRel, realPath);
          }
        } catch (_e) { /* skip broken symlinks */ }
      }
    }
  }

  recurse(rootAbs, '');
  return out;
}

function isSourceOnlyAllowed(relPath) {
  if (SOURCE_ONLY_ALLOWLIST.has(relPath)) return true;
  for (const prefix of SOURCE_ONLY_DIR_PREFIXES) {
    if (relPath === prefix.replace(/\/$/, '') || relPath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function sha256OfFile(absPath) {
  const h = crypto.createHash('sha256');
  const data = fs.readFileSync(absPath);
  h.update(data);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Core diff
// ---------------------------------------------------------------------------

/**
 * Compare bin/ vs .claude/orchestray/bin/ for the given cwd.
 *
 * @param {string} cwd
 * @returns {{
 *   skipped:       boolean,
 *   skip_reason:   string|null,
 *   divergences:   Array<{
 *     file_path:        string,
 *     divergence_type:  'orphan' | 'content_mismatch',
 *     source_hash:      string|null,
 *     target_hash:      string|null,
 *   }>
 * }}
 */
function checkParity(cwd) {
  const sourceRoot = path.join(cwd, 'bin');
  const targetRoot = path.join(cwd, '.claude', 'orchestray', 'bin');

  if (!fs.existsSync(targetRoot)) {
    return { skipped: true, skip_reason: 'no_install_tree', divergences: [] };
  }
  if (!fs.existsSync(sourceRoot)) {
    return { skipped: true, skip_reason: 'no_source_tree', divergences: [] };
  }

  const sourceFiles = walkTree(sourceRoot);
  const targetFiles = walkTree(targetRoot);

  const divergences = [];

  // Pass 1: orphans in target (present in install, absent from source).
  for (const [relPath, _abs] of targetFiles) {
    if (sourceFiles.has(relPath)) continue;
    // Allowlist source-only artefacts when checking the reverse — but here
    // we only flag target-side orphans, so the allowlist doesn't apply.
    let targetHash = null;
    try { targetHash = sha256OfFile(targetFiles.get(relPath)); }
    catch (_e) { /* hash unreadable; still flag as orphan */ }
    divergences.push({
      file_path: relPath,
      divergence_type: 'orphan',
      source_hash: null,
      target_hash: targetHash,
    });
  }

  // Pass 2: content-hash mismatches for files present in both.
  for (const [relPath, sourceAbs] of sourceFiles) {
    if (!targetFiles.has(relPath)) continue;
    // Honor SOURCE_ONLY_ALLOWLIST in pass 2 (mirrors pass 1 skip logic).
    // Info #12 (v2.2.19 audit-fix R1): source-only files (e.g. install.js)
    // and dev-only directory contents (e.g. __tests__/, _tools/) legitimately
    // differ between source tree and install tree — they must not be flagged
    // as content mismatches.
    if (isSourceOnlyAllowed(relPath)) continue;
    let sourceHash, targetHash;
    try {
      sourceHash = sha256OfFile(sourceAbs);
      targetHash = sha256OfFile(targetFiles.get(relPath));
    } catch (_e) {
      // Unreadable — flag as mismatch with whatever we have.
      sourceHash = sourceHash || null;
      targetHash = targetHash || null;
    }
    if (sourceHash !== targetHash) {
      divergences.push({
        file_path: relPath,
        divergence_type: 'content_mismatch',
        source_hash: sourceHash,
        target_hash: targetHash,
      });
    }
  }

  // Sort for deterministic output (tests + log readability).
  divergences.sort((a, b) => {
    if (a.divergence_type !== b.divergence_type) {
      return a.divergence_type < b.divergence_type ? -1 : 1;
    }
    return a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0;
  });

  return { skipped: false, skip_reason: null, divergences };
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

function resolveOrchestrationId(cwd) {
  try {
    const f = getCurrentOrchestrationFile(cwd);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.orchestration_id || null;
  } catch (_e) { return null; }
}

/**
 * Build a divergence_pair_signature for a file divergence. Combines the
 * filename and both hashes so downstream consumers can dedupe events that
 * originate from two hook fires (e.g., dual-install double-fire) for the
 * same underlying file pair.
 *
 * Format: `<basename>:<source_hash_short>:<target_hash_short>`
 * where hash_short is the first 8 chars of the SHA-256 hex digest, or '0' if null.
 *
 * @param {object} d - Divergence entry from checkParity().
 * @returns {string}
 */
function _divergencePairSignature(d) {
  const base = path.basename(d.file_path || '');
  const src  = d.source_hash ? d.source_hash.slice(0, 8) : '0';
  const tgt  = d.target_hash ? d.target_hash.slice(0, 8) : '0';
  return `${base}:${src}:${tgt}`;
}

function emitDivergenceEvents(cwd, divergences) {
  const orchId = resolveOrchestrationId(cwd);
  for (const d of divergences) {
    try {
      writeEvent({
        type: 'dual_install_divergence_detected',
        version: 1,
        timestamp: new Date().toISOString(),
        orchestration_id: orchId,
        file_path: d.file_path,
        divergence_type: d.divergence_type,
        source_hash: d.source_hash,
        target_hash: d.target_hash,
        divergence_pair_signature: _divergencePairSignature(d),
      }, { cwd });
    } catch (_e) { /* fail-open on emit */ }
  }
}

// ---------------------------------------------------------------------------
// Auto-heal arm (W7 v2.2.18)
//
// When a content_mismatch divergence is detected, attempt to heal the global
// install from the local install (local is canonical per
// feedback_update_both_installs.md — /orchestray:update writes local first).
//
// Heal direction: local (cwd/.claude/orchestray/bin/) → global (~/.claude/orchestray/bin/)
// when localStat.mtimeMs >= globalStat.mtimeMs.
//
// Kill switch (highest precedence): ORCHESTRAY_DUAL_INSTALL_AUTOHEAL_DISABLED=1
// Config key (second precedence): dual_install.autoheal_enabled (default: true)
// ---------------------------------------------------------------------------

/**
 * Attempt to heal one divergent global-install file from the local-install
 * canonical version. Emits `dual_install_autoheal` on success or
 * `dual_install_autoheal_skipped` with a reason on skip.
 *
 * @param {{
 *   cwd: string,
 *   relPath: string,
 *   localInstallPath: string,
 *   globalInstallPath: string,
 * }} opts
 */
function tryHealGlobalFile({ cwd, relPath, localInstallPath, globalInstallPath }) {
  const ts = new Date().toISOString();

  // Defense: local must exist.
  if (!fs.existsSync(localInstallPath)) {
    try {
      writeEvent({
        type: 'dual_install_autoheal_skipped',
        version: 1,
        ts: ts,
        path: relPath,
        reason: 'local_missing',
      }, { cwd });
    } catch (_e) { /* fail-open */ }
    return;
  }

  // Defense: global must exist (orphan-in-source edge case; we never create
  // new global files, only update existing ones).
  if (!fs.existsSync(globalInstallPath)) {
    try {
      writeEvent({
        type: 'dual_install_autoheal_skipped',
        version: 1,
        ts: ts,
        path: relPath,
        reason: 'global_missing',
      }, { cwd });
    } catch (_e) { /* fail-open */ }
    return;
  }

  let localStat, globalStat;
  try {
    localStat  = fs.statSync(localInstallPath);
    globalStat = fs.statSync(globalInstallPath);
  } catch (_e) {
    // Stat failed — skip silently (fail-open)
    return;
  }

  // Heal direction: local canonical when localStat.mtimeMs >= globalStat.mtimeMs.
  // If global is strictly newer, user may have just run /orchestray:update on the
  // global side and local hasn't caught up — do not clobber.
  if (localStat.mtimeMs < globalStat.mtimeMs) {
    try {
      writeEvent({
        type: 'dual_install_autoheal_skipped',
        version: 1,
        ts: ts,
        path: relPath,
        reason: 'reverse_direction_global_newer',
      }, { cwd });
    } catch (_e) { /* fail-open */ }
    return;
  }

  let localBytes, globalShaBefore;
  try {
    localBytes     = fs.readFileSync(localInstallPath);
    globalShaBefore = crypto.createHash('sha256').update(fs.readFileSync(globalInstallPath)).digest('hex');
  } catch (_e) {
    // Read failure — skip silently (fail-open)
    return;
  }

  const localSha = crypto.createHash('sha256').update(localBytes).digest('hex');

  // Race check: if hashes already match (another agent healed between detection
  // and our heal attempt), skip silently.
  if (localSha === globalShaBefore) {
    try {
      writeEvent({
        type: 'dual_install_autoheal_skipped',
        version: 1,
        ts: ts,
        path: relPath,
        reason: 'race_resolved',
      }, { cwd });
    } catch (_e) { /* fail-open */ }
    return;
  }

  // Write global file from local bytes.
  try {
    fs.writeFileSync(globalInstallPath, localBytes);
  } catch (e) {
    const reason = (e && e.code === 'EACCES') ? 'permission_denied' : 'write_error';
    try {
      writeEvent({
        type: 'dual_install_autoheal_skipped',
        version: 1,
        ts: ts,
        path: relPath,
        reason,
      }, { cwd });
    } catch (_e) { /* fail-open */ }
    return;
  }

  // Verify post-write: re-hash global file and compare with local.
  let globalShaAfter;
  try {
    globalShaAfter = crypto.createHash('sha256').update(fs.readFileSync(globalInstallPath)).digest('hex');
  } catch (_e) {
    // Cannot verify — treat as mismatch.
    globalShaAfter = null;
  }

  if (globalShaAfter !== localSha) {
    try {
      writeEvent({
        type: 'dual_install_autoheal_skipped',
        version: 1,
        ts: ts,
        path: relPath,
        reason: 'sha_mismatch_post_write',
        expected_sha: localSha,
        actual_sha: globalShaAfter,
      }, { cwd });
    } catch (_e) { /* fail-open */ }
    return;
  }

  // Success.
  try {
    writeEvent({
      type: 'dual_install_autoheal',
      version: 1,
      ts: ts,
      path: relPath,
      from_install: 'local',
      to_install: 'global',
      bytes_replaced: localBytes.length,
      local_canonical_sha: localSha,
      prior_global_sha: globalShaBefore,
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  // S-4: log heal success to stderr (mirrors the divergence-detected stderr advisory).
  process.stderr.write('[orchestray] dual_install: healed ' + relPath + ' (local→global)\n');
}

/**
 * Run the auto-heal arm for all content_mismatch divergences.
 * Orphan divergences (file in local install but not in source) are skipped —
 * we only heal content mismatches, not structural differences.
 *
 * @param {string} cwd
 * @param {Array<{file_path: string, divergence_type: string}>} divergences
 */
function runAutoHeal(cwd, divergences) {
  // Kill switch (highest precedence): env var.
  if (process.env.ORCHESTRAY_DUAL_INSTALL_AUTOHEAL_DISABLED === '1') {
    return;
  }

  // Config key (second precedence): dual_install.autoheal_enabled (default: true).
  let autohealEnabled = true;
  try {
    const cfg = loadDualInstallConfig(cwd);
    autohealEnabled = cfg.autoheal_enabled;
  } catch (_e) {
    // Fail-open: use default true
  }
  if (!autohealEnabled) return;

  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;

  const globalInstallRoot = path.join(home, '.claude', 'orchestray', 'bin');
  const localInstallRoot  = path.join(cwd, '.claude', 'orchestray', 'bin');

  // Only heal if global install root exists (single-install repos skip silently).
  if (!fs.existsSync(globalInstallRoot)) return;
  if (!fs.existsSync(localInstallRoot)) return;

  for (const d of divergences) {
    // Only heal content mismatches — orphans indicate structural drift that
    // auto-heal shouldn't paper over.
    if (d.divergence_type !== 'content_mismatch') continue;

    const relPath         = d.file_path;
    const localInstallPath  = path.join(localInstallRoot, relPath);
    const globalInstallPath = path.join(globalInstallRoot, relPath);

    tryHealGlobalFile({ cwd, relPath, localInstallPath, globalInstallPath });
  }
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

function readStdin(cb) {
  let buf = '';
  let bytes = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => cb(''));
  process.stdin.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_INPUT_BYTES) { cb(''); return; }
    buf += chunk;
  });
  process.stdin.on('end', () => cb(buf));
  // If stdin is not a pipe (manual invocation), end immediately.
  if (process.stdin.isTTY) cb('');
}

function isReleaseContext(event) {
  if (!event || typeof event !== 'object') return false;
  const candidates = [
    event.subagent_type,
    event.agent_type,
    event.agent_role,
    event.role,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.toLowerCase().trim() === RELEASE_MANAGER_ROLE) {
      return true;
    }
  }
  return false;
}

/**
 * FN-47 (v2.2.15) — SessionStart version-disagreement check.
 *
 * Reads `~/.claude/orchestray/package.json#version` and `<cwd>/.claude/orchestray/package.json#version`.
 * Returns:
 *   - { ok: true, mismatch: false }                    — versions match or only one install present.
 *   - { ok: true, mismatch: true, global, local }      — both installs present and disagree.
 *   - { ok: false }                                    — error reading; fail-open.
 */
function checkVersionParity(cwd) {
  function readVer(pkgPath) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const j = JSON.parse(raw);
      return typeof j.version === 'string' ? j.version : null;
    } catch (_e) { return null; }
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return { ok: false };
  const globalVer = readVer(path.join(home, '.claude', 'orchestray', 'package.json'));
  const localVer  = readVer(path.join(cwd, '.claude', 'orchestray', 'package.json'));
  if (!globalVer || !localVer) {
    // Single-install configuration; nothing to compare.
    return { ok: true, mismatch: false, global: globalVer, local: localVer };
  }
  return { ok: true, mismatch: globalVer !== localVer, global: globalVer, local: localVer };
}

/**
 * FN-47: surface and clear the pending double-fire warning sentinel staged by
 * bin/_lib/double-fire-guard.js. Returns the parsed sentinel or null.
 */
function consumePendingDoubleFireWarn(cwd) {
  const sentinelPath = path.join(cwd, '.orchestray', 'state', 'double-fire-warn-pending.json');
  try {
    const raw = fs.readFileSync(sentinelPath, 'utf8');
    const parsed = JSON.parse(raw);
    try { fs.unlinkSync(sentinelPath); } catch (_e) { /* idempotent */ }
    return parsed;
  } catch (_e) { return null; }
}

function isSessionStart(event) {
  if (!event || typeof event !== 'object') return false;
  const name = event.hook_event_name || event.hook_event || event.event_name || '';
  return typeof name === 'string' && name.toLowerCase() === 'sessionstart';
}

function main() {
  readStdin((raw) => {
    let event = {};
    try { event = raw ? JSON.parse(raw) : {}; }
    catch (_e) { event = {}; }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); }
    catch (_e) { cwd = process.cwd(); }

    // FN-47 (v2.2.15): SessionStart variant — compare install versions and
    // surface any pending double-fire warning. Always exit 0 (advisory only;
    // SessionStart cannot interrupt a session).
    if (isSessionStart(event)) {
      const skipDisabled = process.env.ORCHESTRAY_DOUBLE_FIRE_SKIP_GATE_DISABLED === '1';

      const verResult = checkVersionParity(cwd);
      if (verResult.ok && verResult.mismatch && !skipDisabled) {
        try {
          writeEvent({
            type:             'dual_install_version_mismatch',
            version:          1,
            schema_version:   1,
            timestamp:        new Date().toISOString(),
            global_version:   verResult.global,
            local_version:    verResult.local,
          }, { cwd });
        } catch (_e) { /* fail-open */ }

        try {
          fs.mkdirSync(path.join(cwd, '.orchestray', 'state'), { recursive: true });
          fs.writeFileSync(
            path.join(cwd, '.orchestray', 'state', 'dual-install-version-mismatch.json'),
            JSON.stringify({
              detected_at:    new Date().toISOString(),
              global_version: verResult.global,
              local_version:  verResult.local,
            }, null, 2),
            'utf8'
          );
        } catch (_e) { /* fail-open */ }

        process.stderr.write(
          `[orchestray] dual-install-parity-check: VERSION MISMATCH — ` +
          `global ~/.claude/orchestray@${verResult.global} differs from ` +
          `local .claude/orchestray@${verResult.local}. Both installs must agree; ` +
          `run /orchestray:update to bring BOTH installs current ` +
          `(see feedback_update_both_installs.md). ` +
          `Kill switch: ORCHESTRAY_DOUBLE_FIRE_SKIP_GATE_DISABLED=1.\n`
        );
      }

      const dfWarn = consumePendingDoubleFireWarn(cwd);
      if (dfWarn) {
        process.stderr.write(
          `[orchestray] dual-install-parity-check: double-fire racing detected — ` +
          `guard=${dfWarn.guard_name} dedup_key=${dfWarn.dedup_key} ` +
          `count=${dfWarn.fast_fire_count} delta_ms=${dfWarn.delta_ms}. ` +
          `${dfWarn.message || ''}\n`
        );
      }

      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const releaseCtx = isReleaseContext(event);
    const manualInvocation = !raw;
    const killSwitch = process.env.ORCHESTRAY_DUAL_INSTALL_CHECK_DISABLED === '1';

    // SubagentStop on a non-release-manager subagent: this hook is wired
    // generically but only acts in release context. Pass through silently.
    if (!releaseCtx && !manualInvocation) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Kill switch honored ONLY outside release context (per scope-lock #3:
    // releases must always parity-check).
    if (killSwitch && !releaseCtx) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let result;
    try {
      result = checkParity(cwd);
    } catch (e) {
      // Internal error. Fail-closed in release context (block release on
      // unknown error rather than ship divergent install). Fail-open
      // elsewhere (don't break dev workflows for missing fs perms etc).
      if (releaseCtx) {
        process.stderr.write(
          `[dual-install-parity-check] internal error in release context: ${e && e.message ? e.message : e}\n`
        );
        process.stdout.write(JSON.stringify({
          continue: false,
          stopReason: 'dual_install_parity_check_failed_internal',
        }));
        process.exit(2);
      }
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(1);
    }

    if (result.skipped) {
      // Print to stderr only when manually invoked, so cron/CI surfaces the
      // skip without polluting hook stdout (which Claude Code parses).
      if (manualInvocation) {
        process.stderr.write(`[dual-install-parity-check] skipped: ${result.skip_reason}\n`);
        process.stdout.write('skipped\n');
      } else {
        process.stdout.write(JSON.stringify({ continue: true }));
      }
      process.exit(0);
    }

    if (result.divergences.length === 0) {
      if (manualInvocation) {
        process.stdout.write('ok\n');
      } else {
        process.stdout.write(JSON.stringify({ continue: true }));
      }
      process.exit(0);
    }

    // Emit one event per divergence for the rollup / observability layer.
    emitDivergenceEvents(cwd, result.divergences);

    // Auto-heal arm (W7 v2.2.18): attempt to overwrite stale global-install
    // files with the canonical local-install bytes when local is newer or equal.
    // Heal is advisory-only — it never changes exit codes or blocking behavior.
    runAutoHeal(cwd, result.divergences);

    // Build a human-readable list for stderr.
    const lines = result.divergences.map(d => {
      if (d.divergence_type === 'orphan') {
        return `  orphan         .claude/orchestray/bin/${d.file_path}  (target=${d.target_hash || '?'})`;
      }
      return `  content-mismatch  ${d.file_path}  (source=${d.source_hash}, target=${d.target_hash})`;
    });
    process.stderr.write(
      `[dual-install-parity-check] ${result.divergences.length} divergence(s):\n` +
      lines.join('\n') + '\n'
    );

    if (manualInvocation) {
      process.exit(2);
    }

    // SubagentStop in release context: block release with a structured stop.
    process.stdout.write(JSON.stringify({
      continue: false,
      stopReason: 'dual_install_parity_violation',
    }));
    process.exit(2);
  });
}

module.exports = {
  checkParity,
  walkTree,
  isSourceOnlyAllowed,
  SOURCE_ONLY_ALLOWLIST,
  SOURCE_ONLY_DIR_PREFIXES,
  RELEASE_MANAGER_ROLE,
  // FN-47 exports for testability.
  checkVersionParity,
  consumePendingDoubleFireWarn,
  isSessionStart,
  _divergencePairSignature,
  // W7 (v2.2.18) auto-heal exports for testability.
  tryHealGlobalFile,
  runAutoHeal,
};

if (require.main === module) {
  main();
}
