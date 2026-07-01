#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/detect-oversized-input.js
 *
 * UserPromptSubmit hook — oversized input detection (W3 v2.3.14).
 *
 * Coverage:
 *   - kill switch: enabled:false in config → no-op
 *   - kill switch: ORCHESTRAY_DISABLE_OVERSIZED_INPUT=1 → no-op
 *   - small prompt, no paths → no-op fast path
 *   - file ref over threshold → detection: manifest written, advisory injected, event emitted
 *   - pasted text over token threshold → detection: corpus.txt written
 *   - malformed stdin / unreadable path → fail-open (exit 0, {"continue":true})
 *   - idempotency: second run with same corpus does not rewrite manifest.json
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  DEFAULT_OVERSIZED_INPUT,
  validateOversizedInputConfig,
} = require('../../bin/_lib/config-schema');

const SCRIPT = path.resolve(__dirname, '../../bin/detect-oversized-input.js');

// Threshold from DEFAULT_OVERSIZED_INPUT (1.5 MB)
const DEFAULT_THRESHOLD_BYTES = 1572864;
// Token threshold
const DEFAULT_THRESHOLD_TOKENS = 200000;
// 4 chars per token
const CHARS_PER_TOKEN = 4;

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/** Create isolated tmp dir with standard .orchestray layout. */
function makeDir(opts = {}) {
  const { withConfig = null } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-oi-test-'));
  cleanup.push(dir);
  const orchestrayDir = path.join(dir, '.orchestray');
  const stateDir = path.join(orchestrayDir, 'state');
  const auditDir = path.join(orchestrayDir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  if (withConfig !== null) {
    fs.writeFileSync(
      path.join(orchestrayDir, 'config.json'),
      JSON.stringify(withConfig)
    );
  }

  return { dir, stateDir, auditDir, orchestrayDir };
}

/**
 * Create a synthetic file of exactly `size` bytes in `dir`.
 * Returns the absolute path.
 */
function makeSyntheticFile(dir, name, size) {
  const filePath = path.join(dir, name);
  // Write in chunks to avoid large allocations
  const CHUNK = 65536;
  const buf = Buffer.alloc(Math.min(CHUNK, size), 0x61); // 'a'
  const fd = fs.openSync(filePath, 'w');
  let written = 0;
  while (written < size) {
    const toWrite = Math.min(CHUNK, size - written);
    fs.writeSync(fd, buf, 0, toWrite);
    written += toWrite;
  }
  fs.closeSync(fd);
  return filePath;
}

/** Invoke the hook, returning { stdout, stderr, status }. */
function run(dir, prompt, extraEnv = {}) {
  const payload = JSON.stringify({ cwd: dir, prompt: prompt || '' });
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, extraEnv),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/** Parse the hook output JSON, or null on parse error. */
function parseOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch (_e) { return null; }
}

/** Read events from events.jsonl, return parsed array. */
function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------

describe('kill switches', () => {

  test('config enabled:false → no-op {"continue":true}', () => {
    const { dir } = makeDir({ withConfig: { oversized_input: { enabled: false } } });
    // Large prompt to ensure it would normally trigger
    const bigPrompt = 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1);
    const { status, stdout } = run(dir, bigPrompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
    // No hookSpecificOutput/advisory
    assert.ok(!out.hookSpecificOutput, 'must not emit advisory on kill switch');
  });

  test('ORCHESTRAY_DISABLE_OVERSIZED_INPUT=1 → no-op {"continue":true}', () => {
    const { dir } = makeDir();
    const bigPrompt = 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1);
    const { status, stdout } = run(dir, bigPrompt, { ORCHESTRAY_DISABLE_OVERSIZED_INPUT: '1' });
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
    assert.ok(!out.hookSpecificOutput, 'must not emit advisory on env kill switch');
  });

});

// ---------------------------------------------------------------------------
// Fast path
// ---------------------------------------------------------------------------

