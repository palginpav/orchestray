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
const { DEFAULT_MCP_ENFORCEMENT, DEFAULT_COST_BUDGET_CHECK } = require('./_lib/config-schema');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

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

    } catch (_e) {
      // Top-level parse failure or any other unexpected error — pass through.
    }

    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
}

main();
