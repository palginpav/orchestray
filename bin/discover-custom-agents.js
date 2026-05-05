#!/usr/bin/env node
'use strict';

/**
 * discover-custom-agents.js — SessionStart hook (v2.3.1).
 *
 * Reads ~/.claude/orchestray/custom-agents/*.md, validates each file,
 * and writes a cache to <cwd>/.orchestray/state/custom-agents-cache.json
 * for the gate hook (gate-agent-spawn.js) to consume on every spawn.
 *
 * Hook contract:
 *   - Always exits 0. Never blocks session startup.
 *   - Fail-soft on every error path: writes empty cache, logs to stderr.
 *   - No stdout output (hook output on stdout would be parsed by Claude Code).
 *
 * Kill switches (checked in order; first hit wins):
 *   1. env ORCHESTRAY_DISABLE_CUSTOM_AGENTS === '1'
 *   2. .orchestray/config.json → custom_agents.enabled === false
 *
 * Wiring (hooks/hooks.json): SessionStart array, timeout 5s,
 * position after boot-validate-config.js, before feature-quarantine-banner.js.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveSafeCwd }        = require('./_lib/resolve-project-cwd');
const { writeEvent }            = require('./_lib/audit-event-writer');
const {
  resolveCustomAgentsDir,
  validateCustomAgentFile,
  writeCache,
  nfkdLowerAscii,
  loadShippedSpecialistNames,
  MAX_DIR_FILES,
} = require('./_lib/custom-agents');
const { CANONICAL_AGENTS } = require('./_lib/canonical-agents');

/** Plugin root: two levels up from this script (bin/ → plugin root). */
const PLUGIN_ROOT = path.dirname(__dirname);

/** Sentinel file path: survives upgrades (not in plugin tree). */
const BANNER_SENTINEL = path.join(os.homedir(), '.claude', '.orchestray-custom-agents-banner-shown');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a prefixed line to stderr.
 * @param {string} msg
 */
function warn(msg) {
  try { process.stderr.write('[orchestray] custom-agents: ' + msg + '\n'); } catch (_) {}
}

/**
 * Load custom_agents config block from .orchestray/config.json.
 * Fail-open: returns { enabled: true } on any error.
 * @param {string} cwd
 * @returns {{ enabled: boolean }}
 */
function loadCustomAgentsConfig(cwd) {
  const defaults = { enabled: true };
  try {
    const raw    = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const block = parsed.custom_agents;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return defaults;
    return Object.assign({}, defaults, block);
  } catch (_) {
    return defaults;
  }
}

/**
 * Emit an audit event via writeEvent. Fail-soft wrapper.
 * @param {object} payload
 * @param {string} cwd
 */