describe('fast path', () => {

  test('small prompt with no path-like tokens → no-op, no manifest', () => {
    const { dir } = makeDir();
    const { status, stdout } = run(dir, 'hello world, what is 2+2?');
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    // Fast path: {"continue":true} with no additionalContext
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
    assert.ok(!out.hookSpecificOutput, 'must not inject advisory for small prompt');
    // No corpus dirs created
    const corpusBase = path.join(dir, '.orchestray', 'state', 'input-corpus');
    const entries = fs.existsSync(corpusBase) ? fs.readdirSync(corpusBase) : [];
    assert.equal(entries.length, 0, 'no corpus dirs for small prompt');
  });

});

// ---------------------------------------------------------------------------
// File detection
// ---------------------------------------------------------------------------

describe('file detection', () => {

  test('file ref over threshold → manifest written, advisory injected, event emitted', () => {
    const { dir, auditDir } = makeDir();
    // Create synthetic oversized file in tmp dir
    const fileSize = DEFAULT_THRESHOLD_BYTES + 1;
    const filePath = makeSyntheticFile(dir, 'bigfile.bin', fileSize);
    const prompt = 'Please summarize ' + filePath;

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');

    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must include continue:true');
    assert.ok(out.hookSpecificOutput, 'must emit hookSpecificOutput');
    assert.ok(out.hookSpecificOutput.additionalContext, 'must emit additionalContext');

    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('<oversized-input-advisory>'), 'advisory must have opening tag');
    assert.ok(advisory.includes('</oversized-input-advisory>'), 'advisory must have closing tag');
    assert.ok(advisory.includes('trigger: file'), 'advisory must state trigger:file');
    assert.ok(advisory.includes('Manifest:'), 'advisory must include manifest path'); // I1: uppercase only

    // corpus_id in advisory
    const corpusIdMatch = advisory.match(/corpus_id: ([0-9a-f]+)/);
    assert.ok(corpusIdMatch, 'advisory must include corpus_id');
    const corpusId = corpusIdMatch[1];
    assert.equal(corpusId.length, 12, 'corpus_id must be 12 hex chars');

    // manifest.json written
    const mfPath = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId, 'manifest.json');
    assert.ok(fs.existsSync(mfPath), 'manifest.json must be written');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    assert.equal(mf.corpusId, corpusId, 'manifest.corpusId must match');
    assert.equal(mf.trigger, 'file', 'manifest.trigger must be file');
    assert.ok(typeof mf.totalBytes === 'number' && mf.totalBytes > 0, 'manifest.totalBytes must be set');

    // audit event emitted
    const events = readEvents(auditDir);
    const detEvents = events.filter(e => e.type === 'oversized_input_detected');
    assert.equal(detEvents.length, 1, 'exactly one oversized_input_detected event');
    const ev = detEvents[0];
    assert.equal(ev.corpus_id, corpusId, 'event corpus_id must match');
    assert.equal(ev.trigger, 'file', 'event trigger must be file');
    assert.ok(typeof ev.total_bytes === 'number', 'event must have total_bytes');
    assert.ok(typeof ev.est_tokens === 'number', 'event must have est_tokens');
  });

});

// ---------------------------------------------------------------------------
// Directory detection
// ---------------------------------------------------------------------------

describe('dir detection', () => {

  test('dir ref whose children exceed threshold → trigger:dir, manifest + event', () => {
    const { dir, auditDir } = makeDir();
    const bigDir = path.join(dir, 'bigdir');
    fs.mkdirSync(bigDir, { recursive: true });
    const half = Math.ceil((DEFAULT_THRESHOLD_BYTES + 2) / 2);
    makeSyntheticFile(bigDir, 'a.bin', half);
    makeSyntheticFile(bigDir, 'b.bin', half);
    const prompt = 'Please analyze the logs in ' + bigDir;

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'must emit advisory');
    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('trigger: dir'), 'advisory must state trigger:dir');

    const corpusId = advisory.match(/corpus_id: ([0-9a-f]+)/)[1];
    const mfPath = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId, 'manifest.json');
    assert.ok(fs.existsSync(mfPath), 'manifest.json written for dir trigger');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    assert.equal(mf.trigger, 'dir', 'manifest.trigger must be dir');
    assert.equal(mf.sourcePath, bigDir, 'manifest.sourcePath must record the dir');

    const events = readEvents(auditDir).filter(e => e.type === 'oversized_input_detected');
    assert.equal(events.length, 1, 'one detection event');
    assert.equal(events[0].trigger, 'dir', 'event trigger must be dir');
  });

});

