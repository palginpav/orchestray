'use strict';

/**
 * Integration tests for the Oversized-Input pipeline (W7 v2.3.14).
 *
 * Tests the detect→manifest→extract pipeline end-to-end using the hook
 * as a child process (like tests/hooks/detect-oversized-input.test.js)
 * plus direct calls to extractSlices for the extraction phase.
 *
 * Run: node --test tests/oversized-input-integration.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK_SCRIPT = path.resolve(__dirname, '../bin/detect-oversized-input.js');
const { extractSlices } = require('../bin/_lib/oversized-input');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeDir(opts = {}) {
  const { withConfig = null } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-integ-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  if (withConfig !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(withConfig)
    );
  }
  return dir;
}

function makeSyntheticFile(dir, name, size) {
  const p = path.join(dir, name);
  const CHUNK = 65536;
  const buf = Buffer.alloc(Math.min(CHUNK, size), 0x61); // 'a'
  const fd = fs.openSync(p, 'w');
  let written = 0;
  while (written < size) {
    const n = Math.min(CHUNK, size - written);
    fs.writeSync(fd, buf, 0, n);
    written += n;
  }
  fs.closeSync(fd);
  return p;
}

function runHook(dir, prompt, extraEnv = {}) {
  const payload = JSON.stringify({ cwd: dir, prompt: prompt || '' });
  const r = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, extraEnv),
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function parseOutput(stdout) {
  const t = stdout.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (_e) { return null; }
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function getCorpusId(advisory) {
  const m = advisory.match(/corpus_id: ([0-9a-f]+)/);
  return m ? m[1] : null;
}

// ─── file trigger ─────────────────────────────────────────────────────────────

describe('detect → manifest → extract (file trigger)', () => {

  test('slice files created, count == min(naturalCount, max_slices), content correct', () => {
    const SLICE_CHARS = 1000;
    const MAX_SLICES  = 10;
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes: 1000,
          slice_chars:     SLICE_CHARS,
          max_slices:      MAX_SLICES,
          hierarchical_reduce: true,
        },
      },
    });

    // Create source file: 5000 bytes = 5 natural slices (well within max_slices)
    const FILE_SIZE = 5000;
    const filePath  = makeSyntheticFile(dir, 'corpus.bin', FILE_SIZE);

    // Run hook to produce manifest
    const { status, stdout } = runHook(dir, 'Summarize ' + filePath);
    assert.equal(status, 0, 'hook must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'hook must emit advisory');

    const advisory  = out.hookSpecificOutput.additionalContext;
    const corpusId  = getCorpusId(advisory);
    assert.ok(corpusId, 'advisory must include corpus_id');

    const config = { slice_chars: SLICE_CHARS, max_slices: MAX_SLICES, hierarchical_reduce: true };
    const result = extractSlices({ cwd: dir, corpusId, config });

    assert.equal(result.error, null, 'extractSlices must not error');

    // naturalCount = ceil(5000/1000) = 5; all within max_slices
    assert.equal(result.naturalCount, 5, 'naturalCount must be 5');
    assert.equal(result.sliceFiles.length, 5, 'must produce 5 slice files');

    // slice-0 content == first SLICE_CHARS chars of source
    const sourceContent = fs.readFileSync(filePath, 'utf8');
    const slice0Content = fs.readFileSync(result.sliceFiles[0].path, 'utf8');
    assert.equal(slice0Content, sourceContent.slice(0, SLICE_CHARS), 'slice-0 content must match first slice_chars chars');

    // last slice end == source.length
    const last = result.sliceFiles[result.sliceFiles.length - 1];
    assert.equal(last.end, sourceContent.length, 'last slice end must equal source length');

    // each slice <= slice_chars
    for (const sf of result.sliceFiles) {
      assert.ok(sf.chars <= SLICE_CHARS, `slice ${sf.index} must be <= slice_chars`);
    }
  });

});

// ─── pasted trigger ───────────────────────────────────────────────────────────

describe('detect → manifest → extract (pasted trigger)', () => {

  test('extractSlices reads corpus.txt and produces correct slices', () => {
    const SLICE_CHARS    = 500;
    const THRESHOLD_TOKENS = 100; // small so 400+ chars triggers
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_tokens: THRESHOLD_TOKENS,
          threshold_bytes:  10_000_000,
          slice_chars:      SLICE_CHARS,
          max_slices:       20,
          hierarchical_reduce: true,
        },
      },
    });

    // text of 600 chars → 150 tokens > threshold_tokens
    const TEXT_LEN = 600;
    const pastedText = 'b'.repeat(TEXT_LEN);

    const { status, stdout } = runHook(dir, pastedText);
    assert.equal(status, 0, 'hook must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'hook must emit advisory for pasted text');

    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('trigger: pasted'), 'advisory must state pasted trigger');

    const corpusId = getCorpusId(advisory);
    const config   = { slice_chars: SLICE_CHARS, max_slices: 20, hierarchical_reduce: true };
    const result   = extractSlices({ cwd: dir, corpusId, config });

    assert.equal(result.error, null, 'extractSlices must not error');
    assert.ok(result.sliceFiles.length > 0, 'must produce at least one slice');

    // verify corpus.txt was written by the hook
    const corpusTxt = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId, 'corpus.txt');
    assert.ok(fs.existsSync(corpusTxt), 'corpus.txt must exist');

    // slice-0 must equal first SLICE_CHARS chars of the pasted text
    const slice0 = fs.readFileSync(result.sliceFiles[0].path, 'utf8');
    assert.equal(slice0, pastedText.slice(0, SLICE_CHARS), 'slice-0 must match first slice_chars chars of pasted text');
  });

});

// ─── dir trigger ──────────────────────────────────────────────────────────────

describe('detect → manifest → extract (dir trigger)', () => {

  test('concat order and slice correctness for multi-file directory', () => {
    const SLICE_CHARS = 500;
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes: 500,
          slice_chars:     SLICE_CHARS,
          max_slices:      20,
          hierarchical_reduce: true,
        },
      },
    });

    // Create a directory with 2 text files whose combined content > threshold
    const bigDir = path.join(dir, 'srcdir');
    fs.mkdirSync(bigDir);
    // Use sorted names so concat order is deterministic
    fs.writeFileSync(path.join(bigDir, 'aaa.txt'), 'A'.repeat(400), 'utf8');
    fs.writeFileSync(path.join(bigDir, 'bbb.txt'), 'B'.repeat(400), 'utf8');
    // total = 800 > threshold 500

    const { status, stdout } = runHook(dir, 'Analyze ' + bigDir);
    assert.equal(status, 0, 'hook must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'hook must emit advisory for dir');
    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('trigger: dir'), 'advisory must state dir trigger');

    const corpusId = getCorpusId(advisory);
    const config   = { slice_chars: SLICE_CHARS, max_slices: 20, hierarchical_reduce: true };
    const result   = extractSlices({ cwd: dir, corpusId, config });

    assert.equal(result.error, null, 'extractSlices must not error');
    // Expected concat: 'A'×400 + 'B'×400 = 800 chars; 2 slices at 500
    assert.equal(result.naturalCount, 2, 'naturalCount must be 2');
    assert.equal(result.sliceFiles.length, 2, 'must produce 2 slice files');

    const expected = 'A'.repeat(400) + 'B'.repeat(400);
    const s0 = fs.readFileSync(result.sliceFiles[0].path, 'utf8');
    const s1 = fs.readFileSync(result.sliceFiles[1].path, 'utf8');
    assert.equal(s0, expected.slice(0, 500), 'slice-0 must be first 500 chars of concat');
    assert.equal(s1, expected.slice(500), 'slice-1 must be remaining chars of concat');
  });

});

// ─── batching ─────────────────────────────────────────────────────────────────

describe('batching (batchStart/maxOut)', () => {

  test('batchStart/maxOut restricts which slice files are written', () => {
    const SLICE_CHARS = 200;
    const MAX_SLICES  = 20;
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes: 100,
          slice_chars:     SLICE_CHARS,
          max_slices:      MAX_SLICES,
          hierarchical_reduce: true,
        },
      },
    });

    // 1000 chars → 5 natural slices
    const filePath = path.join(dir, 'data.txt');
    fs.writeFileSync(filePath, 'C'.repeat(1000), 'utf8');

    runHook(dir, 'Process ' + filePath);

    const advisory = parseOutput(
      runHook(dir, 'Process ' + filePath).stdout
    ).hookSpecificOutput.additionalContext;
    const corpusId = getCorpusId(advisory);

    const config = { slice_chars: SLICE_CHARS, max_slices: MAX_SLICES, hierarchical_reduce: true };

    // First batch: slices 0 and 1
    const r1 = extractSlices({ cwd: dir, corpusId, config, batchStart: 0, maxOut: 2 });
    assert.equal(r1.error, null);
    assert.equal(r1.sliceFiles.length, 2, 'batch 0: 2 slice files');
    assert.equal(r1.sliceFiles[0].index, 0);
    assert.equal(r1.sliceFiles[1].index, 1);

    // Second batch: slices 2 and 3
    const r2 = extractSlices({ cwd: dir, corpusId, config, batchStart: 2, maxOut: 2 });
    assert.equal(r2.error, null);
    assert.equal(r2.sliceFiles.length, 2, 'batch 1: 2 slice files');
    assert.equal(r2.sliceFiles[0].index, 2);
    assert.equal(r2.sliceFiles[1].index, 3);

    // Verify slices not in either batch are NOT present (index 4 not yet written)
    const slice4Path = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId, 'slice-4.txt');
    assert.ok(!fs.existsSync(slice4Path), 'slice-4 must not be written by a window that excluded it');
  });

  // FIX-2: regression test for cross-max_slices batching (would fail under old readCap truncation)
  test('cross-max_slices: naturalCount > max_slices; batchStart beyond cap extracts correct slice', () => {
    const SLICE_CHARS = 200;
    const MAX_SLICES  = 20;
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes:     100,
          slice_chars:         SLICE_CHARS,
          max_slices:          MAX_SLICES,
          hierarchical_reduce: true,
        },
      },
    });

    // ~4200 chars → naturalCount = ceil(4200/200) = 21 > max_slices=20 → hierarchical
    const SOURCE = 'x'.repeat(4200);
    const filePath = path.join(dir, 'large.txt');
    fs.writeFileSync(filePath, SOURCE, 'utf8');

    const { stdout } = runHook(dir, 'Analyze ' + filePath);
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'hook must emit advisory');
    const corpusId = getCorpusId(out.hookSpecificOutput.additionalContext);
    assert.ok(corpusId, 'must have corpus_id');

    const config = { slice_chars: SLICE_CHARS, max_slices: MAX_SLICES, hierarchical_reduce: true };

    // True naturalCount and mode must come from manifest.totalChars, NOT from a capped planSlices
    const r0 = extractSlices({ cwd: dir, corpusId, config, batchStart: 0, maxOut: MAX_SLICES });
    assert.equal(r0.error, null, 'batch 0 must not error');
    assert.equal(r0.naturalCount, 21, 'naturalCount must be 21 (true value from manifest)');
    assert.equal(r0.mode, 'hierarchical', 'mode must be hierarchical');
    assert.equal(r0.sliceFiles.length, 20, 'batch 0 must yield 20 slice files (indices 0..19)');

    // batchStart=20 must reach index 20 — chars [4000, 4200) — the slice beyond max_slices
    const r20 = extractSlices({ cwd: dir, corpusId, config, batchStart: 20, maxOut: MAX_SLICES });
    assert.equal(r20.error, null, 'batch at batchStart=20 must not error');
    assert.equal(r20.naturalCount, 21, 'naturalCount still 21 in second batch');
    assert.equal(r20.mode, 'hierarchical', 'mode still hierarchical');
    assert.equal(r20.sliceFiles.length, 1, 'batchStart=20 must yield exactly 1 slice (index 20)');
    assert.equal(r20.sliceFiles[0].index, 20, 'slice index must be 20');
    assert.equal(r20.sliceFiles[0].start, 4000, 'slice start must be 4000');
    assert.equal(r20.sliceFiles[0].end, 4200, 'slice end must be 4200');

    const sliceContent = fs.readFileSync(r20.sliceFiles[0].path, 'utf8');
    assert.equal(sliceContent, SOURCE.slice(4000, 4200), 'slice-20 content must match chars [4000,4200)');
  });

});

// ─── refused_cap event (W6.2) ─────────────────────────────────────────────────

describe('oversized_refused_cap event', () => {

  test('hook emits oversized_input_detected AND oversized_refused_cap (exactly one each)', () => {
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes:     1000,
          slice_chars:         100,
          max_slices:          2,
          hierarchical_reduce: false,
        },
      },
    });

    // ~1500 bytes > threshold 1000; naturalCount = ceil(1500/100) = 15 > max_slices 2 → refuse
    const filePath = makeSyntheticFile(dir, 'refuse.bin', 1500);

    const { status, stdout } = runHook(dir, 'Summarize ' + filePath);
    assert.equal(status, 0, 'hook must exit 0');

    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'hook must emit advisory');
    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('mode=refuse'), 'advisory must report mode=refuse');

    const events  = readEvents(dir);
    const detected = events.filter(e => e.type === 'oversized_input_detected');
    const refused  = events.filter(e => e.type === 'oversized_refused_cap');

    assert.equal(detected.length, 1, 'exactly one oversized_input_detected event');
    assert.equal(refused.length,  1, 'exactly one oversized_refused_cap event');

    // refused_cap must have required fields
    const ev = refused[0];
    assert.ok(ev.corpus_id, 'refused_cap must have corpus_id');
    assert.ok(ev.trigger,   'refused_cap must have trigger');
    assert.ok(typeof ev.natural_slices === 'number', 'refused_cap must have natural_slices');
    assert.ok(typeof ev.max_slices     === 'number', 'refused_cap must have max_slices');
    assert.ok(typeof ev.threshold_bytes === 'number', 'refused_cap must have threshold_bytes');
    assert.equal(ev.max_slices, 2, 'refused_cap.max_slices must match config');
  });

});

// ─── idempotency ──────────────────────────────────────────────────────────────

describe('idempotency', () => {

  test('second extractSlices call does not rewrite existing slice files (mtime check)', () => {
    const SLICE_CHARS = 300;
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes:     100,
          slice_chars:         SLICE_CHARS,
          max_slices:          10,
          hierarchical_reduce: true,
        },
      },
    });

    const filePath = path.join(dir, 'data.txt');
    fs.writeFileSync(filePath, 'D'.repeat(600), 'utf8');

    runHook(dir, 'Analyze ' + filePath);
    const advisory = parseOutput(runHook(dir, 'Analyze ' + filePath).stdout)
      .hookSpecificOutput.additionalContext;
    const corpusId = getCorpusId(advisory);

    const config = { slice_chars: SLICE_CHARS, max_slices: 10, hierarchical_reduce: true };

    // First call — writes slice files
    const r1 = extractSlices({ cwd: dir, corpusId, config });
    assert.equal(r1.error, null);
    assert.ok(r1.sliceFiles.length > 0, 'must produce slices on first call');
    assert.ok(r1.written > 0, 'first call must write files');

    // Capture mtimes
    const mtimes = r1.sliceFiles.map(sf => fs.statSync(sf.path).mtimeMs);

    // Wait one tick to ensure mtime would differ if file were rewritten
    // (mtime resolution can be 1ms on Linux)
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin 5ms */ }

    // Second call — must skip existing slice files
    const r2 = extractSlices({ cwd: dir, corpusId, config });
    assert.equal(r2.error, null);
    assert.equal(r2.written, 0, 'second call must write 0 files (all already exist)');

    // mtimes must be unchanged
    for (let i = 0; i < r1.sliceFiles.length; i++) {
      const mtime2 = fs.statSync(r1.sliceFiles[i].path).mtimeMs;
      assert.equal(mtime2, mtimes[i], `slice-${i} mtime must not change on second call`);
    }
  });

});

