#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook — reset the context-telemetry cache to a fresh skeleton.
 *
 * Runs on every new Claude Code session start. Truncates the cache and writes
 * a skeleton with the new session_id so the statusline renderer does not show
 * stale counts from a prior session.
 *
 * Fail-open contract: any error → log stderr → exit 0 (never block SessionStart).
 * W3 / v2.0.19 Pillar B.
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { resetCache }     = require('./_lib/context-telemetry-cache');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] reset-context-telemetry: stdin exceeded limit; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event  = JSON.parse(input || '{}');
    const cwd    = resolveSafeCwd(event.cwd);
    const sessId = event.session_id || null;

    resetCache(cwd, sessId);
  } catch (err) {
    process.stderr.write('[orchestray] reset-context-telemetry: error (fail-open): ' + String(err) + '\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
