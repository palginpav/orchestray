#!/usr/bin/env node
'use strict';

/**
 * 2013-W8/W11: UserPromptSubmit post-upgrade sweep.
 *
 * Runs two idempotent one-shot operations the first time any UserPromptSubmit
 * fires in a session after the 2.0.13 upgrade:
 *
 *   W8 (2013-W8-config-migration):
 *     Additive migration of .orchestray/config.json to add the
 *     mcp_enforcement block if missing or incomplete, preserving all
 *     other keys unchanged.
 *
 *   W11 (2013-W11-ledger-sweep):
 *     Flip phase='post-decomposition' rows in mcp-checkpoint.jsonl to
 *     phase='pre-decomposition' where the row's orchestration_id has no
 *     routing.jsonl entry whose timestamp precedes the row's timestamp,
 *     indicating the row was recorded under the BUG-B bug in 2.0.12.
 *
 * Session-scoped lock at /tmp/orchestray-sweep-<session_id>.lock prevents
 * repeat execution within a single session. Each sub-operation also has its
 * own sentinel to prevent re-running across sessions:
 *   .orchestray/state/.config-migrated-2013          (W8)
 *   .orchestray/state/.mcp-checkpoint-migrated-2013  (W11)
 *
 * Fails open on every error. Never blocks the user prompt.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { detectSessionStartMs } = require('./_lib/session-detect');
const {
  DEFAULT_MCP_ENFORCEMENT,
  DEFAULT_COST_BUDGET_CHECK,
  DEFAULT_COST_BUDGET_ENFORCEMENT,
  DEFAULT_V2017_EXPERIMENTS,
  DEFAULT_CACHE_CHOREOGRAPHY,
  DEFAULT_ADAPTIVE_VERBOSITY,
  DEFAULT_PATTERN_DECAY,
  DEFAULT_ANTI_PATTERN_GATE,
  DEFAULT_STATE_SENTINEL,
  DEFAULT_REDO_FLOW,
} = require('./_lib/config-schema');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

// ──────────────────────────────────────────────────────────────────────────────
// v2.0.21: upgrade-pending warning
// ──────────────────────────────────────────────────────────────────────────────

// Allow tests to redirect the sentinel path to an isolated location so that
// parallel test suites don't race on the real ~/.claude/ sentinel file.
const UPGRADE_SENTINEL_PATH = process.env.ORCHESTRAY_TEST_SENTINEL_PATH
  || path.join(os.homedir(), '.claude', '.orchestray-upgrade-pending');
const UPGRADE_SENTINEL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Detect that `bin/install.js` ran since this session started and, if so,
 * emit a one-time-per-session stderr warning telling the user to restart
 * Claude Code so the agent registry (cached at session start) picks up any
 * new agent definitions.
 *
 * 4-case state machine (v2.0.22):
 *
 *   Case A — no sentinel:
 *     Return silently. Nothing pending.
 *
 *   Case B — sentinel < TTL AND this session postdates install
 *             (sessionStartMs >= installed_at_ms):
 *     This session already loaded the new agents. Silently unlink sentinel
 *     and per-session marker.
 *
 *   Case C — sentinel < TTL AND this session predates install
 *             (sessionStartMs < installed_at_ms):
 *     Emit a one-time stderr warning. Write per-session marker LAST so a
 *     crash mid-write doesn't suppress the warning on the next prompt.
 *
 *   Case D — sentinel > TTL OR malformed (no installed_at_ms or
 *             schema_version !== 2):
 *     Silently unlink sentinel (stale or unreadable). v1 sentinels left
 *     over from v2.0.21 installs are handled here — they have no
 *     schema_version field and are cleaned up silently.
 *
 * Fail-open: any I/O error is swallowed. Never blocks the user prompt.
 *
 * @param {string|null} sessionId - Sanitized session id from the hook payload.
 * @param {string}      cwd       - Absolute project directory path.
 */