// ─── missing manifest ─────────────────────────────────────────────────────────

describe('missing manifest', () => {

  test('extractSlices on unknown corpusId returns {error:"manifest_unreadable"} without throwing', () => {
    const dir    = makeDir();
    const config = { slice_chars: 6000, max_slices: 64, hierarchical_reduce: true };

    let result;
    assert.doesNotThrow(() => {
      result = extractSlices({ cwd: dir, corpusId: 'deadbeef0000', config });
    }, 'extractSlices must not throw on missing manifest');

    assert.equal(result.error, 'manifest_unreadable', 'must return manifest_unreadable error');
    assert.deepEqual(result.sliceFiles, [], 'sliceFiles must be empty');
  });

});

// ─── W3: naturalCount from source.length, not manifest.totalChars ─────────────

describe('W3: naturalCount derives from source.length (not manifest.totalChars overestimate)', () => {

  test('manifest with inflated totalChars → naturalCount from real chars, no empty trailing slice', () => {
    // Simulate the bytes-as-chars overestimate the hook makes for file/dir triggers.
    // A real multibyte file (e.g. UTF-8 CJK) would have bytes >> chars; we mimic this
    // by directly writing a manifest with totalChars inflated above the actual source length.
    const SLICE_CHARS = 6000;
    const dir = makeDir({
      withConfig: {
        oversized_input: {
          threshold_bytes: 100,
          slice_chars:     SLICE_CHARS,
          max_slices:      64,
          hierarchical_reduce: true,
        },
      },
    });

    // Stage a real file with 10 000 ASCII chars (real naturalCount = ceil(10000/6000) = 2)
    const REAL_CHARS = 10000;
    const filePath = path.join(dir, 'corpus.bin');
    fs.writeFileSync(filePath, 'x'.repeat(REAL_CHARS), 'utf8');

    // Run hook to create the corpus dir and manifest
    const { stdout: hookOut } = runHook(dir, 'Summarize ' + filePath);
    const out = parseOutput(hookOut);
    assert.ok(out && out.hookSpecificOutput, 'hook must emit advisory');

    const corpusId = getCorpusId(out.hookSpecificOutput.additionalContext);
    assert.ok(corpusId);

    // Inflate totalChars in manifest to mimic bytes-as-chars overestimate.
    // 25000 bytes would give naturalCount = ceil(25000/6000) = 5 (but real is 2).
    const corpusBase = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId);
    const mfPath = path.join(corpusBase, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    const inflated = Object.assign({}, mf, { totalChars: 25000 });
    inflated.slicePlan = Object.assign({}, mf.slicePlan || {}, { naturalCount: 5, mode: 'direct' });
    fs.writeFileSync(mfPath, JSON.stringify(inflated), 'utf8');

    // extractSlices must correct to real source.length = 10000 chars
    const config = { slice_chars: SLICE_CHARS, max_slices: 64, hierarchical_reduce: true };
    const result = extractSlices({ cwd: dir, corpusId, config });

    assert.equal(result.error, null, 'must not error');
    assert.equal(result.naturalCount, 2, 'naturalCount must be 2 (from real source.length=10000, not inflated 25000)');
    assert.equal(result.sliceFiles.length, 2, 'must produce exactly 2 slice files (no empty trailing)');

    // Verify no empty slice files were written
    for (const sf of result.sliceFiles) {
      assert.ok(sf.chars > 0, `slice ${sf.index} must not be empty`);
      const content = fs.readFileSync(sf.path, 'utf8');
      assert.ok(content.length > 0, `slice-${sf.index}.txt must not be empty`);
    }

    // Confirm no slice-2.txt, slice-3.txt, slice-4.txt were created
    for (let i = 2; i < 5; i++) {
      const p = path.join(corpusBase, `slice-${i}.txt`);
      assert.ok(!fs.existsSync(p), `slice-${i}.txt must NOT exist (would be empty trailing slice)`);
    }
  });

});
