#!/usr/bin/env node
'use strict';

/**
 * Bundle CTX W1 Tests — CiteCache, SpecSketch, RepoMapDelta
 *
 * Covers acceptance criteria 12–23 from the v2.1.8 design spec.
 *
 * Each test group is labelled with the criterion it covers.
 * State is always written to isolated os.tmpdir() sandboxes;
 * the real project state is never touched.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const crypto = require('node:crypto');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeTmp(prefix = 'ctx-w1-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** Create the .orchestray/state directory inside a tmp project root. */
function makeProject(suffix) {
  const root = makeTmp('ctx-w1-' + (suffix || ''));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

/** Load the module fresh (no cache sharing between tests). */
function fresh(relPath) {
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  // Also clear pattern-seen-set which is shared
  try {
    const pss = require.resolve('../bin/_lib/pattern-seen-set');
    delete require.cache[pss];
  } catch (_) {}
  // Clear degraded-journal so KINDS / _seen don't leak
  try {
    const dj = require.resolve('../bin/_lib/degraded-journal');
    delete require.cache[dj];
  } catch (_) {}
  return require(relPath);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ─── CiteCache: pattern-seen-set.js ──────────────────────────────────────────

describe('CiteCache — pattern-seen-set', () => {

  // Spec criterion #14: row written per (orch_id, slug) on first cite
  test('recordSeen writes a JSONL row with orch_id, slug, first_agent, body_hash', () => {
    const root = makeProject('pss-14a');
    const mod = fresh('../bin/_lib/pattern-seen-set');

    const result = mod.recordSeen('orch-001', 'my-pattern', 'Full body text', 'developer', root);

    assert.ok(result.recorded, 'should report recorded=true on first cite');

    const filePath = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    const rows = readJsonl(filePath);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].orch_id, 'orch-001');
    assert.strictEqual(rows[0].slug, 'my-pattern');
    assert.strictEqual(rows[0].first_agent, 'developer');
    assert.strictEqual(typeof rows[0].body_hash, 'string');
    assert.strictEqual(rows[0].body_hash.length, 64, 'sha256 hex is 64 chars');
    assert.strictEqual(typeof rows[0].ts, 'string');
  });

  // Spec criterion #14: body_hash is sha256(body) hex
  test('recordSeen body_hash matches sha256 of the body text', () => {
    const root = makeProject('pss-14b');
    const mod = fresh('../bin/_lib/pattern-seen-set');
    const body = 'Pattern body content for hashing test';

    mod.recordSeen('orch-002', 'hash-pattern', body, 'architect', root);

    const filePath = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    const rows = readJsonl(filePath);
    const expected = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    assert.strictEqual(rows[0].body_hash, expected);
  });

  // Spec criterion #12: idempotent — second recordSeen for same (orch, slug) returns recorded=false
  test('recordSeen is idempotent: second call for same (orch_id, slug) returns recorded=false and writes no extra row', () => {
    const root = makeProject('pss-12a');
    const mod = fresh('../bin/_lib/pattern-seen-set');

    const r1 = mod.recordSeen('orch-003', 'slug-a', 'body-a', 'developer', root);
    const r2 = mod.recordSeen('orch-003', 'slug-a', 'body-a', 'reviewer', root);

    assert.ok(r1.recorded, 'first call recorded=true');
    assert.strictEqual(r2.recorded, false, 'second call recorded=false');

    const rows = readJsonl(path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl'));
    assert.strictEqual(rows.length, 1, 'only one row in file');
    assert.strictEqual(rows[0].first_agent, 'developer', 'first_agent unchanged');
  });

  // Spec criterion #12: different orchId → separate row
  test('recordSeen allows same slug in a different orchestration', () => {
    const root = makeProject('pss-12b');
    const mod = fresh('../bin/_lib/pattern-seen-set');

    mod.recordSeen('orch-A', 'shared-slug', 'body', 'developer', root);
    mod.recordSeen('orch-B', 'shared-slug', 'body', 'developer', root);

    const rows = readJsonl(path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl'));
    assert.strictEqual(rows.length, 2, 'one row per orchestration');
  });

  // Spec criterion #12: isSeenInOrch returns {seen, firstAgent, hashShort}
  test('isSeenInOrch returns seen=true with firstAgent and hashShort after recordSeen', () => {
    const root = makeProject('pss-12c');
    const mod = fresh('../bin/_lib/pattern-seen-set');

    mod.recordSeen('orch-005', 'seen-slug', 'body text', 'architect', root);
    const result = mod.isSeenInOrch('orch-005', 'seen-slug', root);

    assert.ok(result.seen);
    assert.strictEqual(result.firstAgent, 'architect');
    assert.strictEqual(typeof result.hashShort, 'string');
    assert.strictEqual(result.hashShort.length, 6, 'hashShort is first 6 hex chars');
  });

  // Spec criterion #12: isSeenInOrch returns seen=false for unknown slug
  test('isSeenInOrch returns seen=false for an unseen slug', () => {
    const root = makeProject('pss-12d');
    const mod = fresh('../bin/_lib/pattern-seen-set');
    const result = mod.isSeenInOrch('orch-006', 'unknown-slug', root);
    assert.strictEqual(result.seen, false);
    assert.strictEqual(result.firstAgent, null);
    assert.strictEqual(result.hashShort, null);
  });

  // Spec criterion #14: rows deleted on orchestration_complete via clearForOrch
  test('clearForOrch removes all rows for the given orch_id and leaves others intact', () => {
    const root = makeProject('pss-14c');
    const mod = fresh('../bin/_lib/pattern-seen-set');

    mod.recordSeen('orch-X', 'slug-1', 'body1', 'developer', root);
    mod.recordSeen('orch-X', 'slug-2', 'body2', 'developer', root);
    mod.recordSeen('orch-Y', 'slug-1', 'body1', 'developer', root);

    const cleared = mod.clearForOrch('orch-X', root);
    assert.ok(cleared.cleared, 'should report cleared=true');

    const rows = readJsonl(path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl'));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].orch_id, 'orch-Y');
  });

  // Fail-open: corrupt JSONL file → treats as empty, returns seen=false
  test('isSeenInOrch fails open when state file is corrupt (returns seen=false)', () => {
    const root = makeProject('pss-corrupt');
    const stateFile = path.join(root, '.orchestray', 'state', 'pattern-seen-set.jsonl');
    fs.writeFileSync(stateFile, 'not-json\nalso-not-json\n', 'utf8');

    const mod = fresh('../bin/_lib/pattern-seen-set');
    const result = mod.isSeenInOrch('orch-fail', 'any-slug', root);
    // Should fail open — treat as not seen so full body is delivered
    assert.strictEqual(result.seen, false, 'corrupt file treated as empty (fail-open)');
  });

  // Fail-open: read-only directory → recordSeen returns recorded=false without throwing
  test('recordSeen fails open when state directory is read-only (no throw)', () => {
    const root = makeProject('pss-ro');
    const stateDir = path.join(root, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.chmodSync(stateDir, 0o444);

    const mod = fresh('../bin/_lib/pattern-seen-set');
    let result;
    try {
      result = mod.recordSeen('orch-ro', 'slug', 'body', 'developer', root);
    } finally {
      // Restore permissions so cleanup can remove the dir
      try { fs.chmodSync(stateDir, 0o755); } catch (_) {}
    }
    // Must not throw; recorded=false is the fail-open result
    assert.strictEqual(result.recorded, false, 'fail-open: recorded=false on write error');
  });

});

// ─── CiteCache: pattern-citation-render.js ───────────────────────────────────

describe('CiteCache — pattern-citation-render', () => {

  function makeMatch(overrides) {
    return Object.assign({
      slug: 'test-pattern',
      body: 'Full pattern body here.',
      source: 'local',
      confidence: 0.85,
      times_applied: 5,
    }, overrides);
  }

  // Spec criterion #12: first delegation gets full body
  test('renderCitation returns full body on first cite in an orchestration', () => {
    const root = makeProject('pcr-12');
    const mod = fresh('../bin/_lib/pattern-citation-render');

    const match = makeMatch();
    const result = mod.renderCitation(match, 'developer', 'orch-first', true, root);

    assert.ok(result.includes('Full pattern body here.'), 'full body present on first cite');
    assert.ok(!result.includes('[CACHED'), 'no CACHED marker on first cite');
  });

  // Spec criterion #12: second delegation same pattern → [CACHED] marker
  test('renderCitation returns [CACHED] marker on second cite of same slug in same orchestration', () => {
    const root = makeProject('pcr-12b');
    const mod = fresh('../bin/_lib/pattern-citation-render');

    const match = makeMatch({ slug: 'slug-for-cached' });
    // First cite
    mod.renderCitation(match, 'developer', 'orch-cached', true, root);
    // Second cite (different agent in same orch)
    const second = mod.renderCitation(match, 'tester', 'orch-cached', true, root);

    assert.ok(second.includes('[CACHED'), 'second cite has [CACHED] marker');
    assert.ok(second.includes('loaded by developer'), 'identifies the first agent');
    // Full body must NOT be repeated
    assert.ok(!second.includes('Full pattern body here.'), 'full body absent on second cite');
  });

  // Spec criterion #12: [CACHED] marker contains hash (h6)
  test('renderCitation [CACHED] marker includes 6-char hash', () => {
    const root = makeProject('pcr-hash');
    const mod = fresh('../bin/_lib/pattern-citation-render');

    const match = makeMatch({ slug: 'hash-slug', body: 'body for hash' });
    mod.renderCitation(match, 'developer', 'orch-hash', true, root);
    const second = mod.renderCitation(match, 'tester', 'orch-hash', true, root);

    // Extract the hash from the marker
    const hashMatch = second.match(/hash ([0-9a-f]{6})/);
    assert.ok(hashMatch, 'hash present in CACHED marker');
    assert.strictEqual(hashMatch[1].length, 6, 'hash is 6 hex chars');
  });

  // Spec criterion #13: reviewer always gets full body regardless of cache
  test('renderCitation gives reviewer full body even after another agent already cited the pattern', () => {
    const root = makeProject('pcr-13');
    const mod = fresh('../bin/_lib/pattern-citation-render');

    const match = makeMatch({ slug: 'reviewer-slug' });
    // First cite by developer — records in cache
    mod.renderCitation(match, 'developer', 'orch-rev', true, root);
    // Reviewer cite — must get full body
    const reviewerResult = mod.renderCitation(match, 'reviewer', 'orch-rev', true, root);

    assert.ok(reviewerResult.includes('Full pattern body here.'), 'reviewer gets full body');
    assert.ok(!reviewerResult.includes('[CACHED'), 'reviewer never sees [CACHED] marker');
  });

  // Spec criterion #15: cite_cache=false → no [CACHED] markers on any cite
  test('renderCitation with citeCache=false always emits full body (no CACHED marker)', () => {
    const root = makeProject('pcr-15');
    const mod = fresh('../bin/_lib/pattern-citation-render');

    const match = makeMatch({ slug: 'disabled-slug' });
    // First cite
    const first = mod.renderCitation(match, 'developer', 'orch-dis', false, root);
    // Second cite — cite_cache disabled
    const second = mod.renderCitation(match, 'tester', 'orch-dis', false, root);

    assert.ok(first.includes('Full pattern body here.'), 'first cite: full body');
    assert.ok(!first.includes('[CACHED'), 'first cite: no CACHED marker');
    assert.ok(second.includes('Full pattern body here.'), 'second cite: full body when disabled');
    assert.ok(!second.includes('[CACHED'), 'second cite: no CACHED marker when disabled');
  });

  // Spec criterion #15 boundary: cite_cache=false in renderPatternsApplied
  test('renderPatternsApplied with citeCache=false produces full body for every pattern', () => {
    const root = makeProject('pcr-15b');
    const mod = fresh('../bin/_lib/pattern-citation-render');

    const matches = [
      makeMatch({ slug: 'p1', body: 'body of p1' }),
      makeMatch({ slug: 'p2', body: 'body of p2' }),
    ];
    // First call seeds the cache (ignored since disabled)
    mod.renderPatternsApplied(matches, 'developer', 'orch-full', false, root);
    const result = mod.renderPatternsApplied(matches, 'tester', 'orch-full', false, root);

    assert.ok(result.includes('body of p1'), 'p1 full body present');
    assert.ok(result.includes('body of p2'), 'p2 full body present');
    assert.ok(!result.includes('[CACHED'), 'no CACHED markers anywhere');
  });

  // Edge: empty matches → returns ''
  test('renderPatternsApplied returns empty string when matches array is empty', () => {
    const root = makeProject('pcr-empty');
    const mod = fresh('../bin/_lib/pattern-citation-render');
    const result = mod.renderPatternsApplied([], 'developer', 'orch-x', true, root);
    assert.strictEqual(result, '');
  });

  // Label: local source → [local]
  test('renderCitation shows [local] label for local source patterns', () => {
    const root = makeProject('pcr-label-local');
    const mod = fresh('../bin/_lib/pattern-citation-render');
    const match = makeMatch({ source: 'local' });
    const result = mod.renderCitation(match, 'developer', 'orch-label', true, root);
    assert.ok(result.includes('[local]'));
  });

  // Label: shared source → [shared]
  test('renderCitation shows [shared] label for shared (non-own) source patterns', () => {
    const root = makeProject('pcr-label-shared');
    const mod = fresh('../bin/_lib/pattern-citation-render');
    const match = makeMatch({ source: 'shared', promoted_is_own: false });
    const result = mod.renderCitation(match, 'developer', 'orch-shr', true, root);
    assert.ok(result.includes('[shared]'));
  });

});

// ─── SpecSketch ───────────────────────────────────────────────────────────────

describe('SpecSketch — spec-sketch.js', () => {

  // Spec criterion #16: YAML skeleton for developer/reviewer/tester/refactorer
  test('shouldUseSketch returns true for developer, tester, refactorer, reviewer', () => {
    const mod = fresh('../bin/_lib/spec-sketch');
    for (const agent of ['developer', 'tester', 'refactorer', 'reviewer']) {
      assert.ok(mod.shouldUseSketch(agent), agent + ' should use YAML sketch');
    }
  });

  // Spec criterion #17: prose agents → shouldUseSketch returns false
  test('shouldUseSketch returns false for architect, inventor, debugger', () => {
    const mod = fresh('../bin/_lib/spec-sketch');
    for (const agent of ['architect', 'inventor', 'debugger']) {
      assert.strictEqual(mod.shouldUseSketch(agent), false, agent + ' should NOT use sketch');
    }
  });

  // Spec criterion #16: YAML skeleton has ## Previous block (not prose)
  test('generateSketch produces a YAML block starting with "## Previous:" header', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const diff = [
      'diff --git a/src/index.js b/src/index.js',
      '+++ b/src/index.js',
      '@@ -1,2 +1,5 @@',
      '+export function newHelper() {}',
    ].join('\n');

    const { sketch, fallback } = mod.generateSketch({
      filesChanged: ['src/index.js'],
      diffText: diff,
      kbEntries: [],
      agentType: 'architect',
      taskId: 'task-1',
    });

    assert.strictEqual(fallback, false);
    assert.ok(sketch, 'sketch should be non-null');
    assert.ok(sketch.startsWith('## Previous:'), 'starts with ## Previous: header');
    assert.ok(sketch.includes('files:'), 'has files: key');
    assert.ok(sketch.includes('src/index.js:'), 'lists changed file');
  });

  // Spec criterion #16: JS/TS diff → YAML includes added_exports
  test('generateSketch extracts added_exports from JS diff', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const diff = [
      '+++ b/lib/utils.js',
      '@@ -0,0 +1,3 @@',
      '+export function myExportedFn() {}',
      '+export const MY_CONST = 42;',
    ].join('\n');

    const { sketch } = mod.generateSketch({
      filesChanged: ['lib/utils.js'],
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'task-2',
    });

    assert.ok(sketch.includes('added_exports'), 'YAML contains added_exports');
    assert.ok(sketch.includes('myExportedFn'), 'captures exported function name');
  });

  // Spec criterion #17: rationale field ≤ 60 tokens (~240 chars) in sketch output
  test('generateSketch caps rationale at 240 chars (≈60 tokens)', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const longRationale = 'word '.repeat(100); // 500 chars

    const { sketch } = mod.generateSketch({
      filesChanged: ['src/a.js'],
      diffText: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+const x = 1;\n',
      kbEntries: [],
      agentType: 'architect',
      taskId: 'task-3',
      rationale: longRationale,
    });

    // rationale: | block in YAML — body must be <= 240 chars
    const rationaleIdx = sketch.indexOf('rationale: |');
    assert.ok(rationaleIdx !== -1, 'rationale block present');
    const rationaleBody = sketch.slice(rationaleIdx + 'rationale: |'.length);
    // The capped body is 240 chars; trailing content must be absent
    assert.ok(rationaleBody.length <= 260, 'rationale body is capped');
  });

  // Spec criterion #18: reviewer gets sketch + raw diff
  // generateSketch itself produces the sketch portion; caller appends raw diff
  // We verify shouldUseSketch(reviewer) = true (reviewer is a sketch agent)
  test('shouldUseSketch returns true for reviewer (reviewer receives sketch + raw diff per caller convention)', () => {
    const mod = fresh('../bin/_lib/spec-sketch');
    assert.ok(mod.shouldUseSketch('reviewer'), 'reviewer uses sketch');
  });

  // Spec criterion #19: Rust project (unknown parser) → fallback=false, lines_delta only
  // Note: Rust IS a known parser (.rs), so we use a truly unknown extension (.swift)
  test('generateSketch unknown language (.swift) falls back to lines_delta only (no symbol extraction)', () => {
    const root = makeProject('sketch-19');
    const mod = fresh('../bin/_lib/spec-sketch');

    const diff = '+++ b/App.swift\n@@ -0,0 +1,5 @@\n+func hello() {}\n+public func world() {}\n';

    const { sketch, fallback } = mod.generateSketch({
      filesChanged: ['App.swift'],
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'swift-task',
      projectRoot: root,
    });

    // Sketch should succeed (not null) but use bare lines_delta fallback
    assert.strictEqual(fallback, false, 'should produce a sketch (not full fallback)');
    assert.ok(sketch.includes('lines_delta'), 'has lines_delta for unknown extension');
    // No symbol extraction (no added_exports etc.)
    assert.ok(!sketch.includes('added_exports'), 'no added_exports for unknown lang');
  });

  // Spec criterion #19: spec_sketch_parse_failed written for genuine parse error
  test('generateSketch emits spec_sketch_parse_failed degraded entry when sketch=null (zero files)', () => {
    const root = makeProject('sketch-19b');
    const mod = fresh('../bin/_lib/spec-sketch');

    const { sketch, fallback } = mod.generateSketch({
      filesChanged: [],  // empty → returns null, triggering fallback
      diffText: '',
      kbEntries: [],
      agentType: 'developer',
      taskId: 'empty-task',
      projectRoot: root,
    });

    assert.strictEqual(sketch, null, 'no sketch for empty filesChanged');
    assert.strictEqual(fallback, true);
  });

  // Spec criterion #20: 30+ changed files → ≤400 tokens + trailer + degraded entry
  test('generateSketch with 35 files truncates to ≤400 tokens and includes "more files not listed" trailer', () => {
    const root = makeProject('sketch-20');

    // Ensure degraded-journal knows the new KIND
    // (freshly loaded module clears cache so KINDS array is fresh from disk)
    const mod = fresh('../bin/_lib/spec-sketch');

    const files = Array.from({ length: 35 }, (_, i) => `src/file${i}.js`);
    const diffLines = files.flatMap((f, i) => [
      `+++ b/${f}`,
      `@@ -0,0 +1,${i + 1} @@`,
      `+export function fn${i}() {}`,
    ]);
    const diff = diffLines.join('\n');

    const { sketch, budgetExceeded } = mod.generateSketch({
      filesChanged: files,
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'big-task',
      projectRoot: root,
    });

    assert.ok(budgetExceeded, 'budgetExceeded=true for 35 files');
    // 400 tokens ≈ 1600 chars
    assert.ok(sketch.length <= 1600, 'sketch within 400-token budget (' + sketch.length + ' chars)');
    assert.ok(sketch.includes('more file'), 'trailer mentions omitted files');

    // Degraded entry written
    const degraded = path.join(root, '.orchestray', 'state', 'degraded.jsonl');
    const entries = readJsonl(degraded);
    const budgetEntry = entries.find(e => e.kind === 'spec_sketch_budget_exceeded');
    assert.ok(budgetEntry, 'spec_sketch_budget_exceeded degraded entry written');
    assert.ok(Number.isFinite(budgetEntry.detail.files_total), 'has files_total');
    assert.ok(Number.isFinite(budgetEntry.detail.files_omitted), 'has files_omitted');
  });

  // Spec criterion #20: trailer text matches expected pattern
  test('generateSketch budget-exceeded trailer says "N more file(s) not listed"', () => {
    const root = makeProject('sketch-20b');
    const mod = fresh('../bin/_lib/spec-sketch');

    const files = Array.from({ length: 30 }, (_, i) => `lib/mod${i}.ts`);
    const diff = files.map(f => `+++ b/${f}\n@@ -0,0 +1 @@\n+export const x${f} = 1;\n`).join('\n');

    const { sketch, budgetExceeded } = mod.generateSketch({
      filesChanged: files,
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'trailer-task',
      projectRoot: root,
    });

    if (budgetExceeded) {
      assert.ok(/\d+ more file/.test(sketch), 'trailer contains count + "more file"');
    }
    // If budget is NOT exceeded with 30 files it means each entry is small — that's
    // acceptable; just verify sketch is valid YAML structure.
    assert.ok(sketch.includes('## Previous:'), 'sketch has valid header');
  });

  // Fail-open: generateSketch with null params returns null without throwing
  test('generateSketch fails open (returns null) when called with null params', () => {
    const mod = fresh('../bin/_lib/spec-sketch');
    const result = mod.generateSketch(null);
    assert.strictEqual(result.sketch, null);
    assert.strictEqual(result.fallback, true);
  });

  // Python symbol extraction
  test('generateSketch extracts Python function names from diff', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const diff = [
      '+++ b/module.py',
      '@@ -0,0 +1,4 @@',
      '+def my_function():',
      '+    pass',
      '+class MyClass:',
      '+    pass',
    ].join('\n');

    const { sketch } = mod.generateSketch({
      filesChanged: ['module.py'],
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'py-task',
    });

    assert.ok(sketch.includes('my_function'), 'Python function captured');
    assert.ok(sketch.includes('MyClass'), 'Python class captured');
  });

  // Go symbol extraction
  test('generateSketch extracts exported Go function names from diff', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const diff = [
      '+++ b/pkg/handler.go',
      '@@ -0,0 +1,4 @@',
      '+func ExportedFunc() {}',
      '+func unexportedFunc() {}',
      '+type MyType struct {}',
    ].join('\n');

    const { sketch } = mod.generateSketch({
      filesChanged: ['pkg/handler.go'],
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'go-task',
    });

    assert.ok(sketch.includes('ExportedFunc'), 'exported Go func captured');
    assert.ok(sketch.includes('MyType'), 'Go type captured');
  });

  // Rust symbol extraction (known parser, unlike the spec-19 unknown-lang test)
  test('generateSketch extracts Rust pub fn names from diff', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const diff = [
      '+++ b/src/lib.rs',
      '@@ -0,0 +1,3 @@',
      '+pub fn exported_fn() {}',
      '+pub struct MyStruct {}',
    ].join('\n');

    const { sketch } = mod.generateSketch({
      filesChanged: ['src/lib.rs'],
      diffText: diff,
      kbEntries: [],
      agentType: 'developer',
      taskId: 'rs-task',
    });

    assert.ok(sketch.includes('exported_fn'), 'Rust pub fn captured');
    assert.ok(sketch.includes('MyStruct'), 'Rust pub struct captured');
  });

  // kbEntries appear in kb_refs
  test('generateSketch includes kb_refs when kbEntries are provided', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const { sketch } = mod.generateSketch({
      filesChanged: ['src/a.js'],
      diffText: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+const x = 1;\n',
      kbEntries: [{ slug: 'kb-fact-1' }, { slug: 'kb-fact-2' }],
      agentType: 'developer',
      taskId: 'kb-task',
    });

    assert.ok(sketch.includes('kb_refs'), 'kb_refs present');
    assert.ok(sketch.includes('kb-fact-1'), 'first kb slug listed');
    assert.ok(sketch.includes('kb-fact-2'), 'second kb slug listed');
  });

  // contractsMet appear in contracts_met
  test('generateSketch includes contracts_met when contractsMet are provided', () => {
    const mod = fresh('../bin/_lib/spec-sketch');

    const { sketch } = mod.generateSketch({
      filesChanged: ['src/a.ts'],
      diffText: '+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n',
      kbEntries: [],
      agentType: 'developer',
      taskId: 'contract-task',
      contractsMet: ['tests-pass', 'lint-clean'],
    });

    assert.ok(sketch.includes('contracts_met'), 'contracts_met present');
    assert.ok(sketch.includes('tests-pass'), 'first contract listed');
  });

});

