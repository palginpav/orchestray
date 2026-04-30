#!/usr/bin/env node
'use strict';

/**
 * lint-doesnotthrow-orphan.js — C-01 CLI wrapper (v2.2.17).
 *
 * PreToolUse:Bash hook. Invoked before every `Bash` tool call. Exits 0
 * immediately unless the command is a test-runner invocation (`npm test`,
 * `node --test`, `node -test`). When a test-runner is detected, scans
 * bin/__tests__/*.test.js for orphan `assert.doesNotThrow` calls (blocks
 * that contain doesNotThrow without a paired value assertion).
 *
 * Promoted from warn-only (v2.2.15) to exit-2 (v2.2.17) — see C-01 wiring spec.
 *
 * Kill switch: ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED=1
 *
 * Events emitted:
 *   lint_doesnotthrow_orphan_warn    — always emitted when findings > 0
 *   lint_doesnotthrow_orphan_blocked — emitted alongside warn; triggers exit 2
 *
 * Stdin contract: Claude Code PreToolUse hooks receive a JSON object on stdin
 * with `tool_name` and `tool_input` fields. We read `tool_input.command` to
 * check whether this is a test-runner invocation before doing any work.
 */

const fs   = require('fs');
const path = require('path');
const { findOrphans, isDisabled } = require('./_lib/lint-doesnotthrow-orphan');
const { writeEvent }              = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }         = require('./_lib/constants');
const { resolveSafeCwd }          = require('./_lib/resolve-project-cwd');

// Commands that indicate a test-runner invocation.
// v2.2.17 W9 reviewer F-10: dropped invalid `node -test` (single-dash) variant.
// Node's test runner flag is `--test` (double-dash); single-dash would parse as
// `-t -e -s -t` which is not a real invocation.
const TEST_RUNNER_RE = /\b(?:npm\s+test|node\s+--test)\b/;

function emitEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

function main() {
  if (isDisabled()) {
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
    } catch (_e) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only activate for Bash tool invocations.
    const toolName = event.tool_name || '';
    if (toolName !== 'Bash') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only activate when the command is a test-runner invocation.
    const command = (event.tool_input && typeof event.tool_input.command === 'string')
      ? event.tool_input.command
      : '';
    if (!TEST_RUNNER_RE.test(command)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const cwd = resolveSafeCwd();

    const TEST_DIR = path.join(__dirname, '__tests__');
    let files = [];
    try {
      files = fs.readdirSync(TEST_DIR)
        .filter(n => n.endsWith('.test.js'))
        .map(n => path.join(TEST_DIR, n));
    } catch (_e) {
      // If we can't read the test directory, fail open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const totalFindings = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const orphans = findOrphans(content, f);
        if (orphans.length) totalFindings.push(...orphans);
      } catch (_e) { /* skip unreadable files */ }
    }

    if (totalFindings.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Emit warn event for each finding (cap payload at 20).
    for (const finding of totalFindings.slice(0, 20)) {
      emitEvent(cwd, {
        type:            'lint_doesnotthrow_orphan_warn',
        version:         1,
        schema_version:  1,
        file:            finding.file,
        line:            finding.line,
        test_name:       finding.test_name,
      });
    }

    // Emit blocked event.
    emitEvent(cwd, {
      type:               'lint_doesnotthrow_orphan_blocked',
      version:            1,
      schema_version:     1,
      findings_count:     totalFindings.length,
      kill_switch_active: false,
    });

    process.stderr.write(
      '[orchestray] doesNotThrow orphan lint: ' + totalFindings.length +
      ' finding(s) — exit 2\n' +
      'Set ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED=1 to bypass.\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'lint_doesnotthrow_orphan_blocked:' + totalFindings.length + '_findings',
    }));
    process.exit(2);
  });
}

main();
