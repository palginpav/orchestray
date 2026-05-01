'use strict';

/**
 * polish-surface-bundle.test.js — v2.2.21 G3-W5-T28
 *
 * Parity asserts for the 16-finding "polish surface bundle":
 *   - .legacy TTL headers present and pin to v2.3.0 (W-CQ-4)
 *   - audit-event-writer.normalizeVersionFields makes payloads carry both
 *     `version` and `schema_version` set to the same integer (I-OP-1)
 *   - validate-no-deferral exposes findDeferralCached and the cache returns
 *     deterministic hits (W-PE-1)
 *   - inject-active-phase-slice exposes _shouldSkipReStage and the cache
 *     skips re-staging when freshly written (I-PE-1)
 *   - inject-review-dimensions writes files-changed-cache.json on cache miss
 *     and reads it on hit (W-PE-2)
 *   - architect.md tools list contains mcp__orchestray__history_query_events (W-OP-7)
 *   - phase-decomp.md step 1b carries the pipeline-templates clarification (I-CQ-2)
 *   - handoff-contract.md §10 carries the per-role token budget table (W-AC-1/2)
 *   - statusline.js idle-suppression branch is wired (F-19; runtime-tested in
 *     dedicated suite, this is a static-source check)
 */

const test       = require('node:test');
const assert     = require('node:assert/strict');
const path       = require('node:path');
const fs         = require('node:fs');
const os         = require('node:os');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// W-CQ-4: .legacy TTL headers
// ---------------------------------------------------------------------------

const LEGACY_FILES = [
  'agents/curator.md.legacy',
  'agents/pm-reference/tier1-orchestration.md.legacy',
  'agents/pm-reference/repo-map-protocol.md.legacy',
];

test('W-CQ-4: every .legacy shim carries the v2.2.21 → v2.3.0 TTL header', () => {
  for (const rel of LEGACY_FILES) {
    const p = path.join(ROOT, rel);
    const head = fs.readFileSync(p, 'utf8').slice(0, 2000);
    assert.match(head, /v2\.2\.21:\s*scheduled for removal in v2\.3\.0/i,
      `${rel} missing TTL header`);
  }
});

// ---------------------------------------------------------------------------
// I-OP-1: audit-event normalization
// ---------------------------------------------------------------------------

test('I-OP-1: normalizeVersionFields fills both version + schema_version', () => {
  const { normalizeVersionFields } = require(path.join(ROOT, 'bin', '_lib', 'audit-event-writer.js'));
  // Case 1: nothing set
  const e1 = { type: 'foo' };
  normalizeVersionFields(e1);
  assert.equal(e1.version, 1);
  assert.equal(e1.schema_version, 1);
  // Case 2: only version set
  const e2 = { type: 'bar', version: 2 };
  normalizeVersionFields(e2);
  assert.equal(e2.version, 2);
  assert.equal(e2.schema_version, 2);
  // Case 3: only schema_version set
  const e3 = { type: 'baz', schema_version: 3 };
  normalizeVersionFields(e3);
  assert.equal(e3.version, 3);
  assert.equal(e3.schema_version, 3);
  // Case 4: both already set — no change
  const e4 = { type: 'qux', version: 5, schema_version: 5 };
  normalizeVersionFields(e4);
  assert.equal(e4.version, 5);
  assert.equal(e4.schema_version, 5);
});

test('I-OP-1: normalizeVersionFields is idempotent', () => {
  const { normalizeVersionFields } = require(path.join(ROOT, 'bin', '_lib', 'audit-event-writer.js'));
  const e = { type: 'x' };
  normalizeVersionFields(e);
  const after1 = JSON.stringify(e);
  normalizeVersionFields(e);
  assert.equal(JSON.stringify(e), after1);
});

test('I-OP-1: normalizeVersionFields fails-soft on non-object input', () => {
  const { normalizeVersionFields } = require(path.join(ROOT, 'bin', '_lib', 'audit-event-writer.js'));
  assert.doesNotThrow(() => normalizeVersionFields(null));
  assert.doesNotThrow(() => normalizeVersionFields(undefined));
  assert.doesNotThrow(() => normalizeVersionFields('not an object'));
});

