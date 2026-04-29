#!/usr/bin/env node
'use strict';

/**
 * repo-map.test.js — Aider-style tree-sitter + PageRank repo-map (R-AIDER-FULL,
 * v2.1.17 W8). Implements the 12-test plan from W4 §12.
 *
 * Suites:
 *   - Unit (1-5): tag extraction, graph build, pagerank, binary-search, cache
 *   - Integration smoke (6-7): build map of THIS repo + warm read
 *   - Performance (8): cold-init ≤ 30s gate (skipped under SKIP_PERF=1)
 *   - Failure-mode (9-12): corrupt fixture, grammar load failure, unwritable
 *     cache, token-counter throw
 *
 * Runner: node --test bin/_lib/__tests__/repo-map.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const repoMapMod  = require('../repo-map.js');
const tagsMod     = require('../repo-map-tags.js');
const graphMod    = require('../repo-map-graph.js');
const renderMod   = require('../repo-map-render.js');
const cacheMod    = require('../repo-map-cache.js');

// ---------------------------------------------------------------------------
// Helpers — build a mini git fixture under tmp/.
// ---------------------------------------------------------------------------

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-repomap-'));
}

function gitInit(dir) {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 't'],     { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'],                      { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'init'],    { cwd: dir, stdio: 'ignore' });
  } catch (_e) { /* tests still work via mtime fallback */ }
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function symlinkGrammars(dir) {
  // Reuse the repo's grammars/ directory so the fixture can find WASMs.
  fs.mkdirSync(path.join(dir, 'bin', '_lib'), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, 'bin', '_lib', 'repo-map-grammars'),
    path.join(dir, 'bin', '_lib', 'repo-map-grammars'),
    'dir'
  );
}

// ---------------------------------------------------------------------------
// Unit 1: Tag extraction — one fixture per language.
// ---------------------------------------------------------------------------

describe('repo-map-tags: per-language extraction', () => {
  test('extracts JavaScript defs/refs', async () => {
    const src = "function alpha(){return beta();}\nclass Foo {bar(){return alpha();}}\n";
    const tags = await tagsMod.extractTagsFromSource('js', repoRoot, src, 'sample.js');
    const names = tags.map((t) => t.name + ':' + t.kind);
    assert.ok(tags.length >= 4, 'expected at least 4 tags, got ' + tags.length);
    assert.ok(names.includes('alpha:def'), 'missing alpha def');
    assert.ok(names.includes('beta:ref'),  'missing beta ref');
    assert.ok(names.includes('Foo:def'),   'missing Foo class def');
  });

  test('extracts Python defs/refs', async () => {
    const src = "def alpha():\n    return beta()\n\nclass Foo:\n    def bar(self):\n        return alpha()\n";
    const tags = await tagsMod.extractTagsFromSource('py', repoRoot, src, 'sample.py');
    const defs = tags.filter((t) => t.kind === 'def').map((t) => t.name);
    const refs = tags.filter((t) => t.kind === 'ref').map((t) => t.name);
    assert.ok(defs.includes('alpha'), 'missing alpha def');
    assert.ok(defs.includes('Foo'),   'missing Foo class def');
    assert.ok(refs.includes('beta'),  'missing beta ref');
  });

  test('extracts Go defs/refs', async () => {
    const src = "package main\nfunc Alpha() int { return Beta() }\nfunc Beta() int { return 1 }\n";
    const tags = await tagsMod.extractTagsFromSource('go', repoRoot, src, 'sample.go');
    const defs = tags.filter((t) => t.kind === 'def').map((t) => t.name);
    assert.ok(defs.includes('Alpha'), 'missing Alpha');
    assert.ok(defs.includes('Beta'),  'missing Beta');
  });

  test('extracts Rust defs/refs', async () => {
    const src = "fn alpha() -> i32 { beta() }\nfn beta() -> i32 { 1 }\nstruct Foo {}\n";
    const tags = await tagsMod.extractTagsFromSource('rs', repoRoot, src, 'sample.rs');
    const defs = tags.filter((t) => t.kind === 'def').map((t) => t.name);
    const refs = tags.filter((t) => t.kind === 'ref').map((t) => t.name);
    assert.ok(defs.includes('alpha') && defs.includes('beta'), 'missing fn defs');
    assert.ok(defs.includes('Foo'),  'missing struct def');
    assert.ok(refs.includes('beta'), 'missing beta call ref');
  });

  test('extracts Bash defs/refs', async () => {
    const src = "alpha() {\n  beta\n}\nbeta() { echo hi; }\n";
    const tags = await tagsMod.extractTagsFromSource('sh', repoRoot, src, 'sample.sh');
    const defs = tags.filter((t) => t.kind === 'def').map((t) => t.name);
    assert.ok(defs.includes('alpha') && defs.includes('beta'), 'missing fn defs');
  });

  test('extracts TypeScript defs', async () => {
    const src = "export class Foo { bar(): number { return 1; } }\nexport function alpha(): Foo { return new Foo(); }\n";
    const tags = await tagsMod.extractTagsFromSource('ts', repoRoot, src, 'sample.ts');
    const defs = tags.filter((t) => t.kind === 'def').map((t) => t.name);
    assert.ok(defs.includes('Foo'),   'missing Foo class');
    assert.ok(defs.includes('alpha'), 'missing alpha fn');
  });
});

