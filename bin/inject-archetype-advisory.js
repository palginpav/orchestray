#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook — two responsibilities:
 *
 * 1. R-KS kill-switch injection (v2.1.12):
 *    Checks three env vars on every PM turn. When set to '1', reads the
 *    corresponding backing file and prepends its content as additionalContext,
 *    guaranteeing the file is in context regardless of Tier-2 dispatch rules.
 *
 *    ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1
 *      → injects agents/pm-reference/tier1-orchestration-rare.md
 *    ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1
 *      → injects agents/pm-reference/delegation-templates-detailed.md
 *    ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1
 *      → injects agents/pm-reference/event-schemas.md
 *
 *    Unknown values (=0, =false, empty, unset) are treated as unset (no-op).
 *    Multiple vars may be set simultaneously — their content is concatenated.
 *    Kill-switch injection is fail-open: any file read error is silently skipped.
 *
 * 2. Archetype advisory injection (v2.1.11):
 *    Injects <orchestray-archetype-advisory> fence into PM context before
 *    decomposition when a high-confidence archetype match is found.
 *
 *    Decision logic (all conditions must be true):
 *      1. Active orchestration exists (current-orchestration.json present).
 *      2. Orchestration is pre-decomposition: routing.jsonl has NO entries for this
 *         orchestration_id (routing is written at the END of decomposition).
 *      3. context_compression_v218.archetype_cache.enabled is not false.
 *      4. A match is found with confidence >= 0.85 AND prior_applications_count >= 3.
 *      5. The archetype_id is not in the blacklist.
 *
 * On any injection: emits hookSpecificOutput.additionalContext with the combined text.
 * On no injection or any error: exits 0 with no output (fail-open).
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: exit 0 always; hookSpecificOutput JSON on stdout when any injection fires
 */

const fs   = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES }              = require('./_lib/constants');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { getRoutingFilePath, readRoutingEntries } = require('./_lib/routing-lookup');
const { recordDegradation }           = require('./_lib/degraded-journal');
const {
  computeSignature,
  describeSignature,
  findMatch,
  loadConfig,
  recordApplication,
  recordBlacklisted,
} = require('./_lib/archetype-cache');

const { emitTier2Invoked } = require('./_lib/tier2-invoked-emitter');
const { writeEvent }       = require('./_lib/audit-event-writer');

const FENCE_OPEN  = '<orchestray-archetype-advisory>';
const FENCE_CLOSE = '</orchestray-archetype-advisory>';

// ─── Stdin reader ─────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    handleUserPromptSubmit(event);
  } catch (_e) {
    // Fail-open on malformed stdin
    process.exit(0);
  }
});

// ─── Output helper ────────────────────────────────────────────────────────────

/**
 * Write `data` to stdout and exit 0. Uses the write callback to ensure the
 * entire buffer is flushed before the process exits — required for large
 * payloads (e.g., event-schemas.md is 144KB) where process.exit(0) called
 * synchronously after write() can truncate the output before OS flushes the pipe.
 *
 * @param {string} data - The string to write (caller must include trailing \n if desired)
 */
function writeAndExit(data) {
  process.stdout.write(data, () => process.exit(0));
}

// ─── R-KS kill-switch helpers (v2.1.12) ──────────────────────────────────────

/**
 * Kill-switch env var → backing file mapping.
 * Each entry: [envVar, relativePathFromProjectRoot]
 */
const KILL_SWITCH_MAP = [
  ['ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD',    'agents/pm-reference/tier1-orchestration-rare.md'],
  ['ORCHESTRAY_DELEGATION_TEMPLATES_MERGE', 'agents/pm-reference/delegation-templates-detailed.md'],
  ['ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD', 'agents/pm-reference/event-schemas.md'],
];

/**
 * Check all kill-switch env vars and collect content from their backing files.
 * Only fires when the var is set to '1'. Unknown values (=0, =false, empty, unset)
 * are treated as unset (AC-05).
 *
 * @param {string} cwd - Resolved project root
 * @returns {string} Concatenated injected content (empty string if none)
 */
