#!/usr/bin/env node
'use strict';

/**
 * validate-researcher-citations.js — SubagentStop hook (v2.2.15 P1-09).
 *
 * When a researcher agent's Structured Result has a non-`no_clear_fit` verdict,
 * require ≥3 sources cited. Exit 2 if fewer than 3 sources.
 *
 * Kill switch: ORCHESTRAY_RESEARCHER_CITATIONS_GATE_DISABLED=1
 *
 * Events emitted:
 *   researcher_citations_gate_blocked — exit 2 on violation
 *
 * Contract:
 *   - exit 0 when verdict is absent or "no_clear_fit".
 *   - exit 0 when ≥3 sources are cited.
 *   - exit 2 when verdict present (non-no_clear_fit) and <3 sources cited.
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const SCHEMA_VERSION = 1;
const MIN_SOURCES = 3;

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
 * Count sources in a Structured Result.
 * Looks for `sources` array field or `citations` array field.
 * Also counts URLs in `summary` as a fallback.
 */
function countSources(sr) {
  if (!sr || typeof sr !== 'object') return 0;

  // Primary: sources array
  if (Array.isArray(sr.sources)) return sr.sources.length;

  // Secondary: citations array
  if (Array.isArray(sr.citations)) return sr.citations.length;

  // Tertiary: shortlist array (researcher role uses this)
  if (Array.isArray(sr.shortlist)) return sr.shortlist.length;

  // Last resort: count URLs in summary text
  const text = typeof sr.summary === 'string' ? sr.summary : '';
  const urlMatches = text.match(/https?:\/\/\S+/g);
  return urlMatches ? urlMatches.length : 0;
}

/**
 * Check if verdict is no_clear_fit (pass-through).
 */
function isNoClearFit(sr) {
  if (!sr || typeof sr !== 'object') return true; // no verdict = pass through
  const verdict = sr.verdict || sr.recommendation || sr.status || '';
  if (typeof verdict !== 'string') return true;
  return verdict.toLowerCase().replace(/[\s_-]/g, '') === 'noclearfit';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Kill switch: full bypass
  if (process.env.ORCHESTRAY_RESEARCHER_CITATIONS_GATE_DISABLED === '1') {
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

    // Only activate on SubagentStop for researcher role
    const hookEvent = event.hook_event_name || '';
    if (hookEvent !== 'SubagentStop') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    const role = (
      event.subagent_type || event.agent_type || event.agent_role ||
      (event.tool_input && event.tool_input.subagent_type) || ''
    ).toLowerCase().trim();
    if (role !== 'researcher') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    const sr = extractStructuredResult(event);

    // No structured result or no_clear_fit verdict — pass
    if (!sr || isNoClearFit(sr)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const sourceCount = countSources(sr);
    if (sourceCount >= MIN_SOURCES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Insufficient sources — block
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
      type:             'researcher_citations_gate_blocked',
      agent_role:       role,
      source_count:     sourceCount,
      min_sources:      MIN_SOURCES,
      orchestration_id: orchId,
    });
    process.stderr.write(
      '[orchestray] validate-researcher-citations: BLOCKED — researcher returned a verdict ' +
      'but only ' + sourceCount + ' source(s) cited (minimum: ' + MIN_SOURCES + '). ' +
      'Add sources to the `sources` array in the Structured Result. ' +
      'Kill switch: ORCHESTRAY_RESEARCHER_CITATIONS_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'researcher_citations_gate_blocked:insufficient_sources:' + sourceCount,
    }));
    process.exit(2);
  });
}

module.exports = {
  extractStructuredResult,
  countSources,
  isNoClearFit,
  MIN_SOURCES,
};

if (require.main === module) {
  main();
}