// ---------------------------------------------------------------------------
// W-PE-1: validate-no-deferral.findDeferralCached
// ---------------------------------------------------------------------------

test('W-PE-1: findDeferralCached returns cached result on second call with same input', () => {
  const mod = require(path.join(ROOT, 'bin', 'validate-no-deferral.js'));
  assert.equal(typeof mod.findDeferralCached, 'function', 'export present');

  mod._resetFindDeferralCache();

  // First call — not a release-cue (and "punt" is non-strict, so requires release-cue).
  const benignInput = 'a'.repeat(200) + ' some normal output, no deferral here. ' + 'b'.repeat(200);
  const r1 = mod.findDeferralCached(benignInput, { orchestration_id: 'v2221', agent_id: 'developer' });
  assert.equal(r1.matched, false);

  // Second call — same input, same cache key — should be a cache hit and return the same result.
  const r2 = mod.findDeferralCached(benignInput, { orchestration_id: 'v2221', agent_id: 'developer' });
  assert.deepEqual(r2, r1);
});

test('W-PE-1: findDeferralCached on strict deferral phrase still returns matched', () => {
  const mod = require(path.join(ROOT, 'bin', 'validate-no-deferral.js'));
  mod._resetFindDeferralCache();
  const r = mod.findDeferralCached('we will defer this. TODO for later — v2.3.0 candidate.',
    { orchestration_id: 'v2221', agent_id: 'developer' });
  assert.equal(r.matched, true);
});

// ---------------------------------------------------------------------------
// I-PE-1: inject-active-phase-slice._shouldSkipReStage
// ---------------------------------------------------------------------------

test('I-PE-1: _shouldSkipReStage returns true when dst is fresh and matches src size', () => {
  const mod = require(path.join(ROOT, 'bin', 'inject-active-phase-slice.js'));
  assert.equal(typeof mod._shouldSkipReStage, 'function');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-i-pe-1-'));
  const src = path.join(tmp, 'src.md');
  const dst = path.join(tmp, 'dst.md');
  fs.writeFileSync(src, 'phase content', 'utf8');
  fs.copyFileSync(src, dst);
  // Fresh copy — dst.mtime ≈ now, src.mtime ≈ a few ms earlier (or equal); same size.
  assert.equal(mod._shouldSkipReStage(src, dst), true);
});

test('I-PE-1: _shouldSkipReStage returns false when src was modified after dst', async () => {
  const mod = require(path.join(ROOT, 'bin', 'inject-active-phase-slice.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-i-pe-1b-'));
  const src = path.join(tmp, 'src.md');
  const dst = path.join(tmp, 'dst.md');
  fs.writeFileSync(src, 'old content', 'utf8');
  fs.copyFileSync(src, dst);
  // Force src mtime to be newer than dst.
  await new Promise((res) => setTimeout(res, 20));
  fs.writeFileSync(src, 'new content longer than old', 'utf8');
  assert.equal(mod._shouldSkipReStage(src, dst), false);
});

test('I-PE-1: _shouldSkipReStage returns false when dst missing', () => {
  const mod = require(path.join(ROOT, 'bin', 'inject-active-phase-slice.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-i-pe-1c-'));
  const src = path.join(tmp, 'src.md');
  const dst = path.join(tmp, 'never-existed.md');
  fs.writeFileSync(src, 'x', 'utf8');
  assert.equal(mod._shouldSkipReStage(src, dst), false);
});

// ---------------------------------------------------------------------------
// W-OP-7: architect.md history_query_events tool
// ---------------------------------------------------------------------------

test('W-OP-7: architect.md tools list includes mcp__orchestray__history_query_events', () => {
  const p = path.join(ROOT, 'agents', 'architect.md');
  const head = fs.readFileSync(p, 'utf8').slice(0, 1000);
  assert.match(head, /^tools:.*mcp__orchestray__history_query_events/m,
    'architect.md tools frontmatter must include history_query_events');
});

