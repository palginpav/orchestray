'use strict';

/**
 * agent-symlinks.js — manage `~/.claude/agents/<name>.md` symlinks for
 * Orchestray custom-agents drop-ins.
 *
 * Why this exists:
 *   Claude Code builds its subagent registry once at session start by
 *   scanning `~/.claude/agents/` and `<project>/.claude/agents/`. The
 *   custom-agents source directory `~/.claude/orchestray/custom-agents/`
 *   is NOT on that scan path, so validated drop-ins cannot be invoked
 *   via `Agent(subagent_type=<name>)` until they appear under one of the
 *   scanned dirs. Shipped specialists already use this pattern (see
 *   bin/install.js §1b). This helper extends the same lifecycle to
 *   custom agents.
 *
 * Lifecycle (idempotent):
 *   - For each valid agent record, ensure `<agentsDir>/<name>.md` is a
 *     symlink to `record.source_path`.
 *   - Existing symlink at correct target → kept.
 *   - Existing symlink at wrong target inside <sourceDir> → retargeted.
 *   - Existing symlink at a target outside <sourceDir> → skipped, warn.
 *     (Probably another installer's; do not clobber.)
 *   - Existing regular file or directory → skipped, warn (user-managed).
 *   - EPERM on symlink creation → fallback to fs.copyFileSync, warn once.
 *
 * Stale sweep:
 *   - After the forward pass, scan `<agentsDir>/*.md`. For every symlink
 *     whose resolved target sits under <sourceDir> AND whose basename is
 *     NOT in validNames, unlink it. Specialist symlinks point into a
 *     different sibling dir and are untouched.
 *
 * Caller is expected to pass:
 *   - validAgents: array of records with at least { name, source_path }
 *   - sourceDir:   absolute path to the custom-agents source dir
 *   - agentsDir:   absolute path to Claude Code's user-scope agents dir
 *   - warn:        function(string) for stderr-style logging (no-throw)
 *
 * Returns counts: { created, kept, retargeted, copied, skipped, swept, errors }.
 */

const fs   = require('fs');
const path = require('path');

/**
 * @param {{validAgents: Array<{name: string, source_path: string}>,
 *          sourceDir: string,
 *          agentsDir: string,
 *          warn?: (msg: string) => void}} opts
 * @returns {{created:number, kept:number, retargeted:number, copied:number,
 *            skipped:number, swept:number, errors:number}}
 */
