#!/usr/bin/env node
'use strict';

/**
 * validate-platform-oracle-grounding.js — SubagentStop hook (v2.2.15 P1-10).
 *
 * Platform-oracle agents must ground every claim with:
 *   1. `stability_tier` ∈ { stable, experimental, community }
 *   2. non-empty `source_url`
 *
 * Checks the Structured Result for these fields. Exit 2 if any claim is missing
 * stability_tier or source_url.
 *
 * Kill switch: ORCHESTRAY_PLATFORM_ORACLE_GROUNDING_GATE_DISABLED=1
 *
 * Events emitted:
 *   platform_oracle_grounding_gate_blocked — exit 2 on violation
 *
 * Contract:
 *   - exit 0 when fields are present and valid.
 *   - exit 2 when stability_tier or source_url is missing/invalid.
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const SCHEMA_VERSION = 1;
const VALID_STABILITY_TIERS = new Set(['stable', 'experimental', 'community']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitGateEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

/**
 * Extract Structured Result from the event payload.
 */
function extractStructuredResult(event) {
  if (!event) return null;
  if (event.structured_result && typeof event.structured_result === 'object') {
    return event.structured_result;
  }
  const direct = event.agent_output_json || event.result_json;
  if (direct && typeof direct === 'object') return direct;

  const raw = [event.result, event.output, event.agent_output]
    .find(v => typeof v === 'string' && v.length > 0);
  if (!raw) return null;

  const tail = raw.slice(-65536);
  const re = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = tail.match(re);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_) { /* fall through */ }
  }
  return null;
}

/**
 * Validate grounding fields in a platform-oracle Structured Result.
 *
 * The Structured Result may contain:
 *   - Top-level `stability_tier` and `source_url` fields (single-claim mode)
 *   - A `claims` array, each with `stability_tier` and `source_url`
 *   - A `findings` array, each with `stability_tier` and `source_url`
 *
 * Returns { valid: boolean, violations: string[] }
 */
function validateGrounding(sr) {
  if (!sr || typeof sr !== 'object') {
    return { valid: false, violations: ['no structured result'] };
  }

  const violations = [];

  // Check top-level fields (single-claim or summary mode)
  const hasClaims = Array.isArray(sr.claims) && sr.claims.length > 0;
  const hasFindings = Array.isArray(sr.findings) && sr.findings.length > 0;

  if (!hasClaims && !hasFindings) {
    // Single-claim mode: expect top-level fields
    const tier = sr.stability_tier;
    const url  = sr.source_url;

    if (!tier || !VALID_STABILITY_TIERS.has(String(tier).toLowerCase())) {
      violations.push(
        'stability_tier missing or invalid (got: ' + JSON.stringify(tier) +
        ', expected one of: ' + [...VALID_STABILITY_TIERS].join(', ') + ')'
      );
    }
    if (!url || typeof url !== 'string' || !url.trim()) {
      violations.push('source_url missing or empty');
    }
  } else {
    // Multi-claim mode: check each entry in claims or findings array
    const entries = hasClaims ? sr.claims : sr.findings;
    entries.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        violations.push('entry[' + i + '] is not an object');
        return;
      }
      const tier = entry.stability_tier;
      const url  = entry.source_url;

      if (!tier || !VALID_STABILITY_TIERS.has(String(tier).toLowerCase())) {
        violations.push(
          'entry[' + i + '].stability_tier missing or invalid (got: ' +
          JSON.stringify(tier) + ')'
        );
      }
      if (!url || typeof url !== 'string' || !url.trim()) {
        violations.push('entry[' + i + '].source_url missing or empty');
      }
    });
  }

  return { valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Kill switch: full bypass
  if (process.env.ORCHESTRAY_PLATFORM_ORACLE_GROUNDING_GATE_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only activate on SubagentStop for platform-oracle role
    const hookEvent = event.hook_event_name || '';
    if (hookEvent !== 'SubagentStop') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    const role = (
      event.subagent_type || event.agent_type || event.agent_role ||
      (event.tool_input && event.tool_input.subagent_type) || ''
    ).toLowerCase().trim().replace(/[\s\x00-\x1F ]/g, '');
    if (role !== 'platform-oracle') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    const sr = extractStructuredResult(event);
    if (!sr) {
      // No structured result — T15 gate will handle the missing-result case
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const { valid, violations } = validateGrounding(sr);
    if (valid) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Violations found — block
    const orchId = (() => {
      try {
        const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
        const f = getCurrentOrchestrationFile(cwd);
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        return parsed.orchestration_id || parsed.id || null;
      } catch (_) { return null; }
    })();

    emitGateEvent(cwd, {
      version:          SCHEMA_VERSION,
      schema_version:   SCHEMA_VERSION,
      type:             'platform_oracle_grounding_gate_blocked',
      agent_role:       role,
      violations,
      orchestration_id: orchId,
    });
    process.stderr.write(
      '[orchestray] validate-platform-oracle-grounding: BLOCKED — platform-oracle result ' +
      'missing required grounding fields:\n' +
      violations.map(v => '  - ' + v).join('\n') + '\n' +
      'Each claim must include stability_tier (stable|experimental|community) and ' +
      'a non-empty source_url. See agents/platform-oracle.md for the grounding contract.\n' +
      'Kill switch: ORCHESTRAY_PLATFORM_ORACLE_GROUNDING_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'platform_oracle_grounding_gate_blocked:' + violations.length + '_violation(s)',
    }));
    process.exit(2);
  });
}

module.exports = {
  extractStructuredResult,
  validateGrounding,
  VALID_STABILITY_TIERS,
};

if (require.main === module) {
  main();
}
