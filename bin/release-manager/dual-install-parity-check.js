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
      }, { cwd });
    } catch (_e) { /* fail-open on emit */ }
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

function main() {
  readStdin((raw) => {
    let event = {};
    try { event = raw ? JSON.parse(raw) : {}; }
    catch (_e) { event = {}; }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); }
    catch (_e) { cwd = process.cwd(); }

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
};

if (require.main === module) {
  main();
}
