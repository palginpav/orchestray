'use strict';

/**
 * self-probe.js — Tokenwright self-verification probe (W4 §"Self-verification probe" / event 8).
 *
 * 6-step probe verifying the full tokenwright pipeline is wired and functional
 * after a v2.2.6 install. Emits a `tokenwright_self_probe` event.
 *
 * CLI mode:  node bin/_lib/tokenwright/self-probe.js [--force]
 * Library:   module.exports = { runSelfProbe }  — returns payload without emitting.
 *
 * Sentinel gate:
 *   - Checks `.orchestray/state/tokenwright-self-probe-needed`; if absent and --force
 *     not passed, exits cleanly (skipped).
 *   - Always writes `.orchestray/state/tokenwright-self-probe-last.json` with
 *     { timestamp, result, failures }.
 *
 * Fail-safe: every step is individually try/catch'd. A step failure sets its flag
 * to false; does not abort the probe.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Referenced via module object (not destructured) so tests can monkeypatch
// individual exports on the cached module without re-requiring.
const _installPriority = require('../install-path-priority');

// Resolve package root relative to this file (bin/_lib/tokenwright/self-probe.js → ../../..)
// Used for reading package.json version and writing probe state files.
// NOTE: do NOT use PKG_ROOT for detecting local install — it points to the
// Orchestray source tree, not the user's project. Use process.cwd() for that.
const PKG_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/**
 * Step 1 — Install topology check.
 * Confirms inject-tokenwright.js and capture-tokenwright-realized.js appear
 * exactly once across all three hook registration locations:
 *   hooks/hooks.json (plugin manifest)
 *   ~/.claude/settings.json (global)
 *   <project>/.claude/settings.json (local)
 *
 * @returns {boolean} hook_dedup_clean
 */