// ---------------------------------------------------------------------------
// Refuse mode (over max_slices, hierarchical_reduce disabled)
// ---------------------------------------------------------------------------

describe('refuse mode advisory', () => {

  test('over max_slices with hierarchical_reduce:false → advisory reports refuse, not slice protocol', () => {
    const { dir } = makeDir({
      withConfig: { oversized_input: {
        threshold_bytes: 1000, slice_chars: 100, max_slices: 2, hierarchical_reduce: false,
      } },
    });
    // 1500 bytes > threshold 1000; naturalCount = ceil(1500/100) = 15 > max_slices 2 → refuse
    const filePath = makeSyntheticFile(dir, 'refuse.bin', 1500);
    const prompt = 'Summarize ' + filePath;

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'must emit advisory');
    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('mode=refuse'), 'advisory must report mode=refuse');
    assert.ok(advisory.includes('too large to slice'), 'advisory must warn corpus cannot be sliced');
    assert.ok(!advisory.includes('per the oversized-input-mode protocol'),
      'refuse advisory must NOT instruct the slice-mode protocol');
  });

});

// ---------------------------------------------------------------------------
// Pasted text detection
// ---------------------------------------------------------------------------

describe('pasted text detection', () => {

  test('pasted text over token threshold → corpus.txt written, advisory injected', () => {
    // Use a small custom threshold_tokens via config to keep payload size manageable.
    // 1000 tokens × 4 chars = 4000 chars — well under MAX_INPUT_BYTES, no path-like tokens.
    const SMALL_THRESHOLD_TOKENS = 1000;
    const { dir } = makeDir({
      withConfig: { oversized_input: { threshold_tokens: SMALL_THRESHOLD_TOKENS, threshold_bytes: 10000000 } },
    });
    const textLen = SMALL_THRESHOLD_TOKENS * CHARS_PER_TOKEN + 100;
    const bigText = 'a'.repeat(textLen);

    const { status, stdout } = run(dir, bigText);
    assert.equal(status, 0, 'must exit 0');

    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must include continue:true');
    assert.ok(out.hookSpecificOutput, 'must emit hookSpecificOutput');
    const advisory = out.hookSpecificOutput.additionalContext;
    assert.ok(advisory.includes('trigger: pasted'), 'advisory must state trigger:pasted');

    // Extract corpus_id and verify corpus.txt exists
    const corpusIdMatch = advisory.match(/corpus_id: ([0-9a-f]+)/);
    assert.ok(corpusIdMatch, 'advisory must include corpus_id');
    const corpusId = corpusIdMatch[1];

    const corpusTxtPath = path.join(dir, '.orchestray', 'state', 'input-corpus', corpusId, 'corpus.txt');
    assert.ok(fs.existsSync(corpusTxtPath), 'corpus.txt must be written for pasted trigger');
  });

});

// ---------------------------------------------------------------------------
// Fail-open discipline
// ---------------------------------------------------------------------------

describe('fail-open discipline', () => {

  test('malformed JSON on stdin → exit 0, {"continue":true}', () => {
    const { dir } = makeDir();
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '{{not valid json}}',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'must exit 0 on malformed stdin');
    const out = parseOutput(result.stdout || '');
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
  });

  test('empty stdin → exit 0', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'must exit 0 on empty stdin');
  });

  test('prompt references non-existent path → no detection, no crash', () => {
    const { dir } = makeDir();
    const prompt = 'Please process /nonexistent/path/to/bigfile.txt';
    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0 when referenced path does not exist');
    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
    // No advisory since path doesn't exist
    assert.ok(!out.hookSpecificOutput, 'must not emit advisory for non-existent path');
  });

});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {

  test('second invocation with same corpus does not rewrite manifest.json', () => {
    const { dir } = makeDir();
    const fileSize = DEFAULT_THRESHOLD_BYTES + 1;
    const filePath = makeSyntheticFile(dir, 'idem-file.bin', fileSize);
    const prompt = 'Summarize ' + filePath;

    // First run
    const { status: s1 } = run(dir, prompt);
    assert.equal(s1, 0);

    // Find manifest path from corpus dirs
    const corpusBase = path.join(dir, '.orchestray', 'state', 'input-corpus');
    const corpusDirs = fs.readdirSync(corpusBase);
    assert.equal(corpusDirs.length, 1, 'exactly one corpus dir after first run');
    const mfPath = path.join(corpusBase, corpusDirs[0], 'manifest.json');
    assert.ok(fs.existsSync(mfPath), 'manifest.json must exist after first run');

    const mtime1 = fs.statSync(mfPath).mtimeMs;

    // Small sleep to ensure mtime would differ if rewritten
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) { /* spin */ }

    // Second run (same corpus)
    const { status: s2 } = run(dir, prompt);
    assert.equal(s2, 0);

    const mtime2 = fs.statSync(mfPath).mtimeMs;
    assert.equal(mtime1, mtime2, 'manifest.json mtime must not change on second run (idempotent)');
  });

});

