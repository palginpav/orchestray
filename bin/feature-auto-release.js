#!/usr/bin/env node
'use strict';

/**
 * feature-auto-release.js — PostToolUse hook (R-GATE, v2.1.14).
 *
 * Safety net: scans structured result `issues[]` arrays for text matching a
 * quarantined feature's namespace. On match, emits a `feature_wake_auto` event
 * and adds the feature to the session-wake set (same as /orchestray:feature wake).
 *
 * Since Claude Code PostToolUse fires on tool completions, this hook receives the
 * tool output JSON on stdin. We look for `issues` arrays in the result object.
 * If the PostToolUse payload doesn't carry a structured result, we also scan the
 * most recent entries in .orchestray/state/stop-hook.jsonl (the Stop hook capture).
 *
 * Feature namespace keywords (used for fuzzy matching against issue text):
 *   - pattern_extraction: ["pattern extraction", "pattern_extraction"]
 *   - archetype_cache:    ["archetype cache", "archetype_cache"]
 *
 * Only features that are currently in quarantine_candidates (or wired-emitter eligible)
 * are candidates for auto-release. Non-quarantined features are not affected.
 *
 * Kill switches:
 *   - process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1'
 *   - config.feature_demand_gate.enabled === false
 *
 * Fail-open contract: any error → exit 0, never blocks.
 *
 * Input:  JSON on stdin (Claude Code PostToolUse hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const {
  getQuarantineCandidates,
  addSessionWake,
}                           = require('./_lib/effective-gate-state');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

// Keyword table: gate slug → list of lowercase substrings to match against issue text.
const GATE_KEYWORDS = {
  pattern_extraction: ['pattern extraction', 'pattern_extraction', 'pattern extract'],
  archetype_cache:    ['archetype cache', 'archetype_cache'],
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE);
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    handle(JSON.parse(input || '{}'));
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE);
    process.exit(0);
  }
});

/**
 * Extract all issue strings from a structured result object.
 * Handles both array-of-strings and array-of-objects with a `text` field.
 *
 * @param {unknown} result
 * @returns {string[]}
 */
function extractIssueTexts(result) {
  try {
    if (!result || typeof result !== 'object') return [];
    const issues = result.issues;
    if (!Array.isArray(issues)) return [];
    const texts = [];
    for (const entry of issues) {
      if (typeof entry === 'string') {
        texts.push(entry);
      } else if (entry && typeof entry === 'object') {
        if (typeof entry.text === 'string') texts.push(entry.text);
        if (typeof entry.message === 'string') texts.push(entry.message);
        if (typeof entry.description === 'string') texts.push(entry.description);
      }
    }
    return texts;
  } catch (_e) {
    return [];
  }
}

/**
 * Scan issue texts for any quarantined feature's keywords.
 * Returns array of { slug, matchText } for matched gates.
 *
 * @param {string[]} issueTexts
 * @param {string[]} quarantinedSlugs
 * @returns {Array<{slug: string, matchText: string}>}
 */
function findMatches(issueTexts, quarantinedSlugs) {
  const matches = [];
  for (const text of issueTexts) {
    const lower = text.toLowerCase();
    for (const slug of quarantinedSlugs) {
      const keywords = GATE_KEYWORDS[slug] || [slug.replace(/_/g, ' '), slug];
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          // Check this slug isn't already in matches
          if (!matches.find(m => m.slug === slug)) {
            matches.push({ slug, matchText: text });
          }
          break;
        }
      }
    }
  }
  return matches;
}

function handle(event) {
  try {
    // Kill switch: env var
    if (process.env.ORCHESTRAY_DISABLE_DEMAND_GATE === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const cwd = resolveSafeCwd(event && event.cwd);

    // Load config for kill switch check and quarantine candidates
    let config = {};
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    } catch (_e) {}
    if (typeof config !== 'object' || Array.isArray(config)) config = {};

    // Kill switch: config.feature_demand_gate.enabled === false
    if (
      config.feature_demand_gate &&
      typeof config.feature_demand_gate === 'object' &&
      config.feature_demand_gate.enabled === false
    ) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const quarantinedSlugs = getQuarantineCandidates(config);
    if (quarantinedSlugs.length === 0) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Extract issue texts from the PostToolUse event payload.
    // The hook payload may have tool_use.output or tool_result.
    let issueTexts = [];

    try {
      // PostToolUse: event.tool_result or event.result may contain structured output
      const toolResult = event && (event.tool_result || event.output || event.result);
      if (toolResult) {
        let parsed = toolResult;
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); } catch (_e) {}
        }
        issueTexts = issueTexts.concat(extractIssueTexts(parsed));
      }
    } catch (_e) {}

    // Fallback: scan stop-hook.jsonl for recent structured results
    if (issueTexts.length === 0) {
      try {
        const stopHookPath = path.join(cwd, '.orchestray', 'state', 'stop-hook.jsonl');
        const raw = fs.readFileSync(stopHookPath, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim()).slice(-20); // Last 20 lines
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            issueTexts = issueTexts.concat(extractIssueTexts(entry));
            issueTexts = issueTexts.concat(extractIssueTexts(entry.result));
            issueTexts = issueTexts.concat(extractIssueTexts(entry.structured_result));
          } catch (_e) {}
        }
      } catch (_e) {}
    }

    if (issueTexts.length === 0) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const matches = findMatches(issueTexts, quarantinedSlugs);
    if (matches.length === 0) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Get orchestration_id
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) {}

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    try { fs.mkdirSync(auditDir, { recursive: true }); } catch (_e) {}

    for (const { slug, matchText } of matches) {
      // Add to session wake
      addSessionWake(cwd, slug);

      // Emit feature_wake_auto event
      const auditEvent = {
        version:          1,
        type:             'feature_wake_auto',
        timestamp:        new Date().toISOString(),
        orchestration_id: orchestrationId,
        gate_slug:        slug,
        match_text:       matchText,
      };
      writeEvent(auditEvent, { cwd });
    }
  } catch (_e) {
    // Fail-open
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// Export for testing.
module.exports = { handle, extractIssueTexts, findMatches, GATE_KEYWORDS };
