#!/usr/bin/env node
'use strict';

/**
 * canonical-agents-parity.test.js — §7 guard test.
 *
 * Asserts that bin/audit-event.js, bin/ox.js, and bin/gate-agent-spawn.js
 * all import CANONICAL_AGENTS from the central module and have NO remaining
 * literal Set construction for the canonical agent names.
 *
 * This test prevents future drift: if someone re-introduces a literal copy
 * instead of importing from _lib/canonical-agents.js, this test fails.
 *
 * Runner: node --test bin/__tests__/canonical-agents-parity.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const BIN_DIR = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Helper: read file source
// ---------------------------------------------------------------------------

function readSource(relPath) {
  return fs.readFileSync(path.join(BIN_DIR, relPath), 'utf8');
}

// ---------------------------------------------------------------------------
// The canonical set itself
// ---------------------------------------------------------------------------

describe('canonical-agents-parity', () => {

  test('canonical-agents.js exports a frozen Set with exactly 24 names', () => {
    const { CANONICAL_AGENTS } = require('../_lib/canonical-agents');
    assert.ok(CANONICAL_AGENTS instanceof Set, 'CANONICAL_AGENTS should be a Set');
    assert.equal(CANONICAL_AGENTS.size, 24, 'expected 24 canonical agent names');

    // Verify the Set is frozen (Object.isFrozen on a Set checks the wrapper).
    assert.ok(Object.isFrozen(CANONICAL_AGENTS), 'CANONICAL_AGENTS should be frozen');
  });

  test('canonical-agents.js contains all 20 Orchestray + 4 Claude Code built-ins', () => {
    const { CANONICAL_AGENTS } = require('../_lib/canonical-agents');

    // 14 original cores
    const originalCores = [
      'pm', 'architect', 'developer', 'refactorer', 'inventor', 'researcher',
      'reviewer', 'debugger', 'tester', 'documenter', 'security-engineer',
      'release-manager', 'ux-critic', 'platform-oracle',
    ];
    for (const name of originalCores) {
      assert.ok(CANONICAL_AGENTS.has(name), 'missing core: ' + name);
    }

    // 2 v2.3.1 additions (pm.md parenthetical)
    assert.ok(CANONICAL_AGENTS.has('project-intent'), 'missing: project-intent');
    assert.ok(CANONICAL_AGENTS.has('curate-runner'),  'missing: curate-runner');

    // 4 v2.3.1 fix-pass additions (hook-spawned agents)
    assert.ok(CANONICAL_AGENTS.has('curator'),                'missing: curator');
    assert.ok(CANONICAL_AGENTS.has('haiku-scout'),            'missing: haiku-scout');
    assert.ok(CANONICAL_AGENTS.has('orchestray-housekeeper'), 'missing: orchestray-housekeeper');
    assert.ok(CANONICAL_AGENTS.has('pattern-extractor'),      'missing: pattern-extractor');

    // 4 Claude Code built-ins
    const builtins = ['Explore', 'Plan', 'general-purpose', 'Task'];
    for (const name of builtins) {
      assert.ok(CANONICAL_AGENTS.has(name), 'missing built-in: ' + name);
    }
  });

  // ---------------------------------------------------------------------------
  // audit-event.js — no literal Set, uses import
  // ---------------------------------------------------------------------------

  test('audit-event.js: no literal CANONICAL_AGENTS Set construction', () => {
    const src = readSource('audit-event.js');

    // Must NOT contain `new Set([` on the same block as canonical agent names
    // (the old literal). We check for the specific old pattern.
    const hasLiteral = /new Set\(\s*\[\s*['"]pm['"]/m.test(src);
    assert.equal(hasLiteral, false,
      'audit-event.js still has a literal CANONICAL_AGENTS Set — use import from _lib/canonical-agents.js');
  });

  test('audit-event.js: imports from _lib/canonical-agents', () => {
    const src = readSource('audit-event.js');
    const hasImport = /require\(['"]\.\/\_lib\/canonical-agents['"]\)/.test(src);
    assert.ok(hasImport,
      'audit-event.js should import CANONICAL_AGENTS from ./_lib/canonical-agents');
  });

  // ---------------------------------------------------------------------------
  // ox.js — no literal Set, uses import
  // ---------------------------------------------------------------------------

  test('ox.js: no literal CANONICAL_AGENTS Set construction', () => {
    const src = readSource('ox.js');
    const hasLiteral = /new Set\(\s*\[\s*['"]pm['"]/m.test(src);
    assert.equal(hasLiteral, false,
      'ox.js still has a literal CANONICAL_AGENTS Set — use import from _lib/canonical-agents.js');
  });

  test('ox.js: imports from _lib/canonical-agents', () => {
    const src = readSource('ox.js');
    const hasImport = /require\(['"]\.\/\_lib\/canonical-agents['"]\)/.test(src);
    assert.ok(hasImport,
      'ox.js should import CANONICAL_AGENTS from ./_lib/canonical-agents');
  });

  // ---------------------------------------------------------------------------
  // gate-agent-spawn.js — check for import (Developer B's file; we verify
  // the import exists once Developer B completes their work). If the file
  // does not yet import from canonical-agents, we emit a warning rather than
  // a hard failure, because Developer B runs in parallel.
  // ---------------------------------------------------------------------------

  test('gate-agent-spawn.js: imports from _lib/canonical-agents (or pending Developer B)', () => {
    let src;
    try {
      src = readSource('gate-agent-spawn.js');
    } catch (e) {
      // File not found — skip
      return;
    }

    const hasImport = /require\(['"]\.\/\_lib\/canonical-agents['"]\)/.test(src);
    // v2.3.1: hard-asserted (was soft-warn). Drift = privilege-escalation risk.
    assert.ok(
      hasImport,
      'gate-agent-spawn.js must require("./_lib/canonical-agents") — literal sets forbidden post-v2.3.1.'
    );
  });

  // ---------------------------------------------------------------------------
  // Consistency: CANONICAL_AGENTS set from the module matches its own exports
  // ---------------------------------------------------------------------------

  test('CANONICAL_AGENTS is deterministic across multiple require() calls', () => {
    const { CANONICAL_AGENTS: a } = require('../_lib/canonical-agents');
    const { CANONICAL_AGENTS: b } = require('../_lib/canonical-agents');
    // Same module instance (Node caches) — should be the exact same reference.
    assert.strictEqual(a, b);
  });
});