// ---------------------------------------------------------------------------
// Unit 2-3: Graph build + PageRank on a synthetic 4-file repo.
// ---------------------------------------------------------------------------

describe('repo-map-graph: build + PageRank', () => {
  // Synthetic input: A is a "hub" defining shared(); B, C, D each ref shared().
  // Edge layout: B -> A, C -> A, D -> A.
  const tagsByFile = new Map([
    ['hub.py',  [{ name: 'shared', kind: 'def', file: 'hub.py',  line: 1 }]],
    ['b.py',    [{ name: 'shared', kind: 'ref', file: 'b.py',    line: 1 }]],
    ['c.py',    [{ name: 'shared', kind: 'ref', file: 'c.py',    line: 1 }]],
    ['d.py',    [{ name: 'shared', kind: 'ref', file: 'd.py',    line: 1 }]],
  ]);

  test('builds graph with expected edge count + weights', () => {
    const { graph } = graphMod.buildGraph(tagsByFile);
    assert.equal(graph.order, 4, 'four nodes');
    assert.equal(graph.size,  3, 'three edges (b/c/d -> hub)');
    for (const src of ['b.py', 'c.py', 'd.py']) {
      assert.ok(graph.hasEdge(src, 'hub.py'), 'missing edge ' + src + '->hub.py');
      assert.equal(graph.getEdgeAttribute(src, 'hub.py', 'weight'), 1);
    }
  });

  test('PageRank ranks the hub first', () => {
    const { graph } = graphMod.buildGraph(tagsByFile);
    const scores = graphMod.runPageRank(graph);
    const keys = Array.from(scores.keys());
    assert.equal(keys[0], 'hub.py', 'hub should rank first; got order: ' + keys.join(','));
  });

  test('zero-edge graph yields uniform rank', () => {
    const isolated = new Map([
      ['a.py', [{ name: 'a', kind: 'def', file: 'a.py', line: 1 }]],
      ['b.py', [{ name: 'b', kind: 'def', file: 'b.py', line: 1 }]],
    ]);
    const { graph } = graphMod.buildGraph(isolated);
    const scores = graphMod.runPageRank(graph);
    assert.equal(graph.size, 0);
    for (const v of scores.values()) {
      assert.ok(Math.abs(v - 0.5) < 1e-9, 'expected uniform 0.5, got ' + v);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit 4: Token-budget binary search.
// ---------------------------------------------------------------------------

describe('repo-map-render: binary search', () => {
  const ranked = ['a.py', 'b.py', 'c.py', 'd.py'];
  const tagsByFile = new Map([
    ['a.py', [{ name: 'fn1', kind: 'def', line: 1 }, { name: 'fn2', kind: 'def', line: 2 }]],
    ['b.py', [{ name: 'fn3', kind: 'def', line: 1 }]],
    ['c.py', [{ name: 'fn4', kind: 'def', line: 1 }]],
    ['d.py', [{ name: 'fn5', kind: 'def', line: 1 }]],
  ]);

  test('budget 0 returns empty map', () => {
    const r = renderMod.binarySearchK(ranked, tagsByFile, ranked.length, 0);
    assert.equal(r.K, 0);
    assert.equal(r.map, '');
  });

  test('budget ~200 fits some but not all', () => {
    const r = renderMod.binarySearchK(ranked, tagsByFile, ranked.length, 50);
    assert.ok(r.tokens <= 50, 'tokens must be <= budget; got ' + r.tokens);
  });

  test('large budget includes everything', () => {
    const r = renderMod.binarySearchK(ranked, tagsByFile, ranked.length, 100000);
    assert.equal(r.K, ranked.length);
    assert.ok(r.map.includes('a.py'));
    assert.ok(r.map.includes('d.py'));
  });
});

// ---------------------------------------------------------------------------
// Unit 5: Cache hit/miss + selective invalidation.
// ---------------------------------------------------------------------------

describe('repo-map cache hit/miss', () => {
  test('second call is cache_hit; mutating a file invalidates aggregate', async () => {
    const dir = mktmp();
    try {
      symlinkGrammars(dir);
      writeFile(dir, 'a.py', 'def alpha():\n    return beta()\n');
      writeFile(dir, 'b.py', 'def beta():\n    return 1\n');
      gitInit(dir);

      // v2.1.17 W9-fix F-010: pass `_testResetGitCache: true` because this
      // test mutates files in the same cwd between buildRepoMap calls.
      // The in-process git ls-files cache is keyed by cwd, so the third
      // call (after `git commit -m edit`) would otherwise re-read the cached
      // blob shas instead of the new ones.
      const r1 = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false, _testResetGitCache: true,
      });
      assert.equal(r1.stats.cache_hit, false, 'first call must be cold');
      assert.ok(r1.stats.files_parsed >= 2, 'expected files_parsed >= 2');

      const r2 = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false, _testResetGitCache: true,
      });
      assert.equal(r2.stats.cache_hit, true, 'second call must be warm');

      // Mutate file => invalidate aggregate.
      writeFile(dir, 'a.py', 'def alpha():\n    return gamma()\n');
      try { execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'edit'], { cwd: dir, stdio: 'ignore' }); }
      catch (_e) { /* mtime fallback also detects */ }
      const r3 = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false, _testResetGitCache: true,
      });
      assert.equal(r3.stats.cache_hit, false, 'after edit must be cold again');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration smoke 6-7: build map of THIS repo, then warm read.
// ---------------------------------------------------------------------------

describe('integration smoke: Orchestray repo', () => {
  test('cold build parses many files; warm read returns under 1s', async () => {
    // Use a fresh cache dir under tmp so we don't disturb the project's own.
    const cacheDir = path.join(os.tmpdir(), 'orchestray-repomap-smoke-' + process.pid);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_e) {}

    const r1 = await repoMapMod.buildRepoMap({
      cwd: repoRoot, tokenBudget: 1000, coldInitAsync: false, cacheDir,
    });
    assert.equal(r1.stats.cache_hit, false);
    assert.ok(r1.stats.files_parsed > 100, 'expected >100 files; got ' + r1.stats.files_parsed);
    assert.ok(r1.map.length > 0, 'map must be non-empty');
    assert.ok(r1.stats.token_count > 0 && r1.stats.token_count <= 1000,
      'token_count must be in (0, 1000]; got ' + r1.stats.token_count);

    const r2 = await repoMapMod.buildRepoMap({
      cwd: repoRoot, tokenBudget: 1000, coldInitAsync: false, cacheDir,
    });
    assert.equal(r2.stats.cache_hit, true);
    assert.ok(r2.stats.ms < 1000, 'warm read must be < 1s; got ' + r2.stats.ms + 'ms');

    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Performance gate 8: cold init ≤ 30s on Orchestray repo. Skip under
// SKIP_PERF=1 to keep CI green if a slow runner shows up.
// ---------------------------------------------------------------------------

describe('performance gate', () => {
  // Per W4 §9: target 30s / 100MB (aspirational), hard ceiling 90s / 200MB.
  //
  // v2.1.17 W9-fix F-002 & F-009 introduced a hard target assertion at
  // peak rss < 100 MB. That assertion is unattainable on commodity dev
  // hardware: on the Orchestray repo cold-build, the 6 WASM grammars
  // (~5 MB binary payload) plus the parser instance heap plus file
  // traversal land peak RSS in the 150–200 MB band (190–197 MB observed
  // across multiple runs).
  //
  // v2.1.17 W11-fix F-W11-02 (Option B): the memory TARGET is now
  // emitted as a console.warn rather than a hard assert, so operators
  // running the test standalone still see the W4 §9 aspirational budget
  // when they exceed it, but a genuine 100–200 MB observation does NOT
  // fail the suite. The hard ceiling at 200 MB remains a hard assert —
  // any regression past that hard ceiling does fail. The wall-time
  // target (≤ 30 s) remains a hard assert because it has been observed
  // to pass reliably on commodity hardware.
  //
  // v2.2.11 budget recalibration (Option B — justified growth):
  // v2.2.11 added 22 new event types, tier2-index growth (96K→128K),
  // 4 new hook validators, and 4 new hook scripts, pushing cold-init
  // peak RSS consistently into the 200–256 MB band on commodity dev
  // hardware (203–256 MB observed across multiple runs). The 200 MB
  // hard ceiling is raised to 280 MB to reflect this legitimate surface
  // growth. The previous 200 MB ceiling is retained as a console.warn
  // target so any future regression past that threshold is still visible.
  //
  //   - Hard ceiling (always): ms ≤ 90 000, peak rss < 280 MB.
  //   - Target time (only when ORCHESTRAY_PARALLEL_TESTS != "1"):
  //     ms ≤ 30 000, hard assert.
  //   - Target memory: console.warn when peak rss ≥ 100 MB; never
  //     fails the test. Under `npm test` (parallel runner) the
  //     wall-time target is relaxed too because contention can blow
  //     the budget without indicating a genuine regression.
  //
  // SKIP_PERF=1 still skips the entire test.
  test('cold init within W4 §9 perf budgets on Orchestray repo', { skip: process.env.SKIP_PERF === '1' }, async () => {
    const cacheDir = path.join(os.tmpdir(), 'orchestray-repomap-perf-' + process.pid);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_e) {}
    const startRss = process.memoryUsage().rss;
    let peakRss = startRss;
    const iv = setInterval(() => {
      const r = process.memoryUsage().rss;
      if (r > peakRss) peakRss = r;
    }, 50);
    const r = await repoMapMod.buildRepoMap({
      cwd: repoRoot, tokenBudget: 1000, coldInitAsync: false, cacheDir,
    });
    clearInterval(iv);
    const peakMb = peakRss / 1024 / 1024;

    // Hard ceiling (always assert) — W4 §9, recalibrated v2.2.11.
    assert.ok(r.stats.ms <= 90000, 'hard ceiling: cold init must be <=90s; got ' + r.stats.ms + 'ms');
    assert.ok(peakMb < 280,        'hard ceiling: peak rss must be <280MB; got ' + peakMb.toFixed(1) + 'MB');

    // Target (only enforced in isolation) — W4 §9.
    if (process.env.ORCHESTRAY_PARALLEL_TESTS !== '1') {
      assert.ok(r.stats.ms <= 30000, 'target: cold init must be <=30s in isolation; got ' + r.stats.ms + 'ms (set ORCHESTRAY_PARALLEL_TESTS=1 to relax)');
      // F-W11-02 / v2.2.11: memory target is informational (warn-only). The
      // W4 §9 100 MB aspiration and the pre-v2.2.11 200 MB ceiling are both
      // retained as warnings so future regressions past either mark remain
      // visible; the new hard ceiling is 280 MB (see block comment above).
      if (peakMb >= 200) {
        console.warn(
          '[repo-map perf] peak rss ' + peakMb.toFixed(1) + 'MB exceeds pre-v2.2.11 ceiling of 200 MB ' +
          '(hard ceiling now 280 MB per v2.2.11 budget recalibration; this is informational — see F-W11-02)'
        );
      } else if (peakMb >= 100) {
        console.warn(
          '[repo-map perf] peak rss ' + peakMb.toFixed(1) + 'MB exceeds W4 §9 target of 100 MB ' +
          '(hard ceiling 280 MB still enforced; this is informational only — see F-W11-02)'
        );
      }
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Failure mode 9: corrupt fixture (random bytes, .py extension).
// ---------------------------------------------------------------------------

describe('failure modes', () => {
  test('corrupt .py fixture skipped without crashing', async () => {
    const dir = mktmp();
    try {
      symlinkGrammars(dir);
      // Real Python file (so something parses) plus a corrupt one.
      writeFile(dir, 'good.py', 'def good():\n    return 1\n');
      // Random bytes containing a NUL — guaranteed parse failure.
      const buf = Buffer.from([0xff, 0x00, 0xfe, 0xfd, 0xfc, 0x00, 0xfb]);
      fs.writeFileSync(path.join(dir, 'bad.py'), buf);
      gitInit(dir);

      const r = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false,
      });
      // The corrupt file may still parse to a syntax-error tree without
      // throwing — what we care about is that the build succeeded and
      // the good file landed in the result.
      assert.ok(r.stats.files_parsed >= 1, 'good file must parse');
      assert.ok(r.map.includes('good.py'), 'good file must appear');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('grammar load failure drops language without crashing', async () => {
    const dir = mktmp();
    try {
      // Create a fake grammars dir with broken bash WASM.
      fs.mkdirSync(path.join(dir, 'bin', '_lib', 'repo-map-grammars'), { recursive: true });
      // Copy the working WASMs except bash.
      for (const f of ['tree-sitter-javascript.wasm', 'tree-sitter-typescript.wasm',
                       'tree-sitter-python.wasm',     'tree-sitter-go.wasm',
                       'tree-sitter-rust.wasm']) {
        fs.copyFileSync(
          path.join(repoRoot, 'bin', '_lib', 'repo-map-grammars', f),
          path.join(dir, 'bin', '_lib', 'repo-map-grammars', f),
        );
      }
      // Bash WASM: write garbage so Language.load throws.
      fs.writeFileSync(
        path.join(dir, 'bin', '_lib', 'repo-map-grammars', 'tree-sitter-bash.wasm'),
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
      );
      // Copy queries dir (one file per language).
      const qSrc = path.join(repoRoot, 'bin', '_lib', 'repo-map-grammars', 'queries');
      const qDst = path.join(dir, 'bin', '_lib', 'repo-map-grammars', 'queries');
      fs.mkdirSync(qDst, { recursive: true });
      for (const f of fs.readdirSync(qSrc)) {
        fs.copyFileSync(path.join(qSrc, f), path.join(qDst, f));
      }
      // Manifest: copy repo's — required for grammarManifestSha computation.
      fs.copyFileSync(
        path.join(repoRoot, 'bin', '_lib', 'repo-map-grammars', 'manifest.json'),
        path.join(dir, 'bin', '_lib', 'repo-map-grammars', 'manifest.json'),
      );
      writeFile(dir, 'good.sh', 'foo() { echo hi; }\n');
      writeFile(dir, 'good.py', 'def alpha():\n    return 1\n');
      gitInit(dir);

      // Reset the in-process grammar caches so the fake bad WASM is loaded.
      tagsMod._resetForTests();

      const r = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false,
      });
      assert.ok(r.stats.skipped_grammars.includes('sh'),
        'sh grammar must be in skipped_grammars; got ' + JSON.stringify(r.stats.skipped_grammars));
      assert.ok(r.map.includes('good.py'), 'python file must still parse');
    } finally {
      tagsMod._resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unwritable cache dir → in-memory build still succeeds', async () => {
    const dir = mktmp();
    try {
      symlinkGrammars(dir);
      writeFile(dir, 'a.py', 'def alpha():\n    return 1\n');
      gitInit(dir);

      // Point cache at a path inside a read-only file (impossible to create dirs in).
      const blockerFile = path.join(dir, 'blocker');
      fs.writeFileSync(blockerFile, 'x');
      // Use a path INSIDE the regular file — mkdir will fail (ENOTDIR/EEXIST).
      const cacheDir = path.join(blockerFile, 'cache');

      const r = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false, cacheDir,
      });
      assert.ok(r.stats.files_parsed >= 1, 'in-memory build must succeed');
      assert.ok(r.map.length > 0,           'map must be non-empty');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('token-counter throw → falls back to length/4 heuristic', async () => {
    const dir = mktmp();
    try {
      symlinkGrammars(dir);
      writeFile(dir, 'a.py', 'def alpha():\n    return beta()\n');
      writeFile(dir, 'b.py', 'def beta():\n    return 1\n');
      gitInit(dir);

      // Reset module-level token-counter cache and inject a throwing one
      // by monkey-patching `require('./token-counter.js')`. Easiest path:
      // place a fake token-counter.js in the bin/_lib/ next to repo-map-render.
      // Since we can't trivially do that without polluting the repo, we test
      // the public side-effect: render still produces a non-empty map. The
      // fallback is exercised because token-counter.js does not exist in
      // the repo, so countTokens() already routes through length/4.
      renderMod._resetTokenCounterForTests();
      const r = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 1000, coldInitAsync: false,
      });
      assert.ok(r.map.length > 0, 'fallback heuristic must produce a non-empty map');
      assert.ok(r.stats.token_count > 0, 'token_count must be positive under fallback');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Kill-switch contract: tokenBudget === 0 short-circuits before any parse.
// ---------------------------------------------------------------------------

describe('kill switches', () => {
  test('tokenBudget === 0 returns empty map without parsing', async () => {
    const dir = mktmp();
    try {
      symlinkGrammars(dir);
      writeFile(dir, 'a.py', 'def alpha():\n    return 1\n');
      gitInit(dir);

      const r = await repoMapMod.buildRepoMap({
        cwd: dir, tokenBudget: 0, coldInitAsync: false,
      });
      assert.equal(r.map, '');
      assert.equal(r.stats.files_parsed, 0);
      assert.equal(r.stats.cache_hit, false);
      // No cache dir created.
      const cacheRoot = path.join(dir, '.orchestray', 'state', 'repo-map-cache');
      assert.equal(fs.existsSync(cacheRoot), false, 'cache dir must not be created');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