function syncCustomAgentSymlinks(opts) {
  const validAgents = (opts && opts.validAgents) || [];
  const sourceDir   = opts && opts.sourceDir;
  const agentsDir   = opts && opts.agentsDir;
  const warn        = (opts && typeof opts.warn === 'function') ? opts.warn : (() => {});

  const result = {
    created: 0, kept: 0, retargeted: 0, copied: 0,
    skipped: 0, swept: 0, errors: 0,
  };

  if (!sourceDir || !agentsDir) {
    return result;
  }

  // Ensure agents dir exists. Idempotent.
  try {
    fs.mkdirSync(agentsDir, { recursive: true });
  } catch (e) {
    warn('could not create ' + agentsDir + ': ' + (e && e.message ? e.message : e));
    return result;
  }

  const sourceDirNormalized = sourceDir.replace(/[/\\]+$/, '');
  let windowsFallbackWarned = false;

  // Forward pass: ensure each valid agent has a correct symlink.
  for (const record of validAgents) {
    if (!record || typeof record.name !== 'string' || typeof record.source_path !== 'string') {
      result.errors++;
      continue;
    }
    const linkPath       = path.join(agentsDir, record.name + '.md');
    const expectedTarget = record.source_path;

    let lstats;
    try {
      lstats = fs.lstatSync(linkPath);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // Fresh create.
        const created = _create(linkPath, expectedTarget, warn,
                                 () => { windowsFallbackWarned = _maybeWarnWindows(windowsFallbackWarned, agentsDir, warn); });
        if (created.symlinked) result.created++;
        else if (created.copied) result.copied++;
        else result.errors++;
        continue;
      }
      warn('lstat failed for ' + linkPath + ': ' + (e && e.message ? e.message : e));
      result.errors++;
      continue;
    }

    if (lstats.isSymbolicLink()) {
      let currentTarget;
      try {
        const raw = fs.readlinkSync(linkPath);
        currentTarget = path.isAbsolute(raw)
          ? raw
          : path.resolve(path.dirname(linkPath), raw);
      } catch (_) {
        // Broken or unreadable — retarget.
        try { fs.unlinkSync(linkPath); } catch (_) { /* ignore */ }
        const created = _create(linkPath, expectedTarget, warn,
                                 () => { windowsFallbackWarned = _maybeWarnWindows(windowsFallbackWarned, agentsDir, warn); });
        if (created.symlinked || created.copied) result.retargeted++;
        else result.errors++;
        continue;
      }

      if (currentTarget === expectedTarget) {
        result.kept++;
        continue;
      }

      // Wrong target. Retarget only if old target was inside our source dir.
      const inSourceDir =
        currentTarget === sourceDirNormalized ||
        currentTarget.startsWith(sourceDirNormalized + path.sep);
      if (inSourceDir) {
        try { fs.unlinkSync(linkPath); } catch (_) { /* ignore */ }
        const created = _create(linkPath, expectedTarget, warn,
                                 () => { windowsFallbackWarned = _maybeWarnWindows(windowsFallbackWarned, agentsDir, warn); });
        if (created.symlinked || created.copied) result.retargeted++;
        else result.errors++;
      } else {
        warn(
          'skipping ' + record.name + ': existing symlink at ' + linkPath +
          ' points outside custom-agents source (managed elsewhere)'
        );
        result.skipped++;
      }
      continue;
    }

    // Regular file / dir / other — user-managed.
    warn(
      'skipping ' + record.name + ': existing file at ' + linkPath +
      ' is not a symlink (user-managed); not clobbering'
    );
    result.skipped++;
  }

  // Reverse pass: sweep stale symlinks that point into our source dir
  // but no longer correspond to a valid agent.
  const validNames = new Set(validAgents.map(a => a && a.name).filter(Boolean));
  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch (_) {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const linkPath = path.join(agentsDir, entry);
    let lstats;
    try { lstats = fs.lstatSync(linkPath); } catch (_) { continue; }
    if (!lstats.isSymbolicLink()) continue;
    let target;
    try {
      const raw = fs.readlinkSync(linkPath);
      target = path.isAbsolute(raw)
        ? raw
        : path.resolve(path.dirname(linkPath), raw);
    } catch (_) { continue; }
    const inSourceDir =
      target === sourceDirNormalized ||
      target.startsWith(sourceDirNormalized + path.sep);
    if (!inSourceDir) continue;

    const baseName = path.basename(entry, '.md');
    if (validNames.has(baseName)) continue;

    try {
      fs.unlinkSync(linkPath);
      result.swept++;
    } catch (e) {
      warn('could not sweep stale symlink ' + linkPath + ': ' + (e && e.message ? e.message : e));
      result.errors++;
    }
  }

  return result;
}

/**
 * Create symlink, falling back to copy on EPERM.
 * @returns {{symlinked: boolean, copied: boolean}}
 */
function _create(linkPath, target, warn, onWindowsFallback) {
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return { symlinked: true, copied: false };
  } catch (err) {
    if (err && err.code === 'EPERM') {
      try {
        fs.copyFileSync(target, linkPath);
        if (typeof onWindowsFallback === 'function') onWindowsFallback();
        return { symlinked: false, copied: true };
      } catch (copyErr) {
        warn('could not install ' + path.basename(linkPath) + ': ' + copyErr.message);
        return { symlinked: false, copied: false };
      }
    }
    warn('could not symlink ' + path.basename(linkPath) + ': ' + (err && err.message ? err.message : err));
    return { symlinked: false, copied: false };
  }
}

function _maybeWarnWindows(alreadyWarned, agentsDir, warn) {
  if (alreadyWarned) return true;
  warn(
    'symlink permission denied; copied custom agent(s) into ' + agentsDir + '. ' +
    'Copies will not auto-update if the source changes — enable Developer Mode ' +
    'or run as admin for durable symlinks.'
  );
  return true;
}

module.exports = { syncCustomAgentSymlinks };