// ---------------------------------------------------------------------------
// max_corpus_bytes ceiling (B1, v2.3.15 dogfooding bugfix)
// ---------------------------------------------------------------------------

describe('max_corpus_bytes ceiling', () => {

  test('DEFAULT_OVERSIZED_INPUT has correct max_corpus_bytes default', () => {
    assert.equal(DEFAULT_OVERSIZED_INPUT.max_corpus_bytes, 536870912, '512 MB default');
  });

  test('validator rejects non-positive max_corpus_bytes', () => {
    const result = validateOversizedInputConfig({ max_corpus_bytes: 0 });
    assert.equal(result.valid, false, 'zero must be rejected');
    const result2 = validateOversizedInputConfig({ max_corpus_bytes: -5 });
    assert.equal(result2.valid, false, 'negative must be rejected');
    const result3 = validateOversizedInputConfig({ max_corpus_bytes: 1.5 });
    assert.equal(result3.valid, false, 'non-integer must be rejected');
  });

  test('dir whose size exceeds max_corpus_bytes → no detection, no manifest', () => {
    const { dir } = makeDir({
      withConfig: { oversized_input: { threshold_bytes: 1000, max_corpus_bytes: 5000 } },
    });
    const bigDir = path.join(dir, 'hugedir');
    fs.mkdirSync(bigDir, { recursive: true });
    makeSyntheticFile(bigDir, 'a.bin', 6000); // over threshold AND over ceiling
    const prompt = 'Please analyze ' + bigDir;

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
    assert.ok(!out.hookSpecificOutput, 'must not emit advisory when corpus exceeds max_corpus_bytes');

    const corpusBase = path.join(dir, '.orchestray', 'state', 'input-corpus');
    const entries = fs.existsSync(corpusBase) ? fs.readdirSync(corpusBase) : [];
    assert.equal(entries.length, 0, 'no corpus dirs written when ceiling exceeded');
  });

  test('file at 2 MB (under ceiling, over threshold) still triggers — no regression', () => {
    const { dir } = makeDir();
    const fileSize = 2 * 1024 * 1024; // 2 MB, under 512 MB default ceiling
    const filePath = makeSyntheticFile(dir, 'normal.bin', fileSize);
    const prompt = 'Please summarize ' + filePath;

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.hookSpecificOutput, 'must still trigger for a plausible 2 MB document');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('trigger: file'));
  });

});

// ---------------------------------------------------------------------------
// Root / home-root path guard (B2, v2.3.15 dogfooding bugfix)
// ---------------------------------------------------------------------------

describe('root/home path guard', () => {

  test('path token resolving to filesystem root → no detection', () => {
    const { dir } = makeDir();
    const prompt = 'Please analyze /';

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(out && out.continue === true, 'must emit {"continue":true}');
    assert.ok(!out.hookSpecificOutput, 'must never trigger on a bare filesystem root token');
  });

  test('path token resolving to os.homedir() → no detection', () => {
    const { dir } = makeDir();
    const prompt = 'Please analyze ' + os.homedir();

    const { status, stdout } = run(dir, prompt);
    assert.equal(status, 0, 'must exit 0');
    const out = parseOutput(stdout);
    assert.ok(!out.hookSpecificOutput, 'must never trigger on the home directory itself');
  });

});
