#!/usr/bin/env node
'use strict';

/**
 * inject-schema-shadow.js — UserPromptSubmit hook (R-SHDW, v2.1.14).
 *
 * Injects the event-schema shadow into Block A (PM additionalContext) on every
 * PM turn, reducing the need for the PM to load the full 148-KB event-schemas.md.
 *
 * Kill switches (any one → no-op):
 *   - process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW === '1'
 *   - config.event_schema_shadow.enabled === false
 *   - Three-strike sentinel: .orchestray/state/.schema-shadow-disabled exists
 *   - Source-hash mismatch (shadow stale) — emits schema_shadow_stale event, skips
 *
 * Fail-open contract: any error → exit 0 with no injection.
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: JSON on stdout with hookSpecificOutput.additionalContext when injecting,
 *         or JSON.stringify({ continue: true }) when no-op.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { loadShadowWithCheck, recordMiss } = require('./_lib/load-schema-shadow');
const { writeEvent } = require('./_lib/audit-event-writer');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[inject-schema-shadow] stdin exceeded limit; skipping\n');
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    handle(JSON.parse(input || '{}'));
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Config loader for event_schema_shadow block
// ---------------------------------------------------------------------------

/**
 * Load event_schema_shadow config block.
 * Returns { enabled: boolean, miss_threshold_24h: number }
 */
function loadShadowConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  const defaults = { enabled: true, miss_threshold_24h: 3 };
  try {
    const raw    = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const block = parsed.event_schema_shadow;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return defaults;
    return Object.assign({}, defaults, block);
  } catch (_e) {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Audit event emitter (inline — no external dependency on audit-event-writer)
// ---------------------------------------------------------------------------

function emitAuditEvent(cwd, eventType, extra) {
  try {
    const entry = Object.assign({ type: eventType }, extra);
    // Special case: this hook is part of the schema-shadow infrastructure.
    // Skipping validation here avoids a chicken-and-egg loop in which a
    // corrupted schema would block its own staleness telemetry.
    writeEvent(entry, { cwd, skipValidation: true });
  } catch (_e) {
    // Fail-open
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Kill switch: env var
    const envDisabled    = process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW === '1';
    const cfg            = loadShadowConfig(cwd);
    const configDisabled = cfg.enabled === false;

    const { shadow, stale, disabled } = loadShadowWithCheck(cwd, {
      envDisabled,
      configDisabled,
    });

    if (disabled) {
      // No-op (kill switch or sentinel)
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    if (stale) {
      // Emit staleness event and fall through to full-load behavior
      emitAuditEvent(cwd, 'schema_shadow_stale', {
        source_hash_stored:  shadow && shadow._meta && shadow._meta.source_hash,
        version:             1,
      });
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    if (!shadow) {
      // Shadow missing: no-op
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    // Build the injection content
    const eventTypes = Object.keys(shadow).filter(k => k !== '_meta');
    const shadowLine = JSON.stringify(shadow);

    const content = [
      '<event-schema-shadow>',
      'Schema shadow (v=' + shadow._meta.version + ', n=' + eventTypes.length + '): ' + shadowLine,
      'Shadow path: agents/pm-reference/event-schemas.shadow.json',
      'Full schema fallback: agents/pm-reference/event-schemas.md (load on miss)',
      '</event-schema-shadow>',
    ].join('\n');

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: content,
      },
    });

    process.stdout.write(output + '\n');
    process.exit(0);
  } catch (_e) {
    // Fail-open
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
}
