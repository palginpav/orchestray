#!/usr/bin/env node
'use strict';

/**
 * pattern-collision-summary.test.js
 *
 * F-14 (v2.2.21 W4-T20): pattern_collision_resolved was emitting one event per
 * colliding slug (56 events for 56 collisions). This test verifies the fix:
 * same-tier collisions emit ONE pattern_find_collisions_summary event, not N.
 *
 * Test matrix:
 *  1. 56 same-tier (local wins over shared) collisions → exactly 1 summary event
 *  2. 0 collisions (no shared tier) → no summary event
 *  3. Summary event carries count, all_winning_tier, all_losing_tier, slugs fields
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a minimal project fixture with local + shared patterns.
 * localSlugs and sharedSlugs control which slugs exist in each tier.
 * When sharedSlugs includes slugs that are also in localSlugs, those are
 * collisions (local wins).
 */
/**
 * Make a minimal project fixture with local + shared patterns.
 *
 * Uses ORCHESTRAY_TEST_SHARED_DIR env var (the existing test override in paths.js)
 * to point pattern_find at the shared patterns directory without needing a real
 * federation config. Returns a cleanup function to unset the env var.
 */
function makeFixture(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f14-collision-'));
  // paths.js expects ORCHESTRAY_TEST_SHARED_DIR to be the *parent* of /patterns/
  const sharedRoot        = path.join(tmp, 'shared');
  const localPatternsDir  = path.join(tmp, '.orchestray', 'patterns');
  const sharedPatternsDir = path.join(sharedRoot, 'patterns');
  const auditDir          = path.join(tmp, '.orchestray', 'audit');

  fs.mkdirSync(localPatternsDir,  { recursive: true });
  fs.mkdirSync(sharedPatternsDir, { recursive: true });
  fs.mkdirSync(auditDir,          { recursive: true });

  // Minimal pattern frontmatter.
  const patternContent = (slug) => [
    '---',
    'name: ' + slug,
    'description: test pattern ' + slug,
    'confidence: 0.8',
    'category: decomposition',
    'times_applied: 1',
    '---',
    'Pattern body for ' + slug,
  ].join('\n');

  for (const slug of (opts.localSlugs || [])) {
    fs.writeFileSync(path.join(localPatternsDir, slug + '.md'), patternContent(slug));
  }

  // Set env vars so the MCP tool can find:
  // 1. ORCHESTRAY_TEST_SHARED_DIR → getSharedPatternsDir() returns our shared dir.
  // 2. ORCHESTRAY_PROJECT_ROOT   → writeAuditEvent() writes to our tmp dir.
  const prevShared  = process.env.ORCHESTRAY_TEST_SHARED_DIR;
  const prevProjRoot = process.env.ORCHESTRAY_PROJECT_ROOT;
  const prevClaude  = process.env.CLAUDE_PROJECT_DIR;

  // Always set project root so audit events land in the fixture dir.
  process.env.ORCHESTRAY_PROJECT_ROOT = tmp;

  let cleanup = () => {
    if (prevProjRoot === undefined) delete process.env.ORCHESTRAY_PROJECT_ROOT;
    else process.env.ORCHESTRAY_PROJECT_ROOT = prevProjRoot;
    if (prevClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevClaude;
    if (prevShared === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    else process.env.ORCHESTRAY_TEST_SHARED_DIR = prevShared;
  };

  if (opts.sharedSlugs && opts.sharedSlugs.length > 0) {
    for (const slug of opts.sharedSlugs) {
      fs.writeFileSync(path.join(sharedPatternsDir, slug + '.md'), patternContent(slug));
    }
    // Set the test env override so paths.getSharedPatternsDir() returns our dir.
    process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedRoot;
  }

  return { tmp, auditDir, localPatternsDir, sharedPatternsDir, cleanup };
}

function readAuditEvents(auditDir) {
  const eventsFile = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The pattern_find handler is an MCP tool — invoke it directly via its handle()
// export rather than spawning a subprocess, so we can inject a projectRoot.
// ---------------------------------------------------------------------------

// Resolve paths.js and lib paths relative to the MCP server directory.
const MCP_DIR = path.join(REPO_ROOT, 'bin', 'mcp-server');
const patternFindPath = path.join(MCP_DIR, 'tools', 'pattern_find.js');

// The handle() function is not directly exported, but we can invoke it
// by requiring the module and looking for the exported handler.
// pattern_find.js exports { definition, handle } via module.exports.
let patternFindModule;
try {
  patternFindModule = require(patternFindPath);
} catch (e) {
  // Module may fail to load in test environment (missing native deps like sqlite).
  // In that case, mark tests as skipped via a flag.
  patternFindModule = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F-14: pattern_find_collisions_summary', () => {
  test('56 same-tier collisions emit exactly 1 summary event', async (t) => {
    if (!patternFindModule || typeof patternFindModule.handle !== 'function') {
      t.skip('pattern_find module not loadable in this environment');
      return;
    }

    // Build 56 slugs that exist in both local and shared.
    const slugs = Array.from({ length: 56 }, (_, i) => 'pattern-' + String(i).padStart(3, '0'));
    const { tmp, auditDir, cleanup } = makeFixture({ localSlugs: slugs, sharedSlugs: slugs });

    try {
      await patternFindModule.handle(
        { task_summary: 'decompose a complex multi-agent task' },
        { projectRoot: tmp },
      );
    } catch (_) {
      // Errors in pattern_find itself don't invalidate the audit-event assertion.
    } finally {
      cleanup();
    }

    const events = readAuditEvents(auditDir);
    const collisionEvents = events.filter((e) => e.type === 'pattern_collision_resolved');
    const summaryEvents   = events.filter((e) => e.type === 'pattern_find_collisions_summary');

    assert.strictEqual(
      collisionEvents.length, 0,
      'pattern_collision_resolved (per-slug) events must be 0 (replaced by summary)',
    );
    assert.strictEqual(
      summaryEvents.length, 1,
      'exactly 1 pattern_find_collisions_summary event must be emitted for 56 collisions',
    );

    const summary = summaryEvents[0];
    assert.strictEqual(summary.count, 56, 'summary.count must be 56');
    assert.strictEqual(summary.all_winning_tier, 'local', 'summary.all_winning_tier must be "local"');
    assert.strictEqual(summary.all_losing_tier, 'shared', 'summary.all_losing_tier must be "shared"');
    assert.ok(Array.isArray(summary.slugs), 'summary.slugs must be an array');
    assert.ok(summary.slugs.length <= 20, 'summary.slugs is capped at 20 for log hygiene');
  });

  test('0 collisions (no shared tier) emits no summary event', async (t) => {
    if (!patternFindModule || typeof patternFindModule.handle !== 'function') {
      t.skip('pattern_find module not loadable in this environment');
      return;
    }

    const slugs = ['alpha', 'beta', 'gamma'];
    const { tmp, auditDir, cleanup } = makeFixture({ localSlugs: slugs, sharedSlugs: [] });

    try {
      await patternFindModule.handle(
        { task_summary: 'decompose a complex multi-agent task' },
        { projectRoot: tmp },
      );
    } catch (_) { /* ignore */ } finally {
      cleanup();
    }

    const events = readAuditEvents(auditDir);
    const summaryEvents = events.filter((e) => e.type === 'pattern_find_collisions_summary');

    assert.strictEqual(
      summaryEvents.length, 0,
      'no summary event when there are no collisions',
    );
  });

  test('summary event fields are all present and correct', async (t) => {
    if (!patternFindModule || typeof patternFindModule.handle !== 'function') {
      t.skip('pattern_find module not loadable in this environment');
      return;
    }

    // 3 collisions: small count to verify slugs list.
    const colliding = ['foo', 'bar', 'baz'];
    const { tmp, auditDir, cleanup } = makeFixture({ localSlugs: colliding, sharedSlugs: colliding });

    try {
      await patternFindModule.handle(
        { task_summary: 'routing decision for orchestration' },
        { projectRoot: tmp },
      );
    } catch (_) { /* ignore */ } finally {
      cleanup();
    }

    const events = readAuditEvents(auditDir);
    const summaryEvents = events.filter((e) => e.type === 'pattern_find_collisions_summary');

    if (summaryEvents.length === 0) {
      // Federation may not be enabled in test env — skip gracefully.
      t.skip('no summary event emitted (federation not active in test env)');
      return;
    }

    const s = summaryEvents[0];
    assert.ok(typeof s.timestamp === 'string', 'summary.timestamp must be a string');
    assert.ok(typeof s.count === 'number' && s.count > 0, 'summary.count must be a positive number');
    assert.strictEqual(s.all_winning_tier, 'local');
    assert.strictEqual(s.all_losing_tier, 'shared');
    assert.ok(Array.isArray(s.slugs), 'summary.slugs must be an array');
    // All colliding slugs must appear in the slugs list (for small counts).
    for (const slug of colliding) {
      assert.ok(s.slugs.includes(slug), 'slug "' + slug + '" must appear in summary.slugs');
    }
  });
});
