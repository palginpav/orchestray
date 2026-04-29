#!/usr/bin/env node
'use strict';

/**
 * v2210-watcher-coverage.test.js — watcher-of-the-watcher CI gate.
 * (v2.2.10 N2)
 *
 * Mission
 * -------
 * Scans agents/pm.md + agents/pm-reference/*.md + agents/<role>.md for
 * `emit \`<event_type>\`` prose instructions. For every captured event_type,
 * asserts it is covered by EITHER:
 *   a) pm-emit-state-watcher.js WATCH_TARGETS (mechanical backstop), OR
 *   b) audit-pm-emit-coverage.js WATCHED_EVENT_TYPES (rot-detection list).
 *
 * A prose MUST-emit without backstop coverage is a P0 prose-rot risk.
 * The test FAILS loudly with the unmatched list — it does NOT skip.
 *
 * Tests
 * -----
 *   Test 1 (positive coverage): all prose-emit event_types have backstop coverage.
 *   Test 2 (negative — synthetic): a temp file with an uncovered emit DOES cause
 *     a coverage miss — proving the gate fires when needed.
 *
 * Runner
 * ------
 *   cd /home/palgin/orchestray && npm test -- --testPathPattern=v2210-watcher-coverage
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
  scanForMustEmitPatterns,
  resolveMarkdownPaths,
  extractWatcherEventTypes,
} = require('../_lib/watcher-coverage-scan');

// ---------------------------------------------------------------------------
// Load coverage sets from authoritative sources
// ---------------------------------------------------------------------------

/**
 * Extract WATCH_TARGETS event types from the watcher module.
 * We require() the module to get the live WATCH_TARGETS array, then use
 * extractWatcherEventTypes to enumerate what it backstops.
 * The watcher module does not export WATCH_TARGETS directly, so we parse
 * the source to extract eventType values reliably without executing hooks.
 */
function loadWatcherCoveredTypes() {
  const watcherSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'bin', '_lib', 'pm-emit-state-watcher.js'),
    'utf8',
  );

  // Extract all `eventType: '<slug>'` strings from WATCH_TARGETS section.
  // Also extract dynamic types from resolveEventType return statements.
  const types = new Set();

  // Static eventType: 'slug' declarations
  const staticRe = /eventType:\s*'([a-z][a-z0-9_]*)'/g;
  let m;
  while ((m = staticRe.exec(watcherSrc)) !== null) {
    types.add(m[1]);
  }

  // Dynamic resolveEventType returns (e.g. return 'verify_fix_fail')
  const dynRe = /return\s+'([a-z][a-z0-9_]*)'\s*;/g;
  while ((m = dynRe.exec(watcherSrc)) !== null) {
    // Only add if it looks like an event slug (not a status string like 'resolved')
    const slug = m[1];
    if (!['resolved', 'escalated', 'open', 'in_progress', 'design_rejected'].includes(slug)) {
      types.add(slug);
    }
  }

  return types;
}

/**
 * Extract WATCHED_EVENT_TYPES from audit-pm-emit-coverage.js by parsing source.
 */
function loadCoverageScriptTypes() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'bin', 'audit-pm-emit-coverage.js'),
    'utf8',
  );

  // Match the WATCHED_EVENT_TYPES array
  const arrayMatch = src.match(/const\s+WATCHED_EVENT_TYPES\s*=\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return new Set();

  const types = new Set();
  const slugRe = /'([a-z][a-z0-9_]*)'/g;
  let m;
  while ((m = slugRe.exec(arrayMatch[1])) !== null) {
    types.add(m[1]);
  }
  return types;
}

/**
 * Resolve the full list of agent markdown files to scan.
 */
