#!/usr/bin/env node
'use strict';

/**
 * emit-tier2-load.js — PostToolUse:Read hook (R-TEL, v2.1.12).
 *
 * Emits a `tier2_load` audit event whenever a Read tool call targets a file
 * in `agents/pm-reference/` that is NOT in the always-loaded set. This gives
 * the measurement signal needed to retroactively verify R1/R2/R3 effectiveness.
 *
 * Always-loaded files (excluded from tier-2 allowlist, per pm.md §"Section Loading Protocol"):
 *   - tier1-orchestration.md  (loaded every orchestration via explicit Read directive)
 *   - scoring-rubrics.md      (always-available)
 *   - specialist-protocol.md  (always-available)
 *   - delegation-templates.md (always-available)
 *
 * Fail-open contract: any error → exit 0, never blocks the Read tool.
 * Kill-switch: ORCHESTRAY_METRICS_DISABLED=1 or ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1
 * skips event emission. Also honours config.telemetry.tier2_tracking.enabled=false.
 *
 * v2.1.14 R-TGATE additions: emitted event now carries `version: 1`, `bytes` (file
 * size at read time), and `turn_number` (from hook payload when available).
 *
 * Input:  JSON on stdin (Claude Code PostToolUse:Read hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs   = require('fs');
const path = require('path');

const { writeEvent }             = require('./_lib/audit-event-writer');
const { resolveSafeCwd }         = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }        = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Always-loaded set — these files are EXCLUDED from the tier-2 allowlist.
// Keep this list in sync with pm.md §"Always-Available Reference Files" and
// the always-loaded Tier-1 directive.
// ---------------------------------------------------------------------------
const ALWAYS_LOADED = new Set([
  'tier1-orchestration.md',
  'scoring-rubrics.md',
  'specialist-protocol.md',
  'delegation-templates.md',
]);

/**
 * Return true if `filePath` is a tier-2 pm-reference file (i.e. it lives
 * under `agents/pm-reference/` and is NOT in the always-loaded set).
 *
 * Accepts both absolute paths and relative paths (resolved against cwd).
 *
 * @param {string} filePath - The file_path from tool_input.
 * @returns {boolean}
 */
function isTier2File(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;

  // Normalize separators and extract the last two path segments so the check
  // works for both absolute (/home/user/repo/agents/pm-reference/foo.md) and
  // relative (agents/pm-reference/foo.md) forms.
  const normalized = filePath.replace(/\\/g, '/');

  // Must be inside agents/pm-reference/
  if (!normalized.includes('agents/pm-reference/')) return false;

  // Extract the basename.
  const basename = normalized.split('/').pop() || '';

  // Must have .md extension (the pm-reference dir contains only .md files).
  if (!basename.endsWith('.md')) return false;

  // Exclude always-loaded files.
  if (ALWAYS_LOADED.has(basename)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Main stdin processing
// ---------------------------------------------------------------------------

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] emit-tier2-load: stdin exceeded limit; skipping\n');
      process.stdout.write(CONTINUE_RESPONSE);
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      handle(JSON.parse(input || '{}'));
    } catch (_e) {
      // Fail-open: malformed stdin — exit 0 with no event emission.
      process.stdout.write(CONTINUE_RESPONSE);
      process.exit(0);
    }
  });
}