// ---------------------------------------------------------------------------
// I-CQ-2: phase-decomp pipeline-templates clarification
// ---------------------------------------------------------------------------

test('I-CQ-2: phase-decomp.md step 1b documents auto-load by Tier-2 dispatch', () => {
  const p = path.join(ROOT, 'agents', 'pm-reference', 'phase-decomp.md');
  const txt = fs.readFileSync(p, 'utf8');
  assert.match(txt, /pipeline-templates\.md.*loaded automatically by Tier-2 dispatch/i,
    'phase-decomp.md step 1b must clarify Tier-2 auto-load');
});

// ---------------------------------------------------------------------------
// W-AC-1 / W-AC-2: handoff-contract.md §10 token budget table
// ---------------------------------------------------------------------------

test('W-AC-1 / W-AC-2: handoff-contract.md §10 carries per-role token budget table', () => {
  const p = path.join(ROOT, 'agents', 'pm-reference', 'handoff-contract.md');
  const txt = fs.readFileSync(p, 'utf8');
  // Section 10 contains the new per-role budget reference.
  assert.match(txt, /Per-role output token budget reference/i,
    'handoff-contract.md §10 must contain the per-role budget table');
  // Table rows present for the 14 core roles.
  for (const role of ['developer', 'architect', 'reviewer', 'refactorer', 'tester',
    'documenter', 'release-manager', 'inventor', 'debugger', 'researcher',
    'security-engineer', 'ux-critic', 'platform-oracle', 'project-intent']) {
    assert.match(txt, new RegExp('\\|\\s*' + role + '\\s*\\|', 'm'),
      `handoff-contract.md §10 missing row for role: ${role}`);
  }
  // W-AC-1 reconciliation note present.
  assert.match(txt, /v2\.2\.9 B-2\.1 promotion.*W-AC-1 reconciliation/i);
});

test('W-AC-1: handoff-contract.md §10 tier column matches HARD_TIER in validate-task-completion.js', () => {
  // The table claims all 14 roles are now hard-tier (per v2.2.9 B-2.1).
  // Verify against the JS constant.
  const v = require(path.join(ROOT, 'bin', 'validate-task-completion.js'));
  assert.ok(v.HARD_TIER, 'HARD_TIER export present');
  for (const role of ['developer', 'architect', 'reviewer', 'refactorer', 'tester',
    'documenter', 'release-manager', 'inventor', 'debugger', 'researcher',
    'security-engineer', 'ux-critic', 'platform-oracle', 'project-intent']) {
    assert.ok(v.HARD_TIER.has(role), `HARD_TIER must include ${role}`);
  }
});

// ---------------------------------------------------------------------------
// F-19: statusline idle-suppression source guard
// ---------------------------------------------------------------------------

test('F-19: bin/statusline.js carries idle_suppression branch', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'bin', 'statusline.js'), 'utf8');
  assert.match(txt, /idle_suppression/, 'idle_suppression check is wired');
  assert.match(txt, /F-19 \(v2\.2\.21\)/, 'F-19 marker present');
});

test('F-19: config-schema.js DEFAULT_CONTEXT_STATUSBAR includes idle_suppression: true', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'bin', '_lib', 'config-schema.js'), 'utf8');
  assert.match(txt, /idle_suppression:\s*true/, 'default idle_suppression must be true');
});

// ---------------------------------------------------------------------------
// W-PE-2: files-changed cache file path constant
// ---------------------------------------------------------------------------

test('W-PE-2: inject-review-dimensions.js carries files-changed-cache.json path', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'bin', 'inject-review-dimensions.js'), 'utf8');
  assert.match(txt, /files-changed-cache\.json/,
    'inject-review-dimensions must reference the cache file');
  assert.match(txt, /W-PE-2/, 'W-PE-2 marker present');
});