function resolveAgentFiles() {
  const paths = [];

  // agents/pm.md
  const pmMd = path.join(REPO_ROOT, 'agents', 'pm.md');
  if (fs.existsSync(pmMd)) paths.push(pmMd);

  // agents/pm-reference/*.md
  const pmRefDir = path.join(REPO_ROOT, 'agents', 'pm-reference');
  if (fs.existsSync(pmRefDir)) {
    const resolved = resolveMarkdownPaths([pmRefDir]);
    paths.push(...resolved);
  }

  // agents/<role>.md — all other *.md at agents/ root (excluding pm.md already added)
  const agentsDir = path.join(REPO_ROOT, 'agents');
  try {
    const items = fs.readdirSync(agentsDir);
    for (const item of items) {
      if (!item.endsWith('.md')) continue;
      const abs = path.join(agentsDir, item);
      if (abs === pmMd) continue; // already added
      // Skip subdirectories (pm-reference handled above)
      try {
        if (fs.statSync(abs).isFile()) paths.push(abs);
      } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* skip */ }

  return paths;
}

// ---------------------------------------------------------------------------
// Shared setup (run once, used by both tests)
// ---------------------------------------------------------------------------

const watcherTypes   = loadWatcherCoveredTypes();
const coverageTypes  = loadCoverageScriptTypes();
const allCovered     = new Set([...watcherTypes, ...coverageTypes]);
const agentFiles     = resolveAgentFiles();
const proseEmitTypes = scanForMustEmitPatterns(agentFiles);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.10 N2 — watcher coverage gate', () => {

  test('Test 1 (positive coverage): all prose-emit event_types are backstopped', () => {
    const unmatched = [];
    for (const eventType of proseEmitTypes) {
      if (!allCovered.has(eventType)) {
        unmatched.push(eventType);
      }
    }

    if (unmatched.length > 0) {
      // Emit a diagnostic-friendly message listing exactly which events lack coverage.
      // This is the ship-blocking signal the orchestrator needs to route a backstop fix.
      const diagnosticLines = [
        '',
        '--- COVERAGE MISS DIAGNOSTIC ---',
        `Scanned ${agentFiles.length} agent file(s).`,
        `Found ${proseEmitTypes.size} prose-emit event type(s): [${[...proseEmitTypes].sort().join(', ')}]`,
        `Watcher backstops: [${[...watcherTypes].sort().join(', ')}]`,
        `Coverage-script types: [${[...coverageTypes].sort().join(', ')}]`,
        '',
        `UNMATCHED (${unmatched.length}):`,
        ...unmatched.sort().map(t => `  - ${t}`),
        '',
        'These prose-emit instructions have NO mechanical backstop.',
        'Each unmatched event_type is a P0 prose-rot risk.',
        '---',
      ];
      assert.fail(diagnosticLines.join('\n'));
    }

    // All covered — confirm counts for visibility
    assert.ok(
      proseEmitTypes.size >= 0,
      `scan complete: ${proseEmitTypes.size} prose-emit type(s) found, all covered`,
    );
  });

  test('Test 2 (negative — synthetic detection): a temp file with an uncovered emit IS detected as a miss', () => {
    // Write a temp file with a synthetic event type that is guaranteed NOT to
    // be in any watcher or coverage list.
    const tmpDir  = os.tmpdir();
    const tmpFile = path.join(tmpDir, `v2210-watcher-coverage-synthetic-${Date.now()}.md`);

    try {
      fs.writeFileSync(
        tmpFile,
        [
          '# Synthetic test agent',
          '',
          'When the task completes, the PM MUST emit `synthetic_test_event` to signal',
          'completion of the synthetic workflow.',
          '',
          'Also emit `another_synthetic_event_xyz` after cleanup.',
        ].join('\n'),
        'utf8',
      );

      // Scan just the temp file
      const syntheticTypes = scanForMustEmitPatterns([tmpFile]);

      // Confirm both synthetic slugs were detected
      assert.ok(
        syntheticTypes.has('synthetic_test_event'),
        'scanner must detect synthetic_test_event from temp file',
      );
      assert.ok(
        syntheticTypes.has('another_synthetic_event_xyz'),
        'scanner must detect another_synthetic_event_xyz from temp file',
      );

      // Confirm neither synthetic type is in the coverage set
      const syntheticUnmatched = [...syntheticTypes].filter(t => !allCovered.has(t));
      assert.ok(
        syntheticUnmatched.includes('synthetic_test_event'),
        'synthetic_test_event must NOT be in coverage set (meta-test validity check)',
      );
      assert.ok(
        syntheticUnmatched.includes('another_synthetic_event_xyz'),
        'another_synthetic_event_xyz must NOT be in coverage set (meta-test validity check)',
      );

      // Verify that running the same coverage check against [tmpFile + covered files]
      // WOULD produce unmatched results — the gate would fire.
      const combinedTypes = scanForMustEmitPatterns([tmpFile, ...agentFiles]);
      const combinedUnmatched = [...combinedTypes].filter(t => !allCovered.has(t));
      assert.ok(
        combinedUnmatched.length > 0,
        'coverage check with synthetic file MUST report unmatched events (gate fires)',
      );
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_e) { /* best effort */ }
    }
  });

});
