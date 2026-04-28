#!/usr/bin/env node
'use strict';

/**
 * expire-auto-trigger.js — UserPromptSubmit early-tail hook.
 *
 * v2.2.9 B-7.6: deletes `.orchestray/auto-trigger.json` if it is older than
 * `auto_trigger_ttl_seconds` (default 3600). Emits `auto_trigger_expired`
 * on the unlink path. Pure passthrough — never blocks the prompt, never
 * mutates additionalContext. See bin/_lib/auto-trigger-ttl.js for the helper.
 *
 * Input:  Claude Code UserPromptSubmit JSON envelope on stdin
 * Output: exit 0, no stdout content (pure side-effect hook)
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { runSweep } = require('./_lib/auto-trigger-ttl');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

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
  let cwd;
  try {
    const event = input ? JSON.parse(input) : {};
    cwd = resolveSafeCwd(event && event.cwd);
  } catch (_e) {
    cwd = resolveSafeCwd();
  }
  try {
    runSweep(cwd);
  } catch (_e) { /* fail-open */ }
  process.exit(0);
});
