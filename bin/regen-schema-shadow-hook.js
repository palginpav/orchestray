#!/usr/bin/env node
'use strict';

/**
 * regen-schema-shadow-hook.js — PostToolUse hook on Edit of event-schemas.md (R-SHDW, v2.1.14).
 *
 * When the agent edits agents/pm-reference/event-schemas.md, this hook
 * auto-regenerates the event-schema shadow JSON so the shadow stays in sync.
 *
 * Fail-open contract: any error → stderr warning, exit 0 (never blocks).
 * The regeneration failure is surfaced as a stderr message; the hook never
 * blocks the Edit that triggered it.
 *
 * Input:  JSON on stdin (Claude Code PostToolUse hook payload)
 * Output: JSON on stdout ({ continue: true }), always exit 0
 */

const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { main: regenMain } = require('./regen-schema-shadow');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[regen-schema-shadow-hook] stdin exceeded limit; skipping\n');
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    handle(event);
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Check if the edited file is the canonical event-schemas.md.
    // The PostToolUse payload for Edit has tool_input.file_path.
    // W7 fix-pass L-002 (v2.2.0): match the canonical relative path
    // (agents/pm-reference/event-schemas.md) rather than any path ending
    // with the basename — `attacker-event-schemas.md` must NOT trigger.
    const toolInput = (event && event.tool_input) || {};
    const filePath = toolInput.file_path || '';
    const CANONICAL_REL = path.join('agents', 'pm-reference', 'event-schemas.md').replace(/\\/g, '/');
    const normalized = String(filePath).replace(/\\/g, '/');
    const isEventSchemas = normalized.endsWith('/' + CANONICAL_REL) || normalized === CANONICAL_REL;
    if (!isEventSchemas) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    // Regenerate the shadow
    try {
      const shadow = regenMain(cwd);
      const count = Object.keys(shadow).filter(k => k !== '_meta').length;
      process.stderr.write(
        '[regen-schema-shadow-hook] auto-regenerated shadow: ' + count +
        ' event types, ' + shadow._meta.shadow_size_bytes + ' bytes\n'
      );
    } catch (regenErr) {
      // Fail-open: warn but do not block
      process.stderr.write('[regen-schema-shadow-hook] regen failed: ' + regenErr.message + '\n');
    }

    // v2.2.0 P1.3: also regen the tier2-index sidecar from the same source.
    // Both outputs share the same source-hash; computing twice in lock-step
    // keeps the shadow + index from disagreeing on slug coverage. Fail-open
    // independently of the shadow regen.
    try {
      const { buildIndex } = require('./_lib/tier2-index');
      const index = buildIndex({ cwd });
      const idxCount = Object.keys(index.events).length;
      process.stderr.write(
        '[regen-schema-shadow-hook] auto-regenerated tier2-index: ' + idxCount +
        ' events, ' + index._meta.index_size_bytes + ' bytes\n'
      );
    } catch (idxErr) {
      process.stderr.write(
        '[regen-schema-shadow-hook] tier2-index regen failed: ' + idxErr.message + '\n'
      );
    }
  } catch (_e) {
    process.stderr.write('[regen-schema-shadow-hook] unexpected error: ' + _e.message + '\n');
  }

  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
}