function emitUpgradePendingWarning(sessionId, cwd) {
  try {
    // Case A — no sentinel.
    if (!fs.existsSync(UPGRADE_SENTINEL_PATH)) return;

    let data = null;
    try { data = JSON.parse(fs.readFileSync(UPGRADE_SENTINEL_PATH, 'utf8')); } catch (_e) { /* fall through to Case D */ }

    // Case D — malformed: no data, wrong schema_version, or missing installed_at_ms.
    if (
      !data ||
      typeof data !== 'object' ||
      data.schema_version !== 2 ||
      typeof data.installed_at_ms !== 'number'
    ) {
      try { fs.unlinkSync(UPGRADE_SENTINEL_PATH); } catch (_e) { /* ignore */ }
      return;
    }

    const installedAtMs = data.installed_at_ms;
    const now = Date.now();

    // Case D — TTL expired.
    if ((now - installedAtMs) > UPGRADE_SENTINEL_TTL_MS) {
      try { fs.unlinkSync(UPGRADE_SENTINEL_PATH); } catch (_e) { /* ignore */ }
      return;
    }

    // sentinel < TTL and well-formed — now detect session age.
    if (!sessionId) return;

    const sessionMarkerPath = path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId);

    const sessionStartMs = detectSessionStartMs(sessionId, cwd);

    if (sessionStartMs !== null && sessionStartMs >= installedAtMs) {
      // Case B — this session postdates the install; no restart needed.
      // Clean up sentinel and any stale per-session marker.
      try { fs.unlinkSync(UPGRADE_SENTINEL_PATH); } catch (_e) { /* ignore */ }
      try { fs.unlinkSync(sessionMarkerPath); } catch (_e) { /* ignore — may not exist */ }
      return;
    }

    // Case C — session predates install (or session-start unknown).
    // Per-session marker present means we already warned this session.
    if (fs.existsSync(sessionMarkerPath)) return;

    // v2.1.9 I-10: write sentinel BEFORE emitting to eliminate the
    // race-storm where rapid UserPromptSubmit turns in a single session
    // could each enter this block between emit and the old trailing write.
    // A stderr write + recordDegradation is slow enough (hundreds of µs)
    // to allow concurrent hook processes to pile up emits; inverting the
    // order guarantees only the first hook to reach this point emits.
    let sentinelWritten = false;
    try {
      fs.writeFileSync(sessionMarkerPath, '1', { flag: 'wx', encoding: 'utf8' });
      sentinelWritten = true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Another hook raced us and won — they emitted; we stay silent.
        return;
      }
      // Any other write error falls through: we still emit once, and on
      // retry we will re-emit. This preserves loud-failure semantics for
      // unusual filesystems.
    }

    const versionSuffix = data.version
      ? ' to v' + data.version + (data.previous_version ? ' (was v' + data.previous_version + ')' : '')
      : '';
    // v2.1.13 R-RCPT-V2: name specific features waiting on the restart so users
    // know WHAT is dormant until they reload the session.
    const gatedList = Array.isArray(data.restart_gated_features)
      ? data.restart_gated_features.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    const gatedSuffix = gatedList.length
      ? ' New in this upgrade: ' + gatedList.join(', ') + '.'
      : '';
    process.stderr.write(
      '[orchestray] Upgraded' + versionSuffix + ' while this session was open — ' +
      'one-time reminder. RESTART to load new agents (this message won\'t repeat).' +
      gatedSuffix + '\n'
    );
    // v2.1.14 R-FLAGS: emit drift-sentinel migration note as a separate line so it
    // is not buried after the "won't repeat" boundary marker of the restart reminder.
    process.stderr.write(
      '[orchestray] v2.1.14 migration: enable_drift_sentinel default is now false. ' +
      'If you rely on drift-sentinel output, add \'"enable_drift_sentinel": true\' to ' +
      '.orchestray/config.json before your next orchestration.\n'
    );
    // v2.1.16 R-AUTODOC-OFF: auto_document default flipped from true to false.
    // The reviewer's documentation pass on every orchestration covers docs gaps,
    // so the auto-spawn was redundant insurance on typical workloads.
    process.stderr.write(
      '[orchestray] v2.1.16 migration: auto_document default is now false. ' +
      'The documenter agent no longer auto-spawns after every orchestration — ' +
      'the reviewer\'s documentation pass already audits docs drift. ' +
      'To restore prior behavior, add \'"auto_document": true\' to ' +
      '.orchestray/config.json.\n'
    );
    // v2.1.16 R-AT-FLAG: announce the agent_teams namespace rename + dual-gate.
    process.stderr.write(
      '[orchestray] v2.1.16 migration (R-AT-FLAG): the top-level "enable_agent_teams" key ' +
      'is renamed to the "agent_teams": { "enabled": ... } block. The legacy key is honored ' +
      'for one release with a deprecation warning. Default flips to OFF in v2.1.16. ' +
      'To re-enable Agent Teams, set BOTH \'"agent_teams": {"enabled": true}\' in ' +
      '.orchestray/config.json AND CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in your environment, ' +
      'then read agents/pm-reference/agent-teams-decision.md before using team mode.\n'
    );
    recordDegradation({
      kind: 'agent_registry_stale',
      severity: 'warn',
      detail: {
        installed_at: data.installed_at,
        session_started: sessionStartMs ? new Date(sessionStartMs).toISOString() : null,
        version: data.version || null,
        previous_version: data.previous_version || null,
        dedup_key: 'agent_registry_stale|' + (sessionId || 'unknown'),
      },
    });

    // Belt-and-suspenders: if the wx write failed earlier, try a plain
    // write now so future invocations still honour the dedup.
    if (!sentinelWritten) {
      try { fs.writeFileSync(sessionMarkerPath, '1', 'utf8'); } catch (_e) { /* ignore */ }
    }
  } catch (_e) {
    // Best-effort warning; never block the user prompt.
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// v2.1.7 Bundle D: one-time resilience-live notice
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Emit a one-time stderr notice that resilience shipped LIVE by default in
 * v2.1.7 and point operators at the kill-switch env var + config key.
 *
 * Dedup sentinel lives in `.orchestray/state/.resilience-live-noticed-2017`
 * so the message fires exactly once per upgraded install. Additionally
 * dedup-keyed per-session via `/tmp/orchestray-resilience-notice-<session>`
 * so that if the sweep runs multiple times in-session (shouldn't, but
 * defense in depth) the user only sees it once.
 *
 * Fresh installs (which already have the `resilience` config block) get the
 * sentinel seeded by `install.js` and see no notice — the behavior is only
 * surprising on an upgrade from v2.1.6, hence the one-time reminder.
 *
 * Fail-open: any I/O error is swallowed silently.
 *
 * @param {string} cwd       - Absolute project directory path.
 * @param {string|null} sessionId - Sanitized session id from hook payload.
 */
function emitResilienceLiveNotice(cwd, sessionId) {
  try {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    const sentinelPath = path.join(stateDir, '.resilience-live-noticed-2017');
    if (existsSilent(sentinelPath)) return;

    // Per-session dedup.
    const sid = sessionId ? String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) : 'unknown';
    const sessionMarker = path.join(os.tmpdir(), 'orchestray-resilience-notice-' + sid);
    if (existsSilent(sessionMarker)) return;

    process.stderr.write(
      '[orchestray] v2.1.7: compaction-resilience dossier is LIVE by default. ' +
      'After auto-compact, the PM re-hydrates from .orchestray/state/resilience-dossier.json. ' +
      'Disable with ORCHESTRAY_RESILIENCE_DISABLED=1 or resilience.enabled:false in .orchestray/config.json.\n'
    );

    // Best-effort: write the sentinel so future sessions skip the notice.
    touchSilent(sentinelPath, stateDir);
    try { fs.writeFileSync(sessionMarker, '1', 'utf8'); } catch (_e) { /* ignore */ }
  } catch (_e) {
    // Fail-open.
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// W8 helper: additive config.json migration (2013-W8-config-migration)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Return the default mcp_enforcement block. Uses the authoritative constant
 * exported by bin/_lib/config-schema.js (the single source of truth), so the
 * migration never hard-codes values that could drift from the runtime defaults.
 *
 * @returns {object} Shallow copy of DEFAULT_MCP_ENFORCEMENT
 */
function getDefaultMcpEnforcement() {
  return Object.assign({}, DEFAULT_MCP_ENFORCEMENT);
}

/**
 * Run the W8 config migration.
 *
 * Reads .orchestray/config.json, checks for the `mcp_enforcement` top-level
 * key, and additively fills in any missing sub-keys from the schema default.
 * Writes atomically via rename-dance. Touches the sentinel on success.
 *
 * @param {string} cwd     - Project root (absolute)
 * @param {string} stateDir - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to .config-migrated-2013
 */
function runW8Migration(cwd, stateDir, sentinelPath) {
  // 2013-W8-config-migration
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing or unreadable — nothing to migrate; touch sentinel so we
    // don't retry on every subsequent UserPromptSubmit.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  const defaults = getDefaultMcpEnforcement();
  const existing = parsed.mcp_enforcement;

  // Check whether the block is already complete (all schema keys present)
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const missingKeys = Object.keys(defaults).filter(k => !(k in existing));
    if (missingKeys.length === 0) {
      // All schema keys present — no-op.
      touchSilent(sentinelPath, stateDir);
      return;
    }
    // Partially present: fill in only the missing sub-keys, preserve all others
    // (including non-schema keys like _note).
    for (const k of missingKeys) {
      existing[k] = defaults[k];
    }
  } else {
    // Block absent entirely — add the full default block.
    parsed.mcp_enforcement = defaults;
  }

  // Atomic rename-dance write
  const tmpPath = configPath + '.sweep-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    // Write/rename failed — clean up temp file if it exists; fail-open.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W11 helper: mcp-checkpoint.jsonl ledger phase sweep (2013-W11-ledger-sweep)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W11 ledger migration.
 *
 * For each checkpoint row where phase === 'post-decomposition', applies the
 * BUG-B heuristic:
 *
 *   1. Find routing.jsonl entries matching the row's orchestration_id.
 *   2. If NO matching entries exist → row was poisoned by BUG-B. Flip phase.
 *   3. If matching entries exist BUT all have timestamps AFTER the checkpoint
 *      row's timestamp → row was written before decomposition. Flip phase.
 *   4. If matching entries exist AND at least one has a timestamp BEFORE the
 *      checkpoint row's timestamp → row is legitimately post-decomposition.
 *      Leave alone.
 *
 * Rows where phase !== 'post-decomposition' are never touched.
 * Adds `_migrated_from_phase: 'post-decomposition'` to every flipped row.
 * Writes the updated ledger atomically via rename-dance.
 *
 * @param {string} cwd     - Project root (absolute)
 * @param {string} stateDir - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to .mcp-checkpoint-migrated-2013
 */
function runW11Migration(cwd, stateDir, sentinelPath) {
  // 2013-W11-ledger-sweep
  if (existsSilent(sentinelPath)) return;

  const checkpointPath = path.join(stateDir, 'mcp-checkpoint.jsonl');
  const routingPath = path.join(stateDir, 'routing.jsonl');

  // Read ledger
  let ledgerRaw;
  try {
    ledgerRaw = fs.readFileSync(checkpointPath, 'utf8');
  } catch (_e) {
    // Ledger absent — nothing to sweep; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Parse ledger lines (skip malformed — fail-open)
  const lines = ledgerRaw.split('\n');
  const parsedLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return { raw: line, parsed: null };
    try {
      return { raw: line, parsed: JSON.parse(trimmed) };
    } catch (_e) {
      return { raw: line, parsed: null, malformed: true };
    }
  });

  // Check if any rows need inspection at all
  const needsWork = parsedLines.some(
    l => l.parsed && l.parsed.phase === 'post-decomposition'
  );
  if (!needsWork) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Read routing.jsonl for timestamp lookups (keyed by orchestration_id)
  const routingByOrch = buildRoutingIndex(routingPath);

  // Apply BUG-B heuristic to each post-decomposition row
  let anyFlipped = false;
  const outLines = parsedLines.map(({ raw, parsed, malformed }) => {
    if (!parsed || malformed) return raw; // Preserve malformed/blank lines as-is
    if (parsed.phase !== 'post-decomposition') return raw;

    const orchId = parsed.orchestration_id;
    const rowTs = parsed.timestamp || '';
    const routingEntries = routingByOrch[orchId] || [];

    let shouldFlip;
    if (routingEntries.length === 0) {
      // No routing entries for this orchestration_id → BUG-B poisoning. Flip.
      shouldFlip = true;
    } else {
      // Check if any routing entry has a timestamp strictly before this row.
      // Only flip if ALL routing entries are after the row (none precede it).
      const anyRoutingBefore = routingEntries.some(
        rts => rts < rowTs // ISO 8601 strings compare lexicographically correctly
      );
      shouldFlip = !anyRoutingBefore;
    }

    if (shouldFlip) {
      anyFlipped = true;
      const flipped = Object.assign({}, parsed, {
        phase: 'pre-decomposition',
        _migrated_from_phase: 'post-decomposition',
      });
      return JSON.stringify(flipped);
    }
    return raw;
  });

  if (!anyFlipped) {
    // Nothing changed — still touch the sentinel so we don't re-scan.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Atomic rename-dance write.
  // T2 F9: Preserve trailing-newline presence faithfully.  The standard JSONL
  // writer (atomicAppendJsonl) always ends files with '\n', so
  // ledgerRaw.endsWith('\n') is true for well-formed files.  outLines.join('\n')
  // reconstructs the original bytes correctly in that case (the split produced
  // a trailing empty string; join re-adds the final '\n').  For non-standard
  // inputs that lack a trailing newline we must NOT add one — doing so would
  // turn a one-liner-per-line file into one that ends with '\n', meaning the
  // NEXT atomicAppendJsonl append would produce a valid new line.  But more
  // importantly, we must not REMOVE the trailing newline from standard files.
  // Solution: detect the original state and use per-line newlines to guarantee
  // each line ends correctly regardless of origin.
  const hadTrailingNewline = ledgerRaw.endsWith('\n');
  const tmpPath = checkpointPath + '.migrated';
  try {
    // Each non-empty line gets its own '\n'.  Empty strings (trailing split
    // artifact from standard JSONL) are filtered out.  If the original file
    // had a trailing newline we preserve it via the per-line approach; if it
    // didn't, omitting the trailing element faithfully matches the original.
    let outContent;
    if (hadTrailingNewline) {
      outContent = outLines.filter(l => l.trim()).map(l => l + '\n').join('');
    } else {
      outContent = outLines.filter(l => l.trim()).join('\n');
    }
    fs.writeFileSync(tmpPath, outContent, 'utf8');
    fs.renameSync(tmpPath, checkpointPath);
  } catch (_e) {
    // Write/rename failed — clean up; fail-open.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

/**
 * Build an index from orchestration_id → sorted array of routing timestamps.
 * Returns an empty object if the routing file is missing or unreadable.
 * Malformed JSON lines are skipped silently (fail-open).
 *
 * @param {string} routingPath - Absolute path to routing.jsonl
 * @returns {Object.<string, string[]>} Map: orchestration_id → sorted ISO timestamps
 */
function buildRoutingIndex(routingPath) {
  let raw;
  try {
    raw = fs.readFileSync(routingPath, 'utf8');
  } catch (_e) {
    return {};
  }

  const index = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_e) {
      continue; // skip malformed
    }
    if (!entry || typeof entry !== 'object') continue;
    const orchId = entry.orchestration_id;
    const ts = entry.timestamp;
    if (!orchId || !ts) continue;
    if (!index[orchId]) index[orchId] = [];
    index[orchId].push(ts);
  }
  // Sort each array so binary search is possible (though we do linear search).
  for (const orchId of Object.keys(index)) {
    index[orchId].sort();
  }
  return index;
}

// ──────────────────────────────────────────────────────────────────────────────
// W3 helper: pricing-table seed (2014-W3-pricing-table-seed)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W3 pricing-table seed operation.
 *
 * Reads .orchestray/config.json and checks for the
 * mcp_server.cost_budget_check.pricing_table key. If absent, adds the default
 * pricing table using DEFAULT_COST_BUDGET_CHECK from config-schema.js (the
 * single source of truth). Never overwrites a user-customized pricing_table.
 *
 * Writes atomically via rename-dance. Touches the sentinel on success.
 * Fails open on every error — never blocks the user prompt.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to .pricing-table-migrated-2014
 */
function runW3PricingTableSeed(cwd, stateDir, sentinelPath) {
  // 2014-W3-pricing-table-seed
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing or unreadable — skip; touch sentinel so we don't retry.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Ensure mcp_server key exists
  if (!parsed.mcp_server || typeof parsed.mcp_server !== 'object' || Array.isArray(parsed.mcp_server)) {
    parsed.mcp_server = {};
  }

  // Check whether pricing_table is already present (user-customized or prior seed)
  const existing = parsed.mcp_server.cost_budget_check;
  if (
    existing &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    existing.pricing_table &&
    typeof existing.pricing_table === 'object' &&
    !Array.isArray(existing.pricing_table)
  ) {
    // pricing_table already exists — preserve user customization; just touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Seed the cost_budget_check block using DEFAULT_COST_BUDGET_CHECK.
  // Preserve any existing non-pricing_table keys in cost_budget_check.
  const costBudgetCheck = (existing && typeof existing === 'object' && !Array.isArray(existing))
    ? existing
    : {};

  costBudgetCheck.pricing_table = {
    haiku:  { input_per_1m: DEFAULT_COST_BUDGET_CHECK.pricing_table.haiku.input_per_1m,
               output_per_1m: DEFAULT_COST_BUDGET_CHECK.pricing_table.haiku.output_per_1m },
    sonnet: { input_per_1m: DEFAULT_COST_BUDGET_CHECK.pricing_table.sonnet.input_per_1m,
               output_per_1m: DEFAULT_COST_BUDGET_CHECK.pricing_table.sonnet.output_per_1m },
    opus:   { input_per_1m: DEFAULT_COST_BUDGET_CHECK.pricing_table.opus.input_per_1m,
               output_per_1m: DEFAULT_COST_BUDGET_CHECK.pricing_table.opus.output_per_1m },
  };
  if (!costBudgetCheck.last_verified) {
    costBudgetCheck.last_verified = DEFAULT_COST_BUDGET_CHECK.last_verified;
  }
  parsed.mcp_server.cost_budget_check = costBudgetCheck;

  // Atomic rename-dance write
  const tmpPath = configPath + '.w3-pricing-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    // Write/rename failed — clean up temp file if it exists; fail-open.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W5 helper: backfill new 2.0.15 mcp_enforcement keys (2015-W5-enforcement-keys)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W5 enforcement-keys backfill operation.
 *
 * Adds `pattern_record_skip_reason` and `cost_budget_check` to the
 * mcp_enforcement block in .orchestray/config.json if they are absent.
 * These keys were added to DEFAULT_MCP_ENFORCEMENT in 2.0.15 (T3 A1 fix);
 * existing installs won't have them — missing keys cause unknown_tool_policy
 * to evaluate those tool names, which can produce unexpected block/warn signals
 * if an operator set unknown_tool_policy:'block'.
 *
 * Idempotent sentinel: .orchestray/state/.enforcement-keys-migrated-2015.
 * Mirrors the W8 (2.0.13) and W3 (2.0.14) patterns.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to .enforcement-keys-migrated-2015
 */
function runW5EnforcementKeysMigration(cwd, stateDir, sentinelPath) {
  // 2015-W5-enforcement-keys
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing or unreadable — nothing to migrate; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // New keys introduced in 2.0.15 with their DEFAULT_MCP_ENFORCEMENT values.
  // kb_write is handled separately by the W6 migration below.
  const newKeys = ['pattern_record_skip_reason', 'cost_budget_check'];
  const defaults = getDefaultMcpEnforcement();

  const existing = parsed.mcp_enforcement;

  // Check whether the block exists at all
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    // Block absent entirely — the W8 migration should have added it; if not,
    // run W8 logic now to add the full default block (includes new keys).
    parsed.mcp_enforcement = defaults;
  } else {
    // Block present — check for missing new keys only.
    const missingKeys = newKeys.filter(k => !(k in existing));
    if (missingKeys.length === 0) {
      // All new keys already present — no-op.
      touchSilent(sentinelPath, stateDir);
      return;
    }
    for (const k of missingKeys) {
      existing[k] = defaults[k];
    }
  }

  // Atomic rename-dance write
  const tmpPath = configPath + '.w5-enforcement-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    // Write/rename failed — clean up temp file if it exists; fail-open.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W6 helper: backfill kb_write enable + enforcement key (2015-W6-kb-write-keys)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W6 kb_write key backfill.
 *
 * Adds `kb_write: true` to `mcp_server.tools` and `kb_write: 'allow'` to
 * `mcp_enforcement` in .orchestray/config.json if they are absent.
 * These keys were introduced in 2.0.15 (W6); existing installs won't have
 * them, causing unknown_tool_policy:'block' to block the new tool.
 *
 * Idempotent sentinel: .orchestray/state/.kb-write-migrated-2015.
 * Mirrors the W5 (2.0.15) pattern.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to .kb-write-migrated-2015
 */
function runW6KbWriteMigration(cwd, stateDir, sentinelPath) {
  // 2015-W6-kb-write-keys
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing or unreadable — nothing to migrate; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let changed = false;

  // 1. Backfill mcp_enforcement.kb_write
  const defaults = getDefaultMcpEnforcement();
  if (!parsed.mcp_enforcement || typeof parsed.mcp_enforcement !== 'object' || Array.isArray(parsed.mcp_enforcement)) {
    parsed.mcp_enforcement = defaults;
    changed = true;
  } else if (!('kb_write' in parsed.mcp_enforcement)) {
    parsed.mcp_enforcement.kb_write = defaults.kb_write;
    changed = true;
  }

  // 2. Backfill mcp_server.tools.kb_write
  if (!parsed.mcp_server || typeof parsed.mcp_server !== 'object' || Array.isArray(parsed.mcp_server)) {
    parsed.mcp_server = {};
  }
  if (!parsed.mcp_server.tools || typeof parsed.mcp_server.tools !== 'object' || Array.isArray(parsed.mcp_server.tools)) {
    parsed.mcp_server.tools = {};
  }
  if (!('kb_write' in parsed.mcp_server.tools)) {
    parsed.mcp_server.tools.kb_write = true;
    changed = true;
  }

  if (!changed) {
    // Both keys already present — no-op.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Atomic rename-dance write
  const tmpPath = configPath + '.w6-kb-write-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    // Write/rename failed — clean up temp file if it exists; fail-open.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W1 (2016): pattern_record_application default-flip backward-compat seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W1 2016 pattern_record_application seed.
 *
 * The 2.0.16 release (initial) changed DEFAULT_MCP_ENFORCEMENT.pattern_record_application
 * from 'hook' to 'hook-warn'; the 2.0.16 amendment flipped the default again to
 * 'hook-strict' (see runD2PatternRecordAppStageCSeed below). To preserve
 * backward compatibility for existing installs, W1 seeds the explicit prior
 * value 'hook' when the key is absent — this pre-empts D2 on the same upgrade
 * path, so existing installs stay on 'hook' (fully permissive) rather than the
 * new 'hook-strict' default. Fresh installs get 'hook-strict' from
 * DEFAULT_MCP_ENFORCEMENT. D2 only mutates when W1 did not run (e.g., config
 * existed pre-2.0.14 with an mcp_enforcement block but no pattern_record_application
 * key AND W1's sentinel was already touched).
 *
 * Idempotent sentinel: .orchestray/state/.pattern-record-app-migrated-2016.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW1PatternRecordAppSeed(cwd, stateDir, sentinelPath) {
  // 2016-W1-pattern-record-app-default-flip
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — touch sentinel; fresh installs will get new default.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  const existing = parsed.mcp_enforcement;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    // Block absent — W8/W5 migrations should have added it. If not, skip; the
    // full default block (now with 'hook-warn') will be seeded by W8 on next run.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If pattern_record_application is already explicitly set, preserve it.
  if ('pattern_record_application' in existing) {
    // Key present — no-op. Respect whatever the operator configured.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Key absent on an existing install — seed with prior value 'hook' so this
  // upgrade doesn't silently change behavior.
  existing.pattern_record_application = 'hook';

  const tmpPath = configPath + '.w1-2016-pra-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W5 (2016): cost_budget_enforcement block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W5 2016 cost_budget_enforcement seed.
 *
 * Adds `cost_budget_enforcement: {enabled: false, hard_block: true}` to
 * .orchestray/config.json if the block is absent. This ensures existing installs
 * get the explicit defaults rather than relying on runtime fallback, enabling
 * operators to discover and tune the new config key.
 *
 * hard_block is seeded as true to match the runtime default in
 * DEFAULT_COST_BUDGET_ENFORCEMENT. Operators who prefer soft-warn mode should
 * set hard_block: false explicitly in .orchestray/config.json.
 *
 * Idempotent sentinel: .orchestray/state/.cost-budget-enforcement-migrated-2016.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW5CostBudgetEnforcementSeed(cwd, stateDir, sentinelPath) {
  // 2016-W5-cost-budget-enforcement-seed
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.cost_budget_enforcement &&
    typeof parsed.cost_budget_enforcement === 'object' &&
    !Array.isArray(parsed.cost_budget_enforcement)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Seed the block with canonical defaults (enabled: false, hard_block: true).
  // hard_block: true matches DEFAULT_COST_BUDGET_ENFORCEMENT so fresh installs
  // and migrations both end at the same default unless the operator opts out.
  parsed.cost_budget_enforcement = { enabled: false, hard_block: true };

  const tmpPath = configPath + '.w5-2016-cbe-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W2 (2016): backfill new v2.0.16 MCP tool-enable keys + max_per_task seeds
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W2 2016 new-tools backfill.
 *
 * Adds new v2.0.16 tool-enable keys (`routing_lookup`, `cost_budget_reserve`)
 * to `mcp_server.tools` and their enforcement keys to `mcp_enforcement`, plus
 * seeds `mcp_server.max_per_task` with per-task rate-limit defaults for
 * `ask_user`, `kb_write`, and `pattern_record_application` (OQ4 values: 20).
 *
 * Idempotent sentinel: .orchestray/state/.v2016-new-tools-seeded.
 * Does not overwrite keys already present (additive-only per DEV1 convention).
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW2NewToolsSeed(cwd, stateDir, sentinelPath) {
  // 2016-W2-new-tools-seed
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — fresh install will get these via install.js; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let changed = false;

  // 1. Backfill mcp_enforcement keys for new tools
  const defaults = getDefaultMcpEnforcement();
  if (!parsed.mcp_enforcement || typeof parsed.mcp_enforcement !== 'object' || Array.isArray(parsed.mcp_enforcement)) {
    parsed.mcp_enforcement = defaults;
    changed = true;
  } else {
    for (const k of ['routing_lookup', 'cost_budget_reserve']) {
      if (!(k in parsed.mcp_enforcement)) {
        parsed.mcp_enforcement[k] = defaults[k];
        changed = true;
      }
    }
  }

  // 2. Backfill mcp_server.tools enable keys for new tools
  if (!parsed.mcp_server || typeof parsed.mcp_server !== 'object' || Array.isArray(parsed.mcp_server)) {
    parsed.mcp_server = {};
  }
  if (!parsed.mcp_server.tools || typeof parsed.mcp_server.tools !== 'object' || Array.isArray(parsed.mcp_server.tools)) {
    parsed.mcp_server.tools = {};
  }
  for (const toolKey of ['routing_lookup', 'cost_budget_reserve']) {
    if (!(toolKey in parsed.mcp_server.tools)) {
      parsed.mcp_server.tools[toolKey] = true;
      changed = true;
    }
  }

  // 3. Seed mcp_server.max_per_task defaults (OQ4: ask_user:20, kb_write:20, pra:20)
  if (!parsed.mcp_server.max_per_task || typeof parsed.mcp_server.max_per_task !== 'object' || Array.isArray(parsed.mcp_server.max_per_task)) {
    parsed.mcp_server.max_per_task = {};
  }
  const mptDefaults = { ask_user: 20, kb_write: 20, pattern_record_application: 20 };
  for (const [toolKey, defaultMax] of Object.entries(mptDefaults)) {
    if (!(toolKey in parsed.mcp_server.max_per_task)) {
      parsed.mcp_server.max_per_task[toolKey] = defaultMax;
      changed = true;
    }
  }

  if (!changed) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Atomic rename-dance write
  const tmpPath = configPath + '.w2-2016-new-tools-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// D1 (2016): pattern_deprecate tool enable seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Seed the pattern_deprecate tool enable key and its enforcement key for
 * existing installs that predate D1. Fresh installs get both via install.js.
 *
 * Idempotent sentinel: .orchestray/state/.pattern-deprecate-seeded-2016
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runD1PatternDeprecateSeed(cwd, stateDir, sentinelPath) {
  // D1-pattern-deprecate-seed-2016
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — fresh install gets seeds via install.js.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let changed = false;

  // Seed mcp_enforcement.pattern_deprecate = 'allow' when absent.
  // If the block is missing entirely, seed the full defaults (W6/W2 pattern)
  // so D1 is robust to execution-order changes (e.g., if W8 hasn't run yet).
  if (!parsed.mcp_enforcement || typeof parsed.mcp_enforcement !== 'object' || Array.isArray(parsed.mcp_enforcement)) {
    parsed.mcp_enforcement = getDefaultMcpEnforcement();
    changed = true;
  } else if (!('pattern_deprecate' in parsed.mcp_enforcement)) {
    parsed.mcp_enforcement.pattern_deprecate = getDefaultMcpEnforcement().pattern_deprecate;
    changed = true;
  }

  // Seed mcp_server.tools.pattern_deprecate = true when absent
  if (!parsed.mcp_server || typeof parsed.mcp_server !== 'object' || Array.isArray(parsed.mcp_server)) {
    parsed.mcp_server = {};
  }
  if (!parsed.mcp_server.tools || typeof parsed.mcp_server.tools !== 'object' || Array.isArray(parsed.mcp_server.tools)) {
    parsed.mcp_server.tools = {};
  }
  if (!('pattern_deprecate' in parsed.mcp_server.tools)) {
    parsed.mcp_server.tools.pattern_deprecate = true;
    changed = true;
  }

  if (!changed) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  const tmpPath = configPath + '.d1-2016-pd-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// D4 (2016): reservation ledger GC sweep
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run a one-time-per-session GC sweep of cost-reservations.jsonl to drop expired rows.
 *
 * The session lock already prevents this from running more than once per session.
 * Fail-silent throughout — GC failure must never block the user prompt.
 *
 * @param {string} cwd - Project root (absolute)
 */
function runD4ReservationGcSweep(cwd) {
  try {
    const { gcReservations } = require('./_lib/cost-helpers');
    gcReservations(cwd);
  } catch (_e) {
    // Fail-silent — GC error must not block the prompt.
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// D2 (2016 amendment): Stage C pattern_record_application default-flip seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the D2 Stage C seed.
 *
 * The D2 change flips DEFAULT_MCP_ENFORCEMENT.pattern_record_application from
 * 'hook-warn' to 'hook-strict'. To preserve backward compatibility for existing
 * installs, this migration seeds 'hook-warn' explicitly when the key is absent.
 *
 * IMPORTANT: on the common 2.0.15→2.0.16 upgrade path, runW12016 runs FIRST
 * and has already seeded 'hook' (the pre-2.0.14 value) into the same key. D2
 * then observes the key present and no-ops — leaving the install on 'hook'
 * (fully permissive), not 'hook-warn'. This is safer than the 'hook-warn' this
 * function documents for its own isolated contract. Fresh installs get
 * 'hook-strict' from DEFAULT_MCP_ENFORCEMENT.
 *
 * If the key is already explicitly set (any value, including 'hook-strict'),
 * it is preserved untouched. This respects the operator's intent.
 *
 * Idempotent sentinel: .orchestray/state/.pattern-record-app-stage-c-2016
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runD2PatternRecordAppStageCSeed(cwd, stateDir, sentinelPath) {
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Fresh install — will get new default ('hook-strict') via DEFAULT_MCP_ENFORCEMENT.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  const existing = parsed.mcp_enforcement;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    // mcp_enforcement block absent — user will get hook-strict from the new default.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Key already explicitly set — preserve it (operator intent).
  if ('pattern_record_application' in existing) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Key absent on an existing install — seed with 'hook-warn' (prior default) so
  // the upgrade does not silently activate blocking on an existing install.
  existing.pattern_record_application = 'hook-warn';

  const tmpPath = configPath + '.d2-2016-stage-c-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// D3 (2016 amendment): cost_budget_enforcement.hard_block default flip seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the D3 hard_block seed.
 *
 * Behaviour (revised in v2.0.16 preflight fix):
 *
 * - If the `cost_budget_enforcement` block is ABSENT → write the full default block
 *   (which has `hard_block: true`) so fresh installs and pre-W5 installs get the new
 *   default. Touch sentinel.
 * - If the block EXISTS → no-op. Preserve the operator's explicit settings, including
 *   any explicit `hard_block: false` choice for soft-block mode. Touch sentinel.
 *
 * Rationale: DEFAULT_COST_BUDGET_ENFORCEMENT (hard_block: true) already covers fresh
 * installs via the config initialisation path. D3 only needs to back-fill the block
 * when it is completely absent. Writing over an existing block would silently convert
 * an operator who chose soft-block (hard_block: false) to hard-blocking behaviour on
 * their next `enabled: true` activation.
 *
 * Idempotent sentinel: .orchestray/state/.cost-budget-hard-block-default-2016
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runD3CostBudgetHardBlockSeed(cwd, stateDir, sentinelPath) {
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Fresh install — will get new default (hard_block: true) via DEFAULT_COST_BUDGET_ENFORCEMENT.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  const block = parsed.cost_budget_enforcement;
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    // Block exists — preserve operator's settings (including hard_block: false).
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed the full default block so the operator gets hard_block: true
  // on a fresh activation of cost_budget_enforcement.
  parsed.cost_budget_enforcement = Object.assign({}, DEFAULT_COST_BUDGET_ENFORCEMENT);

  const tmpPath = configPath + '.d3-2016-hard-block-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// D5 (2016 amendment): mcp_server.cost_budget_reserve.ttl_minutes seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the D5 cost_budget_reserve.ttl_minutes seed.
 *
 * Seeds mcp_server.cost_budget_reserve: { ttl_minutes: 30 } when the key is absent.
 * Makes the config key discoverable to operators who want to tune the TTL.
 * Preserves any existing value.
 *
 * Idempotent sentinel: .orchestray/state/.cost-budget-reserve-ttl-seed-2016
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runD5CostBudgetReserveTTLSeed(cwd, stateDir, sentinelPath) {
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Ensure mcp_server block exists.
  if (!parsed.mcp_server || typeof parsed.mcp_server !== 'object' || Array.isArray(parsed.mcp_server)) {
    parsed.mcp_server = {};
  }

  // If cost_budget_reserve sub-block already has ttl_minutes, preserve.
  const reserveBlock = parsed.mcp_server.cost_budget_reserve;
  if (
    reserveBlock &&
    typeof reserveBlock === 'object' &&
    !Array.isArray(reserveBlock) &&
    'ttl_minutes' in reserveBlock
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Seed ttl_minutes: 30 (default).
  if (!reserveBlock || typeof reserveBlock !== 'object' || Array.isArray(reserveBlock)) {
    parsed.mcp_server.cost_budget_reserve = { ttl_minutes: 30 };
  } else {
    parsed.mcp_server.cost_budget_reserve.ttl_minutes = 30;
  }

  const tmpPath = configPath + '.d5-2016-reserve-ttl-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// D7 (2016 amendment): routing_gate.auto_seed_on_miss seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the D7 routing_gate.auto_seed_on_miss seed.
 *
 * Seeds routing_gate: { auto_seed_on_miss: true } when the block is absent.
 * Makes the config key discoverable to operators who want to disable auto-seeding.
 * Preserves any existing routing_gate block.
 *
 * Idempotent sentinel: .orchestray/state/.routing-gate-auto-seed-2016
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runD7RoutingGateAutoSeedSeed(cwd, stateDir, sentinelPath) {
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If routing_gate block already exists, preserve it entirely.
  if (
    parsed.routing_gate &&
    typeof parsed.routing_gate === 'object' &&
    !Array.isArray(parsed.routing_gate)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Seed the block with default (auto_seed_on_miss: true).
  parsed.routing_gate = { auto_seed_on_miss: true };

  const tmpPath = configPath + '.d7-2016-routing-gate-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// T4 (2017): v2017_experiments block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the T4 v2017_experiments seed.
 *
 * If the `v2017_experiments` top-level block is absent, adds it with all keys
 * defaulted to their off state. If the block is present, fills in any missing
 * keys (additive-only — existing operator values are preserved).
 *
 * Idempotent sentinel: .orchestray/state/.v2017-experiments-seeded
 * Mirrors the pattern used by W3, W5, W6, D5, D7, and other config migrations.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runT4V2017ExperimentsSeed(cwd, stateDir, sentinelPath) {
  // T4-v2017-experiments-seed
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — fresh install will get the block via install.js; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  const existing = parsed.v2017_experiments;
  const defaults = DEFAULT_V2017_EXPERIMENTS;

  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    // Block present — fill in only missing keys (additive-only; preserve operator values).
    const missingKeys = Object.keys(defaults).filter(k => !(k in existing));
    if (missingKeys.length === 0) {
      // All schema keys present — no-op.
      touchSilent(sentinelPath, stateDir);
      return;
    }
    for (const k of missingKeys) {
      existing[k] = defaults[k];
    }
  } else {
    // Block absent entirely — add the full default block.
    parsed.v2017_experiments = Object.assign({}, defaults);
  }

  // Atomic rename-dance write
  const tmpPath = configPath + '.t4-2017-experiments-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    // Write/rename failed — clean up temp file if it exists; fail-open.
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// T5 helper: backfill metrics_query tool enable + enforcement keys (2017-T5-metrics-query-seed)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Seed `mcp_server.tools.metrics_query = true` and
 * `mcp_enforcement.metrics_query = 'allow'` on existing installs that predate v2.0.17.
 * Fresh installs get both values via install.js and DEFAULT_MCP_ENFORCEMENT.
 *
 * Idempotent sentinel: .orchestray/state/.metrics-query-seeded-2017
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runT5MetricsQuerySeed(cwd, stateDir, sentinelPath) {
  // T5-metrics-query-seed
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — fresh install will get these via install.js; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let changed = false;

  // 1. Backfill mcp_enforcement.metrics_query = 'allow'
  const defaults = getDefaultMcpEnforcement();
  if (!parsed.mcp_enforcement || typeof parsed.mcp_enforcement !== 'object' || Array.isArray(parsed.mcp_enforcement)) {
    parsed.mcp_enforcement = defaults;
    changed = true;
  } else if (!('metrics_query' in parsed.mcp_enforcement)) {
    parsed.mcp_enforcement.metrics_query = defaults.metrics_query;
    changed = true;
  }

  // 2. Backfill mcp_server.tools.metrics_query = true
  if (!parsed.mcp_server || typeof parsed.mcp_server !== 'object' || Array.isArray(parsed.mcp_server)) {
    parsed.mcp_server = {};
  }
  if (!parsed.mcp_server.tools || typeof parsed.mcp_server.tools !== 'object' || Array.isArray(parsed.mcp_server.tools)) {
    parsed.mcp_server.tools = {};
  }
  if (!('metrics_query' in parsed.mcp_server.tools)) {
    parsed.mcp_server.tools.metrics_query = true;
    changed = true;
  }

  if (!changed) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Atomic rename-dance write
  const tmpPath = configPath + '.t5-2017-metrics-query-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// T12 (2017): cache_choreography config block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the T12 cache_choreography seed.
 *
 * If the `cache_choreography` top-level block is absent, adds it with all keys
 * at their safe defaults (pre_commit_guard_enabled: false — opt-in only).
 * If the block is present, preserves it entirely (operator intent).
 *
 * Idempotent sentinel: .orchestray/state/.cache-choreography-seeded-2017
 * Mirrors the pattern used by runT4V2017ExperimentsSeed.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runT12CacheChoreographySeed(cwd, stateDir, sentinelPath) {
  // T12-cache-choreography-seed-2017
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — fresh install will get the block via install.js; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.cache_choreography &&
    typeof parsed.cache_choreography === 'object' &&
    !Array.isArray(parsed.cache_choreography)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed with canonical defaults.
  parsed.cache_choreography = Object.assign({}, DEFAULT_CACHE_CHOREOGRAPHY);

  const tmpPath = configPath + '.t12-2017-cache-choreography-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W9 (2018): pattern_decay config block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W9 pattern_decay seed.
 *
 * If the `pattern_decay` top-level block is absent, adds it with canonical
 * defaults (default_half_life_days: 90, category_overrides: {}). If the block
 * is present, preserves it entirely (operator intent).
 *
 * Idempotent sentinel: .orchestray/state/.pattern-decay-seeded-2018
 * Mirrors the pattern used by runT12CacheChoreographySeed.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW9PatternDecaySeed(cwd, stateDir, sentinelPath) {
  // W9-pattern-decay-seed-2018
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    // Config missing — fresh install will get the block via install.js; touch sentinel.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    // Malformed JSON — leave file untouched; fail-open.
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.pattern_decay &&
    typeof parsed.pattern_decay === 'object' &&
    !Array.isArray(parsed.pattern_decay)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed with canonical defaults. Use empty object for
  // category_overrides (rather than null) so operators can add entries directly.
  parsed.pattern_decay = {
    default_half_life_days: DEFAULT_PATTERN_DECAY.default_half_life_days,
    category_overrides: {},
  };

  const tmpPath = configPath + '.w9-2018-pattern-decay-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  try {
    writeEvent({
      type: 'config_key_seeded',
      key: 'pattern_decay',
      release: '2.0.18',
    }, { cwd });
  } catch (_e) {
    // Audit failure is non-fatal.
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W12 (2018): anti_pattern_gate config block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W12 anti_pattern_gate seed.
 *
 * If the `anti_pattern_gate` top-level block is absent, adds it with canonical
 * defaults (enabled: true, min_decayed_confidence: 0.65, max_advisories_per_spawn: 1).
 * If the block is present, preserves it entirely (operator intent).
 *
 * Idempotent sentinel: .orchestray/state/.anti-pattern-gate-seeded-2018
 * Mirrors the pattern used by runT12CacheChoreographySeed.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW12AntiPatternGateSeed(cwd, stateDir, sentinelPath) {
  // W12-anti-pattern-gate-seed-2018
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.anti_pattern_gate &&
    typeof parsed.anti_pattern_gate === 'object' &&
    !Array.isArray(parsed.anti_pattern_gate)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed with canonical defaults.
  parsed.anti_pattern_gate = Object.assign({}, DEFAULT_ANTI_PATTERN_GATE);

  const tmpPath = configPath + '.w12-2018-anti-pattern-gate-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  try {
    writeEvent({
      type: 'config_key_seeded',
      key: 'anti_pattern_gate',
      release: '2.0.18',
    }, { cwd });
  } catch (_e) {
    // Audit failure is non-fatal.
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W7 (2018): state_sentinel config block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W7 state_sentinel seed.
 *
 * If the `state_sentinel` top-level block is absent, adds it with canonical
 * defaults (pause_check_enabled: true, cancel_grace_seconds: 5). If the block
 * is present, preserves it entirely (operator intent).
 *
 * Idempotent sentinel: .orchestray/state/.state-sentinel-seeded-2018
 * Mirrors the pattern used by runT22AdaptiveVerbositySeed.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW7StateSentinelSeed(cwd, stateDir, sentinelPath) {
  // W7-state-sentinel-seed-2018
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.state_sentinel &&
    typeof parsed.state_sentinel === 'object' &&
    !Array.isArray(parsed.state_sentinel)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed with canonical defaults.
  parsed.state_sentinel = Object.assign({}, DEFAULT_STATE_SENTINEL);

  const tmpPath = configPath + '.w7-2018-state-sentinel-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  try {
    writeEvent({
      type: 'config_key_seeded',
      key: 'state_sentinel',
      release: '2.0.18',
    }, { cwd });
  } catch (_e) {
    // Audit failure is non-fatal.
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// W8 (2018): redo_flow config block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the W8 redo_flow seed.
 *
 * If the `redo_flow` top-level block is absent, adds it with canonical
 * defaults (max_cascade_depth: 10, commit_prefix: "redo"). If the block
 * is present, preserves it entirely (operator intent).
 *
 * Idempotent sentinel: .orchestray/state/.redo-flow-seeded-2018
 * Mirrors the pattern used by runT22AdaptiveVerbositySeed.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runW8RedoFlowSeed(cwd, stateDir, sentinelPath) {
  // W8-redo-flow-seed-2018
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.redo_flow &&
    typeof parsed.redo_flow === 'object' &&
    !Array.isArray(parsed.redo_flow)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed with canonical defaults.
  parsed.redo_flow = Object.assign({}, DEFAULT_REDO_FLOW);

  const tmpPath = configPath + '.w8-2018-redo-flow-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  try {
    writeEvent({
      type: 'config_key_seeded',
      key: 'redo_flow',
      release: '2.0.18',
    }, { cwd });
  } catch (_e) {
    // Audit failure is non-fatal.
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// FC3b (2018): legacy key auto-strip
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Strip pm_prompt_variant and pm_prose_strip from .orchestray/config.json if
 * present. Emits a config_key_stripped audit event listing the keys removed.
 *
 * Idempotent: if neither key is present the function is a no-op and no event
 * is emitted. Running twice has the same net effect as running once.
 *
 * Fails open on every error — never blocks the user prompt.
 *
 * @param {string} cwd      - Project root (absolute)
 * @param {string} stateDir - Absolute path to .orchestray/state/ (unused, kept for call-site symmetry)
 */
function runFC3bLegacyKeyStrip(cwd, _stateDir) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    return; // Config absent — nothing to strip.
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return; // Malformed config — fail-open, do not corrupt.
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return;
  }

  // Top-level legacy keys to strip.
  const topLevelToStrip = ['pm_prompt_variant', 'pm_prose_strip'];
  const strippedTopLevel = topLevelToStrip.filter(k => k in parsed);

  for (const k of strippedTopLevel) {
    delete parsed[k];
  }

  // Strip pm_prose_strip from v2017_experiments sub-object if present.
  let strippedInExperiments = false;
  if (
    parsed.v2017_experiments &&
    typeof parsed.v2017_experiments === 'object' &&
    !Array.isArray(parsed.v2017_experiments) &&
    'pm_prose_strip' in parsed.v2017_experiments
  ) {
    delete parsed.v2017_experiments.pm_prose_strip;
    strippedInExperiments = true;
  }

  const anyStripped = strippedTopLevel.length > 0 || strippedInExperiments;

  if (!anyStripped) {
    return; // Idempotent no-op — nothing to do.
  }

  const tmpPath = configPath + '.fc3b-2018-strip-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  // Emit audit event only for top-level key removals (fail-open).
  // Sub-object cleanup is silent — it accompanies the top-level strip.
  if (strippedTopLevel.length > 0) {
    try {
      writeEvent({
        type: 'config_key_stripped',
        keys_stripped: strippedTopLevel,
        release: '2.0.18',
      }, { cwd });
    } catch (_e) {
      // Audit failure is non-fatal.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// T22 (2017): adaptive_verbosity config block seed
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the T22 adaptive_verbosity seed.
 *
 * If the `adaptive_verbosity` top-level block is absent, adds it with all keys
 * at their safe defaults (enabled: false — opt-in only).
 * If the block is present, preserves it entirely (operator intent).
 *
 * Idempotent sentinel: .orchestray/state/.adaptive-verbosity-seeded-2017
 * Mirrors the pattern used by runW5CostBudgetEnforcementSeed.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to sentinel file
 */
function runT22AdaptiveVerbositySeed(cwd, stateDir, sentinelPath) {
  // T22-adaptive-verbosity-seed-2017
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If block already present, preserve user's values — no-op.
  if (
    parsed.adaptive_verbosity &&
    typeof parsed.adaptive_verbosity === 'object' &&
    !Array.isArray(parsed.adaptive_verbosity)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Block absent — seed with canonical defaults.
  parsed.adaptive_verbosity = Object.assign({}, DEFAULT_ADAPTIVE_VERBOSITY);

  const tmpPath = configPath + '.t22-2017-adaptive-verbosity-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// v2.1.16 R-AT-FLAG: enable_agent_teams → agent_teams.enabled migration
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Run the v2.1.16 R-AT-FLAG config migration.
 *
 * For installs that still have the legacy top-level `enable_agent_teams`
 * boolean, this helper additively seeds the new namespaced
 * `agent_teams: { enabled: <legacy_value> }` block when absent. The legacy
 * key is LEFT IN PLACE for one release so existing readers continue to work;
 * the runtime deprecation warning fires from the banner above. Fail-open on
 * every error — never blocks the user prompt.
 *
 * Idempotent: if `agent_teams` is already present (regardless of internal
 * shape), the helper makes no further changes.
 *
 * @param {string} cwd          - Project root (absolute)
 * @param {string} stateDir     - Absolute path to .orchestray/state/
 * @param {string} sentinelPath - Absolute path to .agent-teams-namespace-migrated-2116
 */
function runRAtFlagMigration(cwd, stateDir, sentinelPath) {
  if (existsSilent(sentinelPath)) return;

  const configPath = path.join(cwd, '.orchestray', 'config.json');

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // If new namespace already present, no-op.
  if (
    parsed.agent_teams &&
    typeof parsed.agent_teams === 'object' &&
    !Array.isArray(parsed.agent_teams)
  ) {
    touchSilent(sentinelPath, stateDir);
    return;
  }

  // Seed the new namespace from the legacy value when present, else default OFF.
  const legacy = typeof parsed.enable_agent_teams === 'boolean'
    ? parsed.enable_agent_teams
    : false;
  parsed.agent_teams = { enabled: legacy };

  const tmpPath = configPath + '.r-at-flag-2116-tmp';
  try {
    const out = JSON.stringify(parsed, null, 2) + '\n';
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (_e) {
    try { fs.unlinkSync(tmpPath); } catch (_e2) {}
    return;
  }

  touchSilent(sentinelPath, stateDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Return true if the path exists (any kind). Swallows all errors → false.
 */
function existsSilent(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Touch a sentinel file (empty content). Ensures stateDir exists first.
 * Swallows all errors — fail-open.
 */
function touchSilent(sentinelPath, stateDir) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sentinelPath, '', 'utf8');
  } catch (_e) {
    // Swallow — sentinel creation is best-effort.
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────────

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });

  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] post-upgrade-sweep: stdin exceeded limit; aborting\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });

  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const sessionId = (data.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const cwd = resolveSafeCwd(data.cwd);
      const stateDir = path.join(cwd, '.orchestray', 'state');

      // v2.0.21: emit upgrade-pending warning BEFORE the session lock so it
      // fires on the first UserPromptSubmit per session, not only the first
      // ever (the lock blocks subsequent runs but the warning's own
      // per-session marker handles in-session deduplication).
      emitUpgradePendingWarning(sessionId, cwd);

      // v2.1.7 Bundle D: one-time notice that resilience is live by default.
      // Emitted once per upgraded install (sentinel file in state dir).
      // No-op on fresh installs — install.js creates the sentinel pre-emptively
      // so fresh users don't see the notice. Kill-switch reminder is valuable
      // either way, but only surprising on an upgrade.
      emitResilienceLiveNotice(cwd, sessionId);

      // ── Session lock: fast-path — once per session ──────────────────────────
      const lockPath = path.join(os.tmpdir(), `orchestray-sweep-${sessionId}.lock`);
      if (existsSilent(lockPath)) {
        process.stdout.write(JSON.stringify({ continue: true }) + '\n');
        process.exit(0);
      }
      // Write session lock (best-effort; a race here is acceptable — the worst
      // outcome is two sweeps running concurrently on the FIRST UserPromptSubmit
      // in a session, which is harmless because each sub-operation uses a
      // per-upgrade sentinel for exactly-once semantics).
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, '', 'utf8');
      } catch (_e) {
        // Lock write failed — proceed anyway (fail-open).
      }

      // ── Per-operation sentinels ─────────────────────────────────────────────
      const configSentinel = path.join(stateDir, '.config-migrated-2013');
      const checkpointSentinel = path.join(stateDir, '.mcp-checkpoint-migrated-2013');
      const pricingTableSentinel = path.join(stateDir, '.pricing-table-migrated-2014');
      const enforcementKeysSentinel = path.join(stateDir, '.enforcement-keys-migrated-2015');
      const kbWriteKeysSentinel = path.join(stateDir, '.kb-write-migrated-2015');
      const patternRecordAppSentinel = path.join(stateDir, '.pattern-record-app-migrated-2016');
      const costBudgetEnforcementSentinel = path.join(stateDir, '.cost-budget-enforcement-migrated-2016');
      const newToolsSeedSentinel = path.join(stateDir, '.v2016-new-tools-seeded');
      // D2/D3/D5/D7 (v2.0.16 amendment): distinct sentinels that do not collide with above.
      const patternRecordAppStageCSentinel = path.join(stateDir, '.pattern-record-app-stage-c-2016');
      const costBudgetHardBlockSentinel = path.join(stateDir, '.cost-budget-hard-block-default-2016');
      const costBudgetReserveTTLSentinel = path.join(stateDir, '.cost-budget-reserve-ttl-seed-2016');
      const routingGateAutoSeedSentinel = path.join(stateDir, '.routing-gate-auto-seed-2016');
      // D1/D4 (v2.0.16 amendment): pattern_deprecate seed + reservation GC.
      const patternDeprecateSeedSentinel = path.join(stateDir, '.pattern-deprecate-seeded-2016');
      // T4 (v2.0.17): v2017_experiments block seed.
      const v2017ExperimentsSentinel = path.join(stateDir, '.v2017-experiments-seeded');
      // T5 (v2.0.17): metrics_query tool enable + enforcement seed.
      const metricsQuerySeedSentinel = path.join(stateDir, '.metrics-query-seeded-2017');
      // T12 (v2.0.17): cache_choreography config block seed.
      const cacheChoreographySeedSentinel = path.join(stateDir, '.cache-choreography-seeded-2017');
      // T22 (v2.0.17): adaptive_verbosity config block seed.
      const adaptiveVerbositySeedSentinel = path.join(stateDir, '.adaptive-verbosity-seeded-2017');
      // W9 (v2.0.18): pattern_decay config block seed.
      const patternDecaySeedSentinel = path.join(stateDir, '.pattern-decay-seeded-2018');
      // W12 (v2.0.18): anti_pattern_gate config block seed.
      const antiPatternGateSeedSentinel = path.join(stateDir, '.anti-pattern-gate-seeded-2018');
      // W7 (v2.0.18): state_sentinel config block seed.
      const stateSentinelSeedSentinel = path.join(stateDir, '.state-sentinel-seeded-2018');
      // W8 (v2.0.18): redo_flow config block seed.
      const redoFlowSeedSentinel = path.join(stateDir, '.redo-flow-seeded-2018');
      // v2.1.16 R-AT-FLAG: enable_agent_teams → agent_teams.enabled migration sentinel.
      const rAtFlagSentinel = path.join(stateDir, '.agent-teams-namespace-migrated-2116');

      // ── W8: config migration ────────────────────────────────────────────────
      try {
        runW8Migration(cwd, stateDir, configSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error in W8 must not block the prompt.
      }

      // ── W11: ledger phase sweep ─────────────────────────────────────────────
      try {
        runW11Migration(cwd, stateDir, checkpointSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error in W11 must not block the prompt.
      }

      // ── W3: pricing-table seed ──────────────────────────────────────────────
      try {
        runW3PricingTableSeed(cwd, stateDir, pricingTableSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error in W3 must not block the prompt.
      }

      // ── W5: 2.0.15 enforcement keys backfill ───────────────────────────────
      try {
        runW5EnforcementKeysMigration(cwd, stateDir, enforcementKeysSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error in W5 must not block the prompt.
      }

      // ── W6: kb_write enable + enforcement key backfill ─────────────────────
      try {
        runW6KbWriteMigration(cwd, stateDir, kbWriteKeysSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error in W6 must not block the prompt.
      }

      // ── W1 (2016): pattern_record_application default-flip seed ────────────
      // Preserve backward compatibility: existing installs that had
      // pattern_record_application explicitly set to 'hook' keep 'hook'.
      // Installs with no explicit key get the new default ('hook-strict' after
      // the 2.0.16 amendment) from DEFAULT_MCP_ENFORCEMENT. This migration
      // seeds 'hook' explicitly on UPGRADE so the new default only affects
      // fresh installs — W1 pre-empts D2 on this path; see D2 docblock.
      try {
        runW1PatternRecordAppSeed(cwd, stateDir, patternRecordAppSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error must not block the prompt.
      }

      // ── W5 (2016): cost_budget_enforcement block seed ──────────────────────
      try {
        runW5CostBudgetEnforcementSeed(cwd, stateDir, costBudgetEnforcementSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error must not block the prompt.
      }

      // ── W2 (2016): new-tools enable + max_per_task rate-limit seed ─────────
      // Backfills routing_lookup + cost_budget_reserve enable keys and seeds
      // max_per_task defaults for ask_user, kb_write, pattern_record_application.
      try {
        runW2NewToolsSeed(cwd, stateDir, newToolsSeedSentinel);
      } catch (_e) {
        // Fail-open: any unexpected error must not block the prompt.
      }

      // ── D2 (2016 amendment): Stage C default-flip seed ─────────────────────
      // Preserves backward compat: existing installs with no explicit
      // pattern_record_application key get 'hook-warn' seeded so the new
      // 'hook-strict' default only affects fresh installs.
      try {
        runD2PatternRecordAppStageCSeed(cwd, stateDir, patternRecordAppStageCSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── D3 (2016 amendment): hard_block default flip seed ──────────────────
      // For existing installs that already have cost_budget_enforcement block,
      // preserve their explicit hard_block value. Only affects fresh installs
      // (via DEFAULT_COST_BUDGET_ENFORCEMENT) and absent-key installs.
      try {
        runD3CostBudgetHardBlockSeed(cwd, stateDir, costBudgetHardBlockSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── D5 (2016 amendment): cost_budget_reserve.ttl_minutes seed ──────────
      // Seeds mcp_server.cost_budget_reserve.ttl_minutes = 30 on installs that
      // lack the key, making the config discoverable to operators.
      try {
        runD5CostBudgetReserveTTLSeed(cwd, stateDir, costBudgetReserveTTLSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── D7 (2016 amendment): routing_gate.auto_seed_on_miss seed ───────────
      // Seeds routing_gate: { auto_seed_on_miss: true } on installs that lack the
      // block, making the DX safety net discoverable and operator-overridable.
      try {
        runD7RoutingGateAutoSeedSeed(cwd, stateDir, routingGateAutoSeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── D1 (2016 amendment): pattern_deprecate tool enable seed ────────────
      try {
        runD1PatternDeprecateSeed(cwd, stateDir, patternDeprecateSeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── D4 (2016 amendment): reservation ledger GC sweep ──────────────────
      // Session-scoped (runs once per session via the shared session lock above).
      // No sentinel needed — the session lock prevents repeat execution.
      try {
        runD4ReservationGcSweep(cwd);
      } catch (_e) {
        // Fail-open.
      }

      // ── T4 (2017): v2017_experiments block seed ────────────────────────────
      // Adds v2017_experiments with all flags defaulted off on existing installs
      // that predate v2.0.17. Fresh installs get the block via install.js.
      try {
        runT4V2017ExperimentsSeed(cwd, stateDir, v2017ExperimentsSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── T5 (2017): metrics_query tool enable + enforcement seed ────────────
      // Backfills mcp_server.tools.metrics_query and mcp_enforcement.metrics_query
      // on existing installs. Fresh installs get both via install.js defaults.
      try {
        runT5MetricsQuerySeed(cwd, stateDir, metricsQuerySeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── T12 (2017): cache_choreography config block seed ──────────────────
      // Seeds cache_choreography: { pre_commit_guard_enabled: false, ... } on
      // existing installs that lack the block. Fresh installs get it via install.js.
      try {
        runT12CacheChoreographySeed(cwd, stateDir, cacheChoreographySeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── T22 (2017): adaptive_verbosity config block seed ──────────────────
      // Seeds adaptive_verbosity: { enabled: false, ... } on existing installs
      // that lack the block. Fresh installs get it via install.js.
      try {
        runT22AdaptiveVerbositySeed(cwd, stateDir, adaptiveVerbositySeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── W9 (2018): pattern_decay config block seed ────────────────────────
      // Seeds pattern_decay: { default_half_life_days: 90, category_overrides: {} }
      // on existing installs that lack the block. Fresh installs get it via install.js.
      try {
        runW9PatternDecaySeed(cwd, stateDir, patternDecaySeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── W12 (2018): anti_pattern_gate config block seed ───────────────────
      // Seeds anti_pattern_gate defaults on existing installs that lack the block.
      // Fresh installs get it via install.js.
      try {
        runW12AntiPatternGateSeed(cwd, stateDir, antiPatternGateSeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── W7 (2018): state_sentinel config block seed ───────────────────────
      // Seeds state_sentinel defaults on existing installs that lack the block.
      // Fresh installs get it via install.js.
      try {
        runW7StateSentinelSeed(cwd, stateDir, stateSentinelSeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── W8 (2018): redo_flow config block seed ────────────────────────────
      // Seeds redo_flow defaults on existing installs that lack the block.
      // Fresh installs get it via install.js.
      try {
        runW8RedoFlowSeed(cwd, stateDir, redoFlowSeedSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── R-AT-FLAG (v2.1.16): agent_teams namespace migration ───────────────
      // Seeds agent_teams: { enabled: <legacy_or_false> } from the legacy
      // top-level enable_agent_teams boolean. Legacy key is left in place
      // for one release; the deprecation banner above announces the rename.
      try {
        runRAtFlagMigration(cwd, stateDir, rAtFlagSentinel);
      } catch (_e) {
        // Fail-open.
      }

      // ── FC3b (2018): strip legacy pm_prompt_variant + pm_prose_strip keys ──
      // Auto-strips both keys on every invocation — idempotent (no-op when absent).
      // No sentinel needed: the function itself checks for key presence.
      try {
        runFC3bLegacyKeyStrip(cwd, stateDir);
      } catch (_e) {
        // Fail-open.
      }

    } catch (_e) {
      // Top-level parse failure or any other unexpected error — pass through.
    }

    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
}

main();
