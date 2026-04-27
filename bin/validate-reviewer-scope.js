#!/usr/bin/env node
'use strict';

/**
 * validate-reviewer-scope.js — PreToolUse hook (matcher: "Agent").
 *
 * v2.1.9 Bundle B1 / Intervention I-03 (reviewer file-list scope).
 * v2.2.3 Bucket E3 (B7): warn-only → exit-2 hard-block. 14-day window
 * elapsed; A4 false-positive heuristic in place; promote per design spec
 * §5 I-03 trigger ("flip to exit-2 if false-positive rate stays low").
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. Scans the
 * delegation prompt body for an explicit file list (markers: `files:`,
 * `scope:` section, or a bulleted list of repo-relative paths). If absent,
 * emits a `reviewer_scope_warn` audit event AND exits 2 (HARD-BLOCK).
 *
 * Contract:
 *   - exit 2 (block) when reviewer prompt lacks explicit scope marker
 *   - exit 0 on pass-through (non-reviewer Agent calls, scoped reviewer prompts)
 *   - emit `reviewer_scope_warn` audit event on the block path
 *   - fail-open (exit 0) on any internal error (parse failure, hook input bug)
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

// Heuristics for detecting an explicit file list in the prompt body.
// Any one of these signals is sufficient to treat the scope as bounded.
const FILE_MARKERS = [
  /(^|\n)\s*files\s*:/i,             // files: foo.ts
  /(^|\n)\s*scope\s*:/i,             // scope:
  /(^|\n)\s*in[-_ ]?scope\s*:/i,     // in-scope:
  /(^|\n)\s*review\s*:/i,            // review: (next line lists files)
  /(^|\n)\s*file[-_ ]?list\s*:/i,    // file-list:
  // v2.2.2 Fix A4: project's heading style for file-scoped reviewer prompts —
  // matches `## Verification`, `### Files to verify`, `## Files to read`, etc.
  /(^|\n)\s*#{1,3}\s*(verification|files?\s+to\s+(?:verify|read|review|check))\b/i,
];

// Count bulleted list items that look like repo paths. Three or more is
// accepted as evidence of an explicit file list (the common case is a bullet
// list of 3+ files under the review heading).
//
// v2.2.2 Fix A4: optional backticks on each side of the path token. The
// project's house style wraps paths in backticks (e.g. `` - `src/foo.ts` ``).
// Without this tolerance the regex matched 0 bullets in well-scoped operator
// prompts (false-positive rate was empirically 100% in v2.2.1 telemetry).
const BULLET_PATH_RE = /(?:^|\n)[\t ]*[-*][\t ]+`?[\w./-]+\.[a-z0-9]{1,6}`?(?:\b|$)/gi;
const BULLET_PATH_THRESHOLD = 3;

/**
 * Determine whether the reviewer spawn has an explicit file list.
 *
 * @param {string} promptBody
 * @returns {{ scoped: boolean, evidence: string }}
 */
function evaluateScope(promptBody) {
  if (typeof promptBody !== 'string' || promptBody.length === 0) {
    return { scoped: false, evidence: 'empty prompt body' };
  }

  // Limit scan to the first 16 KB — the scope declaration is always early.
  const head = promptBody.slice(0, 16 * 1024);

  for (const rx of FILE_MARKERS) {
    if (rx.test(head)) {
      return { scoped: true, evidence: 'marker: ' + String(rx).replace(/\/\^|\$\/|\/gi|\/i$/g, '').slice(0, 40) };
    }
  }

  const bulletMatches = head.match(BULLET_PATH_RE);
  if (bulletMatches && bulletMatches.length >= BULLET_PATH_THRESHOLD) {
    return { scoped: true, evidence: 'bullet-list paths (' + bulletMatches.length + ')' };
  }

  return { scoped: false, evidence: 'no files:/scope: marker, <' + BULLET_PATH_THRESHOLD + ' bullet paths' };
}

function shouldValidate(event) {
  if (!event) return false;
  const toolName = event.tool_name || event.hook_event_matcher || '';
  if (toolName !== 'Agent') return false;
  const toolInput = event.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return false;
  return toolInput.subagent_type === 'reviewer';
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (err) {
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-reviewer-scope', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) { /* last resort */ }
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
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

    if (!shouldValidate(event)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    const promptBody = (event.tool_input && typeof event.tool_input.prompt === 'string')
      ? event.tool_input.prompt
      : '';
    const evaluation = evaluateScope(promptBody);

    if (!evaluation.scoped) {
      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'reviewer_scope_warn',
        hook: 'validate-reviewer-scope',
        guidance:
          'Reviewer spawned without an explicit file list. Include a `files:` ' +
          'section or a bulleted list of paths in the delegation prompt to bound the review scope. ' +
          'See agents/pm.md §3.X.',
        evidence: evaluation.evidence,
        session_id: event.session_id || null,
        action: 'block',
      });
      // v2.2.3 E3/B7: hard-block on missing explicit file list.
      process.stderr.write(
        '[orchestray] validate-reviewer-scope: BLOCK — reviewer delegation lacks an explicit file list ' +
        '(evidence: ' + evaluation.evidence + '). Add a `files:` section, `scope:` section, or a ' +
        '`## Files to read/verify/review` heading with ≥3 bulleted repo-relative paths. ' +
        'See agents/pm.md §3.X.\n'
      );
      process.stdout.write(JSON.stringify({
        continue: false,
        stopReason:
          'Reviewer delegation lacks an explicit file list. ' +
          'Add a `files:` / `scope:` marker or a bulleted list of paths and re-spawn.',
      }));
      process.exit(2);
    }

    // Pass: scoped reviewer delegation.
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  evaluateScope,
  shouldValidate,
  FILE_MARKERS,
  BULLET_PATH_THRESHOLD,
};

if (require.main === module) {
  main();
}
