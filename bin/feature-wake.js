#!/usr/bin/env node
'use strict';

/**
 * feature-wake.js — CLI for /orchestray:feature wake (R-GATE, v2.1.14).
 *
 * Wakes a quarantined gate slug for the current session or for 30 days (--persist).
 * Emits a `feature_wake` audit event.
 *
 * Usage:
 *   node bin/feature-wake.js [--persist] <name>
 *   node bin/feature-wake.js [--cwd /path] [--persist] <name>
 *
 * Exit code 0 always (fail-open).
 */

const fs   = require('fs');
const path = require('path');

const { addSessionWake, addPinnedWake } = require('./_lib/effective-gate-state');
const { atomicAppendJsonl }             = require('./_lib/atomic-append');
const { getCurrentOrchestrationFile }   = require('./_lib/orchestration-state');
const { WIRED_EMITTER_PROTOCOLS }       = require('./_lib/feature-demand-tracker');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  let persist = false;
  let cwd     = process.cwd();
  let slug    = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--persist') {
      persist = true;
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwd = path.resolve(args[i + 1]);
      i++;
    } else if (!args[i].startsWith('-')) {
      slug = args[i];
    }
  }

  return { persist, cwd, slug };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { persist, cwd, slug } = parseArgs(process.argv.slice(2));

  if (!slug) {
    process.stderr.write('Usage: feature-wake.js [--persist] <gate-slug>\n');
    process.exit(0);
  }

  // Warn if not a recognized slug (but proceed anyway).
  if (!WIRED_EMITTER_PROTOCOLS.includes(slug)) {
    process.stderr.write(
      `Warning: '${slug}' is not a recognized gate slug for v2.1.14. ` +
      `Recognized: ${WIRED_EMITTER_PROTOCOLS.join(', ')}.\n`
    );
  }

  const scope = persist ? '30d_pinned' : 'session';

  if (persist) {
    addPinnedWake(cwd, slug);
  } else {
    addSessionWake(cwd, slug);
  }

  // Emit feature_wake audit event
  try {
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) {}

    const auditDir = path.join(cwd, '.orchestray', 'audit');
    try { fs.mkdirSync(auditDir, { recursive: true }); } catch (_e) {}

    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), {
      version:          1,
      type:             'feature_wake',
      timestamp:        new Date().toISOString(),
      orchestration_id: orchestrationId,
      gate_slug:        slug,
      scope,
      caller:           'cli',
    });
  } catch (_e) {}

  if (persist) {
    const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    process.stdout.write(`[orchestray] ${slug}: pinned wake active until ${expiryDate}. Gate will be treated as enabled across sessions until then.\n`);
  } else {
    process.stdout.write(`[orchestray] ${slug}: session wake activated. Gate will be treated as enabled.\n`);
  }
}

main();
