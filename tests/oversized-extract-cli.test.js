'use strict';

/**
 * Tests for bin/oversized-extract.js CLI (E1, v2.3.14).
 *
 * Verifies the CLI can be invoked after a corpus is staged by the hook,
 * produces correct slice files, and handles edge cases.
 *
 * Run: node --test tests/oversized-extract-cli.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK_SCRIPT    = path.resolve(__dirname, '../bin/detect-oversized-input.js');
const EXTRACT_SCRIPT = path.resolve(__dirname, '../bin/oversized-extract.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeDir(opts = {}) {
  const { withConfig = null } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-cli-test-'));
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

function runHook(dir, prompt) {
  const payload = JSON.stringify({ cwd: dir, prompt: prompt || '' });
  const r = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: payload, encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env),
  });
  return { stdout: r.stdout || '', status: r.status };
}

function runExtract(args) {
  const argv = [EXTRACT_SCRIPT, ...args];
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env),
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
    json: (() => { try { return JSON.parse((r.stdout || '').trim()); } catch (_e) { return null; } })(),
  };
}

function getCorpusId(stdout) {
  const advisory = (() => {
    try { return JSON.parse(stdout.trim()).hookSpecificOutput.additionalContext; } catch (_e) { return ''; }
  })();
  const m = advisory.match(/corpus_id: ([0-9a-f]+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Happy path: stage corpus via hook, then extract
// ---------------------------------------------------------------------------

describe('basic extraction (file trigger)', () => {

  test('exit 0, JSON stdout with sliceFiles, slice-0.txt written with correct content', () => {
    const SLICE_CHARS = 200;
    const dir = makeDir({
      withConfig: { oversized_input: { threshold_bytes: 100, slice_chars: SLICE_CHARS, max_slices: 20 } },
    });

    // Create a source file (300 chars = 2 slices at 200 chars each, all ASCII)
    const content = 'A'.repeat(300);
    const filePath = path.join(dir, 'source.txt');
    fs.writeFileSync(filePath, content, 'utf8');

    // Stage corpus via hook
    const { stdout: hookOut } = runHook(dir, 'Analyze ' + filePath);
    const corpusId = getCorpusId(hookOut);
    assert.ok(corpusId, 'hook must emit corpus_id');

    // Run extract CLI
    const r = runExtract(['--cwd', dir, '--corpus', corpusId]);
    assert.equal(r.status, 0, 'extract CLI must exit 0');

    const result = r.json;
    assert.ok(result, 'stdout must be valid JSON');
    assert.equal(result.error, null, 'result.error must be null');
    assert.ok(Array.isArray(result.sliceFiles), 'sliceFiles must be an array');
    assert.ok(result.sliceFiles.length > 0, 'sliceFiles must be non-empty');
    assert.equal(result.naturalCount, 2, 'naturalCount must be 2 (ceil(300/200))');

    // slice-0.txt must exist with correct first 200 chars
    const slice0Path = result.sliceFiles[0].path;
    assert.ok(fs.existsSync(slice0Path), 'slice-0.txt must be written');
    const slice0 = fs.readFileSync(slice0Path, 'utf8');
    assert.equal(slice0, content.slice(0, SLICE_CHARS), 'slice-0 content must match first SLICE_CHARS chars');
  });

});

// ---------------------------------------------------------------------------
// --batch-start beyond naturalCount: empty sliceFiles + true naturalCount
// ---------------------------------------------------------------------------

describe('--batch-start beyond naturalCount', () => {

  test('returns empty sliceFiles, true naturalCount, exit 0', () => {
    const SLICE_CHARS = 200;
    const dir = makeDir({
      withConfig: { oversized_input: { threshold_bytes: 100, slice_chars: SLICE_CHARS, max_slices: 20 } },
    });

    // 300 chars = naturalCount 2
    const filePath = path.join(dir, 'source.txt');
    fs.writeFileSync(filePath, 'B'.repeat(300), 'utf8');

    const { stdout: hookOut } = runHook(dir, 'Analyze ' + filePath);
    const corpusId = getCorpusId(hookOut);
    assert.ok(corpusId, 'hook must emit corpus_id');

    // batch-start=100 is well beyond naturalCount=2
    const r = runExtract(['--cwd', dir, '--corpus', corpusId, '--batch-start', '100']);
    assert.equal(r.status, 0, 'must exit 0 even when batchStart beyond naturalCount');

    const result = r.json;
    assert.ok(result, 'must return valid JSON');
    assert.deepEqual(result.sliceFiles, [], 'sliceFiles must be empty');
    assert.equal(result.naturalCount, 2, 'naturalCount must be true value (2), not batch offset');
    assert.equal(result.error, null, 'error must be null');
  });

});

// ---------------------------------------------------------------------------
// --batch-start and --max-out windowing
// ---------------------------------------------------------------------------

describe('--batch-start / --max-out windowing', () => {

  test('second batch returns only the right slice range', () => {
    const SLICE_CHARS = 100;
    const dir = makeDir({
      withConfig: { oversized_input: { threshold_bytes: 100, slice_chars: SLICE_CHARS, max_slices: 20 } },
    });

    // 500 chars = 5 natural slices
    const filePath = path.join(dir, 'data.txt');
    fs.writeFileSync(filePath, 'C'.repeat(500), 'utf8');

    const { stdout: hookOut } = runHook(dir, 'Process ' + filePath);
    const corpusId = getCorpusId(hookOut);
    assert.ok(corpusId);

    // First batch: slices 0–1
    const r1 = runExtract(['--cwd', dir, '--corpus', corpusId, '--batch-start', '0', '--max-out', '2']);
    assert.equal(r1.status, 0);
    assert.equal(r1.json.sliceFiles.length, 2, 'first batch: 2 slices');
    assert.equal(r1.json.sliceFiles[0].index, 0);
    assert.equal(r1.json.sliceFiles[1].index, 1);

    // Second batch: slices 2–3
    const r2 = runExtract(['--cwd', dir, '--corpus', corpusId, '--batch-start', '2', '--max-out', '2']);
    assert.equal(r2.status, 0);
    assert.equal(r2.json.sliceFiles.length, 2, 'second batch: 2 slices');
    assert.equal(r2.json.sliceFiles[0].index, 2);
    assert.equal(r2.json.sliceFiles[1].index, 3);
  });

});

// ---------------------------------------------------------------------------
// Missing --corpus argument
// ---------------------------------------------------------------------------

describe('error handling', () => {

  test('missing --corpus → exit 1 with error in JSON', () => {
    const dir = makeDir();
    const r = runExtract(['--cwd', dir]);
    assert.equal(r.status, 1, 'must exit 1 when --corpus is missing');
    const result = r.json;
    assert.ok(result && result.error, 'must return JSON with error field');
  });

  test('unknown corpus id → exit 1 with manifest_unreadable', () => {
    const dir = makeDir();
    const r = runExtract(['--cwd', dir, '--corpus', 'deadbeef0000']);
    assert.equal(r.status, 1, 'must exit 1 for unknown corpus');
    assert.ok(r.json && r.json.error, 'must return JSON with error');
  });

  test('traversal corpus id (../../etc) → rejected, exit 1 invalid corpus id', () => {
    const dir = makeDir();
    const r = runExtract(['--cwd', dir, '--corpus', '../../../../../../etc']);
    assert.equal(r.status, 1, 'must reject path-traversal corpus id');
    assert.equal(r.json && r.json.error, 'invalid corpus id', 'must report invalid corpus id, not attempt the path');
  });

  test('non-hex corpus id → rejected as invalid', () => {
    const dir = makeDir();
    const r = runExtract(['--cwd', dir, '--corpus', 'ZZZ123']);
    assert.equal(r.status, 1);
    assert.equal(r.json && r.json.error, 'invalid corpus id');
  });

  test('negative --batch-start → exit 1, no corrupt slice files', () => {
    const SLICE_CHARS = 100;
    const dir = makeDir({
      withConfig: { oversized_input: { threshold_bytes: 100, slice_chars: SLICE_CHARS, max_slices: 20 } },
    });
    const filePath = path.join(dir, 'src.txt');
    fs.writeFileSync(filePath, 'D'.repeat(500), 'utf8');
    const { stdout: hookOut } = runHook(dir, 'Analyze ' + filePath);
    const corpusId = getCorpusId(hookOut);
    assert.ok(corpusId);
    const r = runExtract(['--cwd', dir, '--corpus', corpusId, '--batch-start', '-3']);
    assert.equal(r.status, 1, 'negative batch-start must be rejected');
    assert.ok(r.json && /non-negative/.test(r.json.error), 'error must mention non-negative');
    // No negative-index slice files were written
    const corpusDir = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId);
    const negFiles = fs.readdirSync(corpusDir).filter(f => /slice--/.test(f));
    assert.equal(negFiles.length, 0, 'no slice--N.txt corrupt files');
  });

});