function checkHookTopology() {
  try {
    const scripts = ['inject-tokenwright.js', 'capture-tokenwright-realized.js'];

    // Read plugin manifest
    const manifestPath = path.join(PKG_ROOT, 'hooks', 'hooks.json');
    let manifestContent = {};
    try {
      manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_e) { /* manifest unreadable — count as 0 */ }

    // Collect all hook command strings across the three sources
    function collectCommandStrings(hooksBlock) {
      const cmds = [];
      if (!hooksBlock || typeof hooksBlock !== 'object') return cmds;
      for (const eventHooks of Object.values(hooksBlock)) {
        if (!Array.isArray(eventHooks)) continue;
        for (const group of eventHooks) {
          if (group && Array.isArray(group.hooks)) {
            for (const h of group.hooks) {
              if (h && typeof h.command === 'string') cmds.push(h.command);
            }
          }
          // Also handle flat array of hooks directly
          if (group && typeof group.command === 'string') cmds.push(group.command);
        }
      }
      return cmds;
    }

    const allCommands = [
      ...collectCommandStrings(manifestContent.hooks || manifestContent),
    ];

    // Global settings
    try {
      const globalSettings = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')
      );
      allCommands.push(...collectCommandStrings(globalSettings.hooks));
    } catch (_e) { /* may not exist */ }

    // Local project settings
    try {
      const localSettings = JSON.parse(
        fs.readFileSync(path.join(PKG_ROOT, '.claude', 'settings.json'), 'utf8')
      );
      allCommands.push(...collectCommandStrings(localSettings.hooks));
    } catch (_e) { /* may not exist */ }

    // For each script, count appearances
    for (const script of scripts) {
      const count = allCommands.filter(cmd => cmd.includes(script)).length;
      if (count !== 1) return false; // zero or duplicate
    }
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Step 2 — Config gate check.
 * Confirms compression is not explicitly disabled in .orchestray/config.json.
 *
 * Per default-on shipping semantics: a missing config file or a missing
 * compression block both mean compression is active (defaults engage).
 * Only fail if compression.enabled is explicitly set to false.
 *
 * @returns {boolean} compression_block_in_config (true = compression active)
 */
function checkConfig() {
  try {
    const cfgPath = path.join(PKG_ROOT, '.orchestray', 'config.json');
    if (!fs.existsSync(cfgPath)) return true; // no config = defaults engage = pass
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return true; // unreadable = defaults engage = pass
    // Only fail if compression is EXPLICITLY disabled
    if (cfg.compression && cfg.compression.enabled === false) return false;
    return true;
  } catch (_e) {
    return true; // fail-open: parse error means defaults engage = pass
  }
}

/**
 * Step 3 — Transcript path probe.
 * Locates the most recent transcript under ~/.claude/projects/ and verifies
 * the path is resolvable and readable. This is a path-existence check, not a
 * token-parse check — a fresh install may have transcripts with no agent spawn
 * entries yet (resolveActualTokens would return source:'fallback'), which
 * previously caused a false transcript_token_path_not_resolves failure.
 *
 * @returns {boolean} transcript_token_path_resolves
 */
function checkTranscriptResolution() {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return false;

    // Find the most-recently modified transcript file
    let bestPath = null;
    let bestMtime = 0;

    const projectDirs = fs.readdirSync(projectsDir);
    for (const pDir of projectDirs) {
      const fullPDir = path.join(projectsDir, pDir);
      try {
        const stat = fs.statSync(fullPDir);
        if (!stat.isDirectory()) continue;
        const files = fs.readdirSync(fullPDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(fullPDir, f);
          try {
            const fstat = fs.statSync(fp);
            if (fstat.mtimeMs > bestMtime) {
              bestMtime = fstat.mtimeMs;
              bestPath = fp;
            }
          } catch (_e) { /* skip */ }
        }
      } catch (_e) { /* skip */ }
    }

    // Path resolves = we found a readable transcript file.
    // We do not require token parsing to succeed — a transcript with no agent
    // spawn messages still proves the path resolution works correctly.
    if (!bestPath) return false;
    fs.accessSync(bestPath, fs.constants.R_OK);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Step 4 — Synthetic compression run.
 * Builds an in-memory prompt with two near-duplicate ## Prior Findings blocks
 * and runs runL1. Verifies droppedCount === 1.
 *
 * @returns {boolean} fixture_compression_ran
 */
function checkSyntheticCompression() {
  try {
    const { parseSections, reassembleSections } = require('./parse-sections');
    const { classifySection }  = require('./classify-section');
    const { applyMinHashDedup } = require('./dedup-minhash');

    const dupBlock = [
      '## Prior Findings',
      '',
      'The agent found that the implementation is mostly correct but needs minor fixes.',
      'The main issue is in the error handler which does not cover edge cases.',
      'The secondary issue is in the logging which is too verbose for production use.',
      'No critical security issues were found during review.',
      '',
    ].join('\n');

    const fixture = [
      '<!-- ORCHESTRAY_BLOCK_A_END -->',
      '',
      '## Task Summary',
      '',
      'Review the codebase and summarize findings.',
      '',
      dupBlock,
      dupBlock, // duplicate — should be dropped
    ].join('\n');

    const sections = parseSections(fixture);
    for (const s of sections) s.kind = classifySection(s).kind;
    const { dropped: droppedCount } = applyMinHashDedup(sections);
    const compressed = reassembleSections(sections);

    return droppedCount === 1 && compressed.length < fixture.length;
  } catch (_e) {
    return false;
  }
}

/**
 * Step 5 — Synthetic event emission.
 * Emits prompt_compression and tokenwright_realized_savings to a tmp file,
 * then verifies both events were written correctly.
 *
 * Uses opts.eventsPath override on writeEvent to avoid touching production audit.
 *
 * @returns {{ fixture_emitted_prompt_compression: boolean, fixture_emitted_realized_savings: boolean }}
 */
function checkSyntheticEmission() {
  const result = {
    fixture_emitted_prompt_compression:  false,
    fixture_emitted_realized_savings:    false,
  };

  const tmpPath = path.join(PKG_ROOT, '.orchestray', 'state', '.self-probe-events-tmp.jsonl');

  try {
    // Ensure state dir exists
    fs.mkdirSync(path.join(PKG_ROOT, '.orchestray', 'state'), { recursive: true });

    // Remove previous tmp file if it exists
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ok if absent */ }

    const { writeEvent } = require('../audit-event-writer');

    const probeOrchestrId = 'self-probe-synthetic';

    writeEvent({
      type:                   'prompt_compression',
      version:                1,
      schema_version:         1,
      orchestration_id:       probeOrchestrId,
      agent_type:             'self-probe',
      input_bytes:            1000,
      output_bytes:           900,
      ratio:                  0.9,
      technique_tag:          'safe-l1',
      input_token_estimate:   250,
      output_token_estimate:  225,
      dropped_sections:       [],
      layer1_dedup_blocks_dropped: 0,
    }, { skipValidation: true, eventsPath: tmpPath });

    writeEvent({
      type:                       'tokenwright_realized_savings',
      version:                    1,
      schema_version:             1,
      orchestration_id:           probeOrchestrId,
      agent_type:                 'self-probe',
      estimated_input_tokens_pre: 250,
      actual_input_tokens:        240,
      actual_savings_tokens:      10,
      estimation_error_pct:       4.0,
      technique_tag:              'safe-l1',
      realized_status:            'measured',
      usage_source:               'transcript',
      drift_exceeded:             false,
      drift_budget_pct:           15,
      removed_pending_entry:      true,
    }, { skipValidation: true, eventsPath: tmpPath });

    // Verify both events were written
    if (!fs.existsSync(tmpPath)) return result;
    const content = fs.readFileSync(tmpPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        const evtType = evt.type || evt.event_type;
        if (evtType === 'prompt_compression') result.fixture_emitted_prompt_compression = true;
        if (evtType === 'tokenwright_realized_savings') result.fixture_emitted_realized_savings = true;
      } catch (_e) { /* skip */ }
    }
  } catch (_e) {
    // Leave both flags false
  } finally {
    // Clean up tmp file
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* best-effort */ }
  }

  return result;
}