function collectKillSwitchContent(cwd) {
  const parts = [];
  for (const [envVar, relPath] of KILL_SWITCH_MAP) {
    if (process.env[envVar] !== '1') continue; // unset or unknown value → skip
    try {
      const absPath = path.join(cwd, relPath);
      const content = fs.readFileSync(absPath, 'utf8');
      parts.push(
        '[orchestray] kill-switch ' + envVar + '=1 — injecting ' + relPath + '\n\n' +
        content
      );
    } catch (_e) {
      // Fail-open: file missing or unreadable → skip silently
    }
  }
  return parts.join('\n\n---\n\n');
}

// ─── Main handler ─────────────────────────────────────────────────────────────

function handleUserPromptSubmit(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // ── R-KS (v2.1.12): collect kill-switch file content unconditionally ────
    // This runs before the active-orchestration check so kill-switch injection
    // fires on every PM turn when env vars are set, not just pre-decomposition.
    const killSwitchContent = collectKillSwitchContent(cwd);

    /**
     * Emit kill-switch-only context and exit. Called from all early-exit paths
     * where the archetype advisory cannot fire but kill-switch content may apply.
     * Uses writeAndExit() to guarantee stdout is flushed before process exit —
     * critical for large payloads (event-schemas.md is 144KB).
     */
    function exitWithKillSwitch() {
      if (killSwitchContent) {
        writeAndExit(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: killSwitchContent,
          },
        }) + '\n');
      } else {
        process.exit(0);
      }
    }

    // Condition 1: active orchestration
    const orchFile = getCurrentOrchestrationFile(cwd);
    if (!fs.existsSync(orchFile)) {
      exitWithKillSwitch();
      return;
    }

    let orchData;
    try {
      orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    } catch (_e) {
      exitWithKillSwitch();
      return;
    }

    const orchestrationId = orchData && orchData.orchestration_id;
    if (!orchestrationId || typeof orchestrationId !== 'string') {
      exitWithKillSwitch();
      return;
    }

    // Condition 3: archetype cache kill switch check (archetype advisory only)
    const cfg = loadConfig(cwd);
    if (!cfg.enabled) {
      // Archetype advisory disabled — but kill-switch content still applies
      exitWithKillSwitch();
      return;
    }

    // Condition 2: pre-decomposition check — routing.jsonl must NOT have entries
    // for this orchestration_id yet (decomposition writes routing at the end)
    const routingFile = getRoutingFilePath(cwd);
    if (fs.existsSync(routingFile)) {
      let entries = [];
      try {
        entries = readRoutingEntries(cwd);
      } catch (_e) { /* fail-open: treat as no entries */ }
      const orchEntries = entries.filter(e => e && e.orchestration_id === orchestrationId);
      if (orchEntries.length > 0) {
        // Already decomposed — advisory would be too late; kill-switch content still applies
        exitWithKillSwitch();
        return;
      }
    }

    // Extract task description from orchestration state or prompt
    const taskDescription = extractTaskDescription(orchData, event);

    // Build task signature components
    const taskSig = {
      agentSet: orchData.expected_agent_set || [],
      fileCount: orchData.file_count_hint || 0,
      description: taskDescription,
      complexityScore: orchData.complexity_score || 0,
    };

    const sigDetails = describeSignature(taskSig);
    const signature  = sigDetails.signature;
    if (!signature) {
      // computeSignature() returned empty — emit degraded entry for observability then fail-open.
      try {
        recordDegradation({
          kind: 'archetype_cache_signature_failed',
          severity: 'warn',
          projectRoot: cwd,
          detail: {
            orchestration_id: orchestrationId,
            dedup_key: 'acsf-' + orchestrationId,
          },
        });
      } catch (_de) { /* fail-open */ }
      exitWithKillSwitch();
      return;
    }

    // Condition 4 + 5: findMatch enforces guardrails 1, 2, 4, 5
    // We need to handle blacklist separately to emit degraded event
    const match = findMatch(signature, sigDetails, cfg, cwd);
    if (!match) {
      // Check if there's a raw match that got blacklisted (for telemetry)
      checkAndRecordBlacklisted(cwd, sigDetails, cfg, orchestrationId);
      // R-ARCHETYPE-EVENT (v2.1.17): emit archetype_cache_miss on the no-match path
      // so the analytics rollup can compute hit-rate = served / (served + miss).
      // Mirrors the recordAdvisoryServed style; fail-open per audit-event contract.
      recordCacheMiss(cwd, signature, orchestrationId);
      // Info #13 (v2.2.19 audit-fix R1): cold-cache bootstrap note.
      // recordApplication() requires an archetypeId from a matched record, so it
      // cannot be called here (no match). Bootstrapping the cache from the no-match
      // path requires a separate seeding mechanism (e.g. a setup command that
      // pre-populates archetype records from known task signatures). Deferred to a
      // follow-up: the v2.2.19 fix only wires the match-path (S2 below). Analytics
      // can detect cold-cache status by comparing miss_count vs min_prior_applications.
      exitWithKillSwitch();
      return;
    }

    // S2 (v2.2.19): record this advisory application so prior_applications_count
    // increments on each serve and the cache can eventually meet the
    // min_prior_applications guardrail (default 3). Without this call the cache
    // write-path was never exercised: recordApplication() existed but had zero
    // callers, producing a 100% miss rate indefinitely.
    // We record 'success' here because serving the advisory is the application
    // event; the PM's pm_decision (accepted/adapted/overridden) is recorded
    // separately via recordAdvisoryServed after decomposition.
    // Fail-open: any error in recordApplication must not block the advisory.
    try {
      recordApplication(match.archetypeId, orchestrationId, 'success', sigDetails, cwd);
    } catch (_re) { /* fail-open */ }

    // Load the archetype record to get its task graph content
    const archetypeContent = loadArchetypeContent(cwd, match.archetypeId);

    // Emit additionalContext combining kill-switch content + advisory fence.
    // Uses writeAndExit() to guarantee stdout flush before process exit.
    const advisoryText = buildAdvisoryFence(match, archetypeContent, sigDetails);
    const combinedContext = killSwitchContent
      ? killSwitchContent + '\n\n---\n\n' + advisoryText
      : advisoryText;

    // R-TGATE (v2.1.14): emit tier2_invoked for archetype_cache protocol.
    // Fail-open: any emitter error must not prevent the advisory from being written.
    try {
      emitTier2Invoked({
        cwd,
        protocol: 'archetype_cache',
        trigger_signal: 'archetype match confidence >= 0.85 with prior_applications_count >= 3',
      });
    } catch (_te) { /* fail-open */ }

    writeAndExit(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: combinedContext,
      },
    }) + '\n');
  } catch (_e) {
    // Fail-open: any error → no output, exit 0
    process.exit(0);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract task description from orchestration state or prompt field.
 *
 * @param {object} orchData  - Parsed current-orchestration.json
 * @param {object} event     - UserPromptSubmit payload
 * @returns {string}
 */
function extractTaskDescription(orchData, event) {
  // Prefer the task stored in orchestration state
  if (orchData && orchData.task && typeof orchData.task === 'string') {
    return orchData.task;
  }
  // Fall back to prompt from event
  if (event && event.prompt && typeof event.prompt === 'string') {
    return event.prompt.slice(0, 2000);
  }
  return '';
}

/**
 * Count archetypes searched by reading archetype-cache.jsonl line count.
 * Returns 0 when the cache is missing or unreadable (fail-open).
 *
 * @param {string} cwd
 * @returns {number}
 */
function countArchetypesSearched(cwd) {
  try {
    const cachePath = path.join(cwd, '.orchestray', 'state', 'archetype-cache.jsonl');
    if (!fs.existsSync(cachePath)) return 0;
    const raw = fs.readFileSync(cachePath, 'utf8');
    if (!raw) return 0;
    return raw.split('\n').filter(line => line.trim().length > 0).length;
  } catch (_e) {
    return 0;
  }
}

/**
 * Emit an archetype_cache_miss event on the no-match path.
 * R-ARCHETYPE-EVENT (v2.1.17): pairs with archetype_cache_advisory_served (the hit
 * signal) so the /orchestray:analytics rollup can compute hit-rate = served /
 * (served + miss). Fail-open: any write error must not block the orchestration.
 *
 * @param {string} cwd
 * @param {string} signature        - 12-hex task_shape_hash from computeSignature()
 * @param {string} orchestrationId
 */
function recordCacheMiss(cwd, signature, orchestrationId) {
  try {
    const event = {
      type: 'archetype_cache_miss',
      version: 1,
      orchestration_id: orchestrationId,
      task_shape_hash: signature,
      archetype_count_searched: countArchetypesSearched(cwd),
    };
    writeEvent(event, { cwd });
  } catch (_e) { /* fail-open */ }
}

/**
 * Check if there is a record in the cache that would match but is blacklisted.
 * If so, emit the archetype_cache_blacklisted degraded event.
 *
 * @param {string} cwd
 * @param {object} sigDetails
 * @param {object} cfg
 * @param {string} orchId
 */
function checkAndRecordBlacklisted(cwd, sigDetails, cfg, orchId) {
  try {
    if (!cfg.blacklist || cfg.blacklist.length === 0) return;

    // Re-run findMatch without the blacklist to see if there's a hit
    const cfgNoBlacklist = Object.assign({}, cfg, { blacklist: [] });
    const potentialMatch = findMatch(sigDetails.signature, sigDetails, cfgNoBlacklist, cwd);
    if (potentialMatch && cfg.blacklist.includes(potentialMatch.archetypeId)) {
      recordBlacklisted(potentialMatch.archetypeId, cwd);
    }
  } catch (_e) { /* fail-open */ }
}

/**
 * Load the stored archetype task graph markdown from the cache state directory.
 *
 * @param {string} cwd
 * @param {string} archetypeId
 * @returns {string} Content of the archetype record, or empty string
 */
function loadArchetypeContent(cwd, archetypeId) {
  try {
    const cachePath = path.join(cwd, '.orchestray', 'state', 'archetype-cache', archetypeId + '.md');
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, 'utf8').slice(0, 4000);
    }
    return '';
  } catch (_e) {
    return '';
  }
}