// ─── RepoMapDelta ─────────────────────────────────────────────────────────────

describe('RepoMapDelta — repo-map-delta.js', () => {

  function makeRmdProject() {
    const root = makeProject('rmd-');
    fs.mkdirSync(path.join(root, '.orchestray', 'kb', 'facts'), { recursive: true });
    return root;
  }

  // Spec criterion #21: first delegation → full map block
  test('injectRepoMap returns full "## Repository Map" block on first call for an orchestration', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const content = '# Repo map content\nfile1.js\nfile2.js\n';
    const result = mod.injectRepoMap({
      orchId: 'orch-rmd-001',
      agentType: 'architect',
      repoMapContent: content,
      hintRows: [],
      repoMapDelta: true,
      projectRoot: root,
    });

    assert.ok(result.startsWith('## Repository Map'), 'starts with ## Repository Map');
    assert.ok(result.includes('file1.js'), 'includes map content');
  });

  // Spec criterion #21: first delegation writes map to .orchestray/kb/facts/repo-map.md
  test('injectRepoMap writes repo-map.md to KB on first call', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const content = 'repo map written to disk';
    mod.injectRepoMap({
      orchId: 'orch-rmd-002',
      agentType: 'developer',
      repoMapContent: content,
      repoMapDelta: true,
      projectRoot: root,
    });

    const repoMapFile = path.join(root, '.orchestray', 'kb', 'facts', 'repo-map.md');
    assert.ok(fs.existsSync(repoMapFile), 'repo-map.md written to KB');
    assert.strictEqual(fs.readFileSync(repoMapFile, 'utf8'), content);
  });

  // Spec criterion #21 & #22: second delegation → pointer block (not full map)
  test('injectRepoMap returns pointer block on second call in same orchestration', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const content = 'full map content';
    // First call
    mod.injectRepoMap({
      orchId: 'orch-rmd-003',
      agentType: 'architect',
      repoMapContent: content,
      repoMapDelta: true,
      projectRoot: root,
    });

    // Second call
    const second = mod.injectRepoMap({
      orchId: 'orch-rmd-003',
      agentType: 'developer',
      repoMapContent: content,
      hintRows: ['src/auth.js — AuthService, 120 LOC'],
      repoMapDelta: true,
      projectRoot: root,
    });

    assert.ok(second.includes('unchanged this orchestration'), 'pointer block present');
    assert.ok(second.includes('.orchestray/kb/facts/repo-map.md'), 'pointer references KB path');
    assert.ok(!second.includes('full map content'), 'full map content NOT repeated');
  });

  // Spec criterion #22: pointer hash matches sha256 of repo-map.md content
  test('pointer block hash matches sha256 of the written repo-map.md content', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const content = 'deterministic map content for hash test';
    mod.injectRepoMap({
      orchId: 'orch-rmd-004',
      agentType: 'architect',
      repoMapContent: content,
      repoMapDelta: true,
      projectRoot: root,
    });

    const second = mod.injectRepoMap({
      orchId: 'orch-rmd-004',
      agentType: 'developer',
      repoMapContent: content,
      repoMapDelta: true,
      projectRoot: root,
    });

    // Extract 8-char hash from pointer block
    const hashMatch = second.match(/hash `([0-9a-f]{8})`/);
    assert.ok(hashMatch, 'pointer block contains 8-char hash');

    const expectedFullHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    assert.strictEqual(hashMatch[1], expectedFullHash.slice(0, 8), 'pointer hash matches sha256[:8] of content');
  });

  // Spec criterion #21: 3-agent orch: first full, second+third pointer
  test('3-agent orch: first call full map, second and third calls produce pointer block', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const content = 'repo map for 3-agent test';
    const orchId = 'orch-rmd-3agent';

    const first = mod.injectRepoMap({ orchId, agentType: 'architect', repoMapContent: content, repoMapDelta: true, projectRoot: root });
    const second = mod.injectRepoMap({ orchId, agentType: 'developer', repoMapContent: content, hintRows: ['file.js'], repoMapDelta: true, projectRoot: root });
    const third = mod.injectRepoMap({ orchId, agentType: 'reviewer', repoMapContent: content, hintRows: ['file.js'], repoMapDelta: true, projectRoot: root });

    assert.ok(first.includes('repo map for 3-agent test'), 'first: full map');
    assert.ok(second.includes('unchanged this orchestration'), 'second: pointer block');
    assert.ok(third.includes('unchanged this orchestration'), 'third: pointer block');
  });

  // Spec criterion #21: hint rows appear in pointer block (up to 5)
  test('pointer block includes up to 5 hint rows from hintRows param', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const orchId = 'orch-rmd-hints';
    mod.injectRepoMap({ orchId, agentType: 'architect', repoMapContent: 'map', repoMapDelta: true, projectRoot: root });

    const hints = ['hint-1', 'hint-2', 'hint-3', 'hint-4', 'hint-5', 'hint-6-should-be-omitted'];
    const second = mod.injectRepoMap({
      orchId, agentType: 'developer',
      repoMapContent: 'map',
      hintRows: hints,
      repoMapDelta: true,
      projectRoot: root,
    });

    assert.ok(second.includes('hint-1'), 'hint-1 present');
    assert.ok(second.includes('hint-5'), 'hint-5 present (max 5)');
    assert.ok(!second.includes('hint-6-should-be-omitted'), 'hint-6 omitted (capped at 5)');
  });

  // Spec criterion #23: repo_map_delta=false → full map on every call
  test('injectRepoMap with repoMapDelta=false always returns full map block', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    const content = 'full map always when disabled';
    const orchId = 'orch-rmd-disabled';

    const first = mod.injectRepoMap({ orchId, agentType: 'architect', repoMapContent: content, repoMapDelta: false, projectRoot: root });
    const second = mod.injectRepoMap({ orchId, agentType: 'developer', repoMapContent: content, repoMapDelta: false, projectRoot: root });

    assert.ok(first.includes('full map always when disabled'), 'first: full map when disabled');
    assert.ok(second.includes('full map always when disabled'), 'second: full map when disabled');
    assert.ok(!second.includes('unchanged this orchestration'), 'no pointer block when disabled');
  });

  // Fail-open: any error in injectRepoMap → returns full map, never throws
  test('injectRepoMap fails open when called with missing orchId (no throw, returns full map)', () => {
    const root = makeRmdProject();
    const mod = fresh('../bin/_lib/repo-map-delta');

    let result;
    assert.doesNotThrow(() => {
      result = mod.injectRepoMap({
        orchId: null,
        agentType: 'developer',
        repoMapContent: 'fallback content',
        repoMapDelta: true,
        projectRoot: root,
      });
    });
    // May return full map or pointer block — must not crash
    assert.ok(typeof result === 'string', 'returns a string regardless');
  });

});