/**
 * Detect whether global install exists (~/.claude/orchestray/bin/).
 * @returns {boolean}
 */
function detectGlobalInstall() {
  return _installPriority.isGlobalInstallPresent();
}

/**
 * Detect whether local project install exists (<projectRoot>/.claude/orchestray/bin/).
 *
 * Uses process.cwd() as the project root — the user's working directory where
 * Orchestray was installed. PKG_ROOT (the Orchestray source tree) is NOT used
 * here because it always points to the install origin, never the user's project.
 *
 * @param {string} [projectRoot] — optional override (used by tests).
 * @returns {boolean}
 */
function detectLocalInstall(projectRoot) {
  return _installPriority.isLocalInstallPresent(projectRoot || process.cwd());
}

/**
 * Read the installed version from package.json.
 * @returns {string}
 */
function readInstalledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Main probe function
// ---------------------------------------------------------------------------

/**
 * Run the self-probe and return the tokenwright_self_probe payload.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]        — if true, ignore the sentinel gate and always run
 * @param {string}  [opts.projectRoot]  — override for user's project root (used by tests).
 *                                        Defaults to process.cwd(). Determines whether a
 *                                        local install is present at <projectRoot>/.claude/.
 * @returns {object} tokenwright_self_probe payload
 */
function runSelfProbe(opts) {
  opts = opts || {};
  const nowTs = new Date().toISOString();
  // Caller-supplied projectRoot lets tests inject a tmpdir without touching process.cwd().
  const projectRoot = (opts.projectRoot && typeof opts.projectRoot === 'string')
    ? opts.projectRoot
    : process.cwd();

  const sentinelPath  = path.join(PKG_ROOT, '.orchestray', 'state', 'tokenwright-self-probe-needed');
  const lastRunPath   = path.join(PKG_ROOT, '.orchestray', 'state', 'tokenwright-self-probe-last.json');

  // Sentinel gate
  const forcedRun = opts.force === true;
  if (!forcedRun) {
    try {
      if (!fs.existsSync(sentinelPath)) {
        // Not needed — exit cleanly
        const skippedPayload = {
          type:                                'tokenwright_self_probe',
          event_type:                          'tokenwright_self_probe',
          schema_version:                      1,
          version:                             1,
          timestamp:                           nowTs,
          version_installed:                   readInstalledVersion(),
          global_install_present:              detectGlobalInstall(),
          local_install_present:               detectLocalInstall(projectRoot),
          hook_dedup_clean:                    null,
          compression_block_in_config:         null,
          transcript_token_path_resolves:      null,
          fixture_compression_ran:             null,
          fixture_emitted_prompt_compression:  null,
          fixture_emitted_realized_savings:    null,
          result:                              'skipped',
          failures:                            [],
        };
        return skippedPayload;
      }
    } catch (_e) {
      // If we can't check the sentinel, run the probe anyway
    }
  }

  // Run each step independently
  const hookDedupClean             = checkHookTopology();
  const compressionBlockInConfig   = checkConfig();
  const transcriptTokenPathResolves = checkTranscriptResolution();
  const fixtureCompressionRan      = checkSyntheticCompression();
  const emitResults                = checkSyntheticEmission();
  const fixtureEmittedCompression  = emitResults.fixture_emitted_prompt_compression;
  const fixtureEmittedRealized     = emitResults.fixture_emitted_realized_savings;

  const globalInstallPresent = detectGlobalInstall();
  const localInstallPresent  = detectLocalInstall(projectRoot);
  const versionInstalled     = readInstalledVersion();

  // Collect failures
  const failures = [];
  if (!hookDedupClean)             failures.push('hook_dedup_unclean');
  if (!compressionBlockInConfig)   failures.push('compression_block_not_in_config');
  if (!transcriptTokenPathResolves) failures.push('transcript_token_path_not_resolves');
  if (!fixtureCompressionRan)      failures.push('fixture_compression_did_not_run');
  if (!fixtureEmittedCompression)  failures.push('fixture_prompt_compression_not_emitted');
  if (!fixtureEmittedRealized)     failures.push('fixture_realized_savings_not_emitted');

  const probeResult = failures.length === 0 ? 'pass' : 'fail';

  const payload = {
    type:                                'tokenwright_self_probe',
    event_type:                          'tokenwright_self_probe',
    schema_version:                      1,
    version:                             1,
    timestamp:                           nowTs,
    version_installed:                   versionInstalled,
    global_install_present:              globalInstallPresent,
    local_install_present:               localInstallPresent,
    hook_dedup_clean:                    hookDedupClean,
    compression_block_in_config:         compressionBlockInConfig,
    transcript_token_path_resolves:      transcriptTokenPathResolves,
    fixture_compression_ran:             fixtureCompressionRan,
    fixture_emitted_prompt_compression:  fixtureEmittedCompression,
    fixture_emitted_realized_savings:    fixtureEmittedRealized,
    result:                              probeResult,
    failures,
  };

  // Write last-run sentinel
  try {
    fs.mkdirSync(path.join(PKG_ROOT, '.orchestray', 'state'), { recursive: true });
    fs.writeFileSync(lastRunPath, JSON.stringify({
      timestamp: nowTs,
      result:    probeResult,
      failures,
    }, null, 2), 'utf8');
  } catch (_e) { /* best-effort */ }

  // Remove "probe needed" sentinel
  if (!forcedRun) {
    try { fs.unlinkSync(sentinelPath); } catch (_e) { /* best-effort */ }
  }

  return payload;
}

module.exports = { runSelfProbe };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const force = process.argv.includes('--force');
  const payload = runSelfProbe({ force });

  if (payload.result === 'skipped') {
    process.stdout.write('[self-probe] skipped — sentinel not present. Use --force to run anyway.\n');
    process.exit(0);
  }

  // Emit the event via the audit-event-writer
  try {
    const { writeEvent } = require('../audit-event-writer');
    writeEvent(payload);
  } catch (_e) {
    // If writer fails, still output to stdout for debugging
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }

  process.stdout.write(
    '[self-probe] result=' + payload.result +
    (payload.failures.length > 0 ? ' failures=' + payload.failures.join(',') : '') +
    '\n'
  );
  process.exit(payload.result === 'pass' ? 0 : 1);
}