/**
 * Build the advisory fence text that will be injected as additionalContext.
 *
 * @param {{archetypeId: string, confidence: number, prior_applications_count: number}} match
 * @param {string} archetypeContent
 * @param {object} sigDetails
 * @returns {string}
 */
function buildAdvisoryFence(match, archetypeContent, sigDetails) {
  const confPct = (match.confidence * 100).toFixed(1);
  const header = [
    `[orchestray] ArchetypeCache advisory — confidence ${confPct}%, ` +
    `applied ${match.prior_applications_count}x previously.`,
    `Archetype ID: ${match.archetypeId}`,
    `Signature components: agents=[${sigDetails.agentSet}], ` +
    `files=${sigDetails.fileBucket}, keywords=[${sigDetails.keywords}], ` +
    `score=${sigDetails.scoreBucket}`,
    '',
    'The decomposition below comes from a prior orchestration with a matching task shape.',
    'This is an advisory hint — you MUST still run Section 13 decomposition.',
    'Decide: accepted (adopt verbatim) | adapted (modify 1-3 details) | overridden (start fresh).',
    'Emit archetype_cache_advisory_served event with pm_decision and pm_reasoning_brief.',
    '',
  ].join('\n');

  const body = archetypeContent
    ? '### Prior decomposition:\n\n' + archetypeContent
    : '### Prior decomposition: (no task graph stored for this archetype yet)';

  return FENCE_OPEN + '\n' + header + body + '\n' + FENCE_CLOSE;
}