function safeEmit(payload, cwd) {
  try {
    writeEvent(payload, { cwd, skipValidation: true });
  } catch (_) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(function main() {
  // Parse hook payload from stdin (best-effort; ignore parse errors).
  let eventCwd;
  try {
    const stdinData = fs.readFileSync('/dev/stdin', 'utf8');
    const payload   = JSON.parse(stdinData);
    eventCwd        = payload && payload.cwd;
  } catch (_) { /* ignore — we fall back to process.cwd() */ }

  const cwd = resolveSafeCwd(eventCwd);
  const sourceDir = resolveCustomAgentsDir();
  const now = new Date().toISOString();

  // Helper: write empty cache and exit 0.
  function exitEmpty(reason) {
    const r = writeCache(cwd, {
      version:       1,
      discovered_at: now,
      source_dir:    sourceDir,
      agents:        [],
    });
    if (!r.ok) {
      warn('cache write failed (' + r.reason + '); custom agents disabled this session');
    }
    safeEmit({
      type:             'custom_agents_discovered',
      orchestration_id: 'none',
      timestamp:        now,
      level:            'info',
      discovered_count: 0,
      skipped_count:    0,
      names:            [],
      source_dir:       sourceDir,
    }, cwd);
    if (reason) warn(reason);
    process.exit(0);
  }

  // 2. Kill-switch checks.
  if (process.env.ORCHESTRAY_DISABLE_CUSTOM_AGENTS === '1') {
    exitEmpty('kill switch active (env ORCHESTRAY_DISABLE_CUSTOM_AGENTS=1)');
    return;
  }

  const config = loadCustomAgentsConfig(cwd);
  if (config.enabled === false) {
    exitEmpty('kill switch active (config custom_agents.enabled=false)');
    return;
  }

  // 3. Build reservedNames = canonicals (NFKD) ∪ shipped specialists.
  const shippedSpecialistNames = loadShippedSpecialistNames(PLUGIN_ROOT);
  const reservedNames = new Set([
    ...[...CANONICAL_AGENTS].map(nfkdLowerAscii),
    ...[...shippedSpecialistNames].map(nfkdLowerAscii),
  ]);

  // 4. Read source dir.
  let allFiles;
  try {
    const entries = fs.readdirSync(sourceDir);
    allFiles = entries.filter(f => f.endsWith('.md'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      exitEmpty(null);
      return;
    }
    exitEmpty('cannot read source dir (' + (e && e.message ? e.message : e) + ')');
    return;
  }

  // Hard cap: max 100 files.
  if (allFiles.length > MAX_DIR_FILES) {
    warn(
      'source dir contains ' + allFiles.length + ' files; ' +
      'only the first ' + MAX_DIR_FILES + ' will be processed (hard cap)'
    );
    allFiles = allFiles.slice(0, MAX_DIR_FILES);
  }

  if (allFiles.length === 0) {
    // 9. First-session banner: dir exists but is empty.
    _maybeShowBanner(sourceDir);
    exitEmpty(null);
    return;
  }

  // 5-7. Validate each file; aggregate.
  const validAgents   = [];
  let   skippedCount  = 0;

  for (const filename of allFiles) {
    const absPath = path.join(sourceDir, filename);
    const result  = validateCustomAgentFile(absPath, { reservedNames, shippedSpecialistNames });

    if (result.ok) {
      validAgents.push(result.record);
    } else {
      skippedCount++;

      // Emit skipped event.
      safeEmit({
        type:             'custom_agents_skipped',
        orchestration_id: 'none',
        timestamp:        new Date().toISOString(),
        level:            'warn',
        filename,
        name_field:       result.name || null,
        reason:           result.reason,
        detail:           result.reason,
      }, cwd);

      // Emit collision event when applicable.
      const isCollision = (
        result.reason === 'canonical_collision' ||
        result.reason === 'shipped_specialist_collision' ||
        result.reason === 'reserved_name_collision'
      );
      if (isCollision && result.name) {
        const collisionClass =
          result.reason === 'canonical_collision'           ? 'canonical' :
          result.reason === 'shipped_specialist_collision'  ? 'shipped_specialist' :
          /* reserved_name_collision */                       'canonical';

        // Find what the name collides with.
        const normalized = nfkdLowerAscii(result.name);
        let collidesWith = normalized; // fallback
        for (const c of CANONICAL_AGENTS) {
          if (nfkdLowerAscii(c) === normalized) { collidesWith = c; break; }
        }
        if (collisionClass === 'shipped_specialist') {
          for (const s of shippedSpecialistNames) {
            if (nfkdLowerAscii(s) === normalized) { collidesWith = s; break; }
          }
        }

        safeEmit({
          type:             'custom_agents_collision',
          orchestration_id: 'none',
          timestamp:        new Date().toISOString(),
          level:            'error',
          filename,
          name_field:       result.name,
          normalized_name:  normalized,
          collides_with:    collidesWith,
          collision_class:  collisionClass,
        }, cwd);
      }
    }
  }

  // 8. Write cache.
  const cachePayload = {
    version:       1,
    discovered_at: now,
    source_dir:    sourceDir,
    agents:        validAgents,
  };
  const writeResult = writeCache(cwd, cachePayload);
  if (!writeResult.ok) {
    warn('cache write failed (' + writeResult.reason + '); custom agents disabled this session');
  }

  // Emit summary discovered event.
  const level = skippedCount > 0 ? 'warn' : 'info';
  safeEmit({
    type:             'custom_agents_discovered',
    orchestration_id: 'none',
    timestamp:        new Date().toISOString(),
    level,
    discovered_count: validAgents.length,
    skipped_count:    skippedCount,
    names:            validAgents.map(a => a.name),
    source_dir:       sourceDir,
  }, cwd);

  // Stderr summary.
  warn(
    'discovered ' + validAgents.length + ' agent(s)' +
    (skippedCount > 0 ? '; skipped ' + skippedCount + ' (run /orchestray:doctor for details)' : '')
  );

  process.exit(0);
})();

// ---------------------------------------------------------------------------
// Banner sentinel
// ---------------------------------------------------------------------------

/**
 * Show first-session banner if sentinel absent and dir is empty.
 * @param {string} sourceDir
 */
function _maybeShowBanner(sourceDir) {
  try {
    if (fs.existsSync(BANNER_SENTINEL)) return;
    process.stderr.write(
      '[orchestray] custom-agents: drop <name>.md into ' + sourceDir +
      ' to register; see docs at https://github.com/palginpav/orchestray#custom-agents\n'
    );
    try {
      fs.writeFileSync(BANNER_SENTINEL, new Date().toISOString() + '\n', { encoding: 'utf8' });
    } catch (_) { /* fail-soft: sentinel write failure is not critical */ }
  } catch (_) { /* fail-soft */ }
}