function handle(event) {
  try {
    // Kill-switch: skip emission when metrics are disabled.
    if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }
    // Kill-switch: tier2 telemetry specifically disabled (v2.1.14 R-TGATE).
    if (process.env.ORCHESTRAY_DISABLE_TIER2_TELEMETRY === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const cwd       = resolveSafeCwd(event && event.cwd);

    // Kill-switch: check config.telemetry.tier2_tracking.enabled (v2.1.14 R-TGATE).
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.telemetry &&
        typeof parsed.telemetry === 'object' &&
        parsed.telemetry.tier2_tracking &&
        typeof parsed.telemetry.tier2_tracking === 'object' &&
        parsed.telemetry.tier2_tracking.enabled === false
      ) {
        process.stdout.write(CONTINUE_RESPONSE);
        return;
      }
    } catch (_configErr) {
      // Config absent or unreadable — proceed (fail-open)
    }

    const toolInput = (event && event.tool_input) || {};
    const filePath  = toolInput.file_path || toolInput.path || '';

    // Only act when the Read target is a tier-2 pm-reference file.
    if (!isTier2File(filePath)) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // v2.2.0 P1.3 D-8 enforcement: when event_schemas.full_load_disabled is
    // true (default), emit an observability event whenever event-schemas.md
    // is Read in full. This is the third enforcement layer per the design
    // (declarative dispatch + mechanical getChunk + observability here).
    // Fail-open: the Read itself is not blocked here, only telemetry.
    try {
      const normalizedForBasename = filePath.replace(/\\/g, '/');
      const basename = normalizedForBasename.split('/').pop() || '';
      if (basename === 'event-schemas.md') {
        let fullLoadDisabled = true; // default per locked scope
        try {
          const configPath = path.join(cwd, '.orchestray', 'config.json');
          const raw = fs.readFileSync(configPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (
            parsed &&
            parsed.event_schemas &&
            typeof parsed.event_schemas === 'object' &&
            parsed.event_schemas.full_load_disabled === false
          ) {
            fullLoadDisabled = false;
          }
        } catch (_cfgErr) { /* default true */ }

        if (fullLoadDisabled) {
          let oid = 'unknown';
          try {
            const orchFile = getCurrentOrchestrationFile(cwd);
            const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
            if (orchData && orchData.orchestration_id) oid = orchData.orchestration_id;
          } catch (_e) { /* keep unknown */ }

          try {
            writeEvent({
              version: 1,
              timestamp: new Date().toISOString(),
              type: 'event_schemas_full_load_blocked',
              orchestration_id: oid,
              file_path: filePath,
              agent_role: (event && event.agent_type) || null,
              source: 'hook',
            }, { cwd });
          } catch (_e) { /* fail-open */ }
        }
      }
    } catch (_e) { /* fail-open */ }

    // Read orchestration_id from current-orchestration.json.
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) {
        orchestrationId = orchData.orchestration_id;
      }
    } catch (_e) {
      // File missing or unreadable — keep 'unknown'
    }

    // Derive the relative file_path for the event (R-TGATE: relative, not basename).
    // Prefer relative path from the project root when the path is inside cwd;
    // fall back to the basename for absolute paths outside the project root.
    const normalized = filePath.replace(/\\/g, '/');
    const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    let relPath;
    if (normalized.startsWith(normalizedCwd + '/')) {
      relPath = normalized.slice(normalizedCwd.length + 1);
    } else {
      // Path is relative already, or outside cwd — use as-is, strip leading ./
      relPath = normalized.replace(/^\.\//, '');
    }

    // Measure file size at read time for the `bytes` field (v2.1.14 R-TGATE).
    let bytes = null;
    try {
      const absPath = normalized.startsWith('/') ? filePath : path.join(cwd, filePath);
      const stat = fs.statSync(absPath);
      bytes = stat.size;
    } catch (_e) {
      // File may have been deleted or path unresolvable — leave null.
    }

    // Extract turn_number from the hook payload when available (v2.1.14 R-TGATE).
    // Claude Code may provide this in the event envelope.
    const turnNumber = (event && typeof event.turn_number === 'number')
      ? event.turn_number
      : null;

    const auditEvent = {
      version:          1,
      timestamp:        new Date().toISOString(),
      type:             'tier2_load',
      orchestration_id: orchestrationId,
      file_path:        relPath,
      bytes,
      turn_number:      turnNumber,
      agent_role:       (event && event.agent_type) || null,
      source:           'hook',
    };

    // task_id is optional; only include when the hook payload carries one.
    const taskId = event && (event.task_id || null);
    if (taskId) auditEvent.task_id = taskId;

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    try {
      fs.mkdirSync(auditDir, { recursive: true });
    } catch (_e) {
      // Directory creation failure is non-fatal.
    }

    writeEvent(auditEvent, { cwd });
  } catch (_e) {
    // Fail-open: any unexpected error — exit 0 with no stderr spam.
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// Export helpers for testing.
module.exports = { isTier2File, ALWAYS_LOADED };
