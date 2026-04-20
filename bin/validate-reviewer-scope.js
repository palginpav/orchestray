#!/usr/bin/env node
'use strict';

/**
 * validate-reviewer-scope.js — PreToolUse hook (matcher: "Agent").
 *
 * v2.1.9 Bundle B1 / Intervention I-03 (reviewer file-list scope).
 *
 * Activates only when `tool_input.subagent_type === "reviewer"`. Scans the
 * delegation prompt body for an explicit file list (markers: `files:`,
 * `scope:` section, or a bulleted list of repo-relative paths). If absent,
 * emits a `reviewer_scope_warn` audit event and exits 0 (WARN — NOT block).
 *
 * Per design spec §5 I-03: "warn-only in v2.1.9 (shadow mode for one release);
 * flip to exit-2 in v2.2 if false-positive rate stays low."
 *
 * Contract:
 *   - exit 0 always (never block)
 *   - emit WARN audit event when scope is broad
 *   - fail-open on any internal error
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
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
];

// Count bulleted list items that look like repo paths. Three or more is
// accepted as evidence of an explicit file list (the common case is a bullet
// list of 3+ files under the review heading).
const BULLET_PATH_RE = /(?:^|\n)[\t ]*[-*][\t ]+[\w./-]+\.[a-z0-9]{1,6}\b/gi;
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
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), record);
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
      });
      process.stderr.write(
        '[orchestray] validate-reviewer-scope: WARN — reviewer delegation lacks an explicit file list ' +
        '(evidence: ' + evaluation.evidence + '). Not blocking; see agents/pm.md §3.X.\n'
      );
    }

    // Never block — this is a soft gate in v2.1.9.
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
