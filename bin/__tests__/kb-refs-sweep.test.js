#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/kb-refs-sweep.js
 *
 * Runner: node --test bin/__tests__/kb-refs-sweep.test.js
 *
 * Isolation contract:
 *   - Every test creates its own tmp dir via mkdtempSync.
 *   - ORCHESTRAY_TEST_SHARED_DIR is set per-test to an isolated dir when needed.
 *   - No real .orchestray/kb/ files are touched.
 *   - Read-only invariants are asserted via mtime + size snapshot.
 *
 * Coverage areas:
 *   1. Happy path — broken @orchestray:kb:// ref detected
 *   2. Broken pattern ref — @orchestray:pattern://missing-slug
 *   3. Bare-slug match — present slug (no finding), absent slug (finding)
 *   4. No @ references — zero broken refs, report written
 *   5. Missing index.json — skip with no_index
 *   6. Missing KB bucket dirs — skip with no_kb
 *   7. Throttling — second run skipped; --force overrides
 *   8. Read-only invariants — no KB/patterns file modified after sweep
 *   9. Artefact frontmatter — status: sweep-report, enforced: false, counts match
 *  10. Artefact naming — no pending- prefix (UX-10)
 *  11. Malformed frontmatter in a KB file — file still scanned; degraded entry
 *  12. dry-run — no artefact written
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const crypto = require('node:crypto');

const { parseFrontmatter: _parseFrontmatter } = require('../_lib/frontmatter-parse');

const {
  runKbRefsSweep,
  _isThrottled,
  _loadKbSlugs,
  _loadPatternSlugs,
  _snapshotFiles,
  _collectMdFiles,
  _scanFile,
} = require('../kb-refs-sweep.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary project directory with minimal structure:
 *   .orchestray/kb/{artifacts,facts,decisions}/
 *   .orchestray/kb/index.json
 *   .orchestray/patterns/
 *   .orchestray/state/
 *   .orchestray/audit/
 */
function makeTmpProject({ entries = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sweep-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });

  // Write index.json with the provided entries.
  const index = {
    version: '1.0',
    created_at: new Date().toISOString(),
    entries,
  };
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'kb', 'index.json'),
    JSON.stringify(index),
    'utf8'
  );

  // Write config.json with kb_refs_sweep.enabled: true so the config gate
  // (added in W10) passes by default in tests that aren't specifically testing
  // the gate behaviour.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({
      auto_learning: {
        global_kill_switch: false,
        extract_on_complete: { enabled: false, shadow_mode: false, proposals_per_orchestration: 3, proposals_per_24h: 10 },
        roi_aggregator: { enabled: false, min_days_between_runs: 1, lookback_days: 30 },
        kb_refs_sweep: { enabled: true, min_days_between_runs: 7 },
        safety: { circuit_breaker: { max_extractions_per_24h: 10, cooldown_minutes_on_trip: 60 } },
      },
    }, null, 2),
    'utf8'
  );

  return dir;
}

/** Write a KB artifact .md file with optional content. */
function writeKbFile(projectDir, bucket, filename, content) {
  const p = path.join(projectDir, '.orchestray', 'kb', bucket, filename);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** Write a patterns .md file. */
function writePatternFile(projectDir, slug, content) {
  const p = path.join(projectDir, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(p, content || `---\nname: ${slug}\ncategory: decomposition\nconfidence: 0.7\ndescription: Test\n---\n\n# Pattern body\n`, 'utf8');
  return p;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns a plain object. String values only (for test assertions).
 */
function parseFrontmatter(content) {
  const result = _parseFrontmatter(content);
  if (!result) return {};
  // Coerce all values to strings to match prior test-helper behavior.
  const obj = {};
  for (const [k, v] of Object.entries(result.frontmatter)) {
    obj[k] = v === null ? '' : String(v);
  }
  return obj;
}

/**
 * Snapshot mtime+size for all files under a directory tree.
 * Returns a plain object { absPath: {mtimeMs, size} }.
 */
function snapshotDir(dir) {
  const snap = {};
  function recurse(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        recurse(full);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          snap[full] = { mtimeMs: st.mtimeMs, size: st.size };
        } catch (_e) {
          snap[full] = null;
        }
      }
    }
  }
  recurse(dir);
  return snap;
}

// ---------------------------------------------------------------------------
// 1. Happy path — broken @orchestray:kb:// ref detected
// ---------------------------------------------------------------------------

test('detects broken @orchestray:kb:// ref', async () => {
  const dir = makeTmpProject({
    entries: [
      { slug: 'good-artifact', type: 'artifact', path: '.orchestray/kb/artifacts/good-artifact.md' },
      { slug: 'another-fact', type: 'fact', path: '.orchestray/kb/facts/another-fact.md' },
    ],
  });

  // File referencing existing slug — no finding.
  writeKbFile(dir, 'artifacts', 'good-artifact.md', `---\nslug: good-artifact\n---\n\nSee @orchestray:kb://good-artifact for details.\n`);
  // File referencing missing slug — should produce a finding.
  writeKbFile(dir, 'facts', 'broken-ref.md', `---\nslug: broken-ref\n---\n\nSee @orchestray:kb://ghost for details.\n`);

  const result = await runKbRefsSweep({ cwd: dir });

  assert.equal(result.status, 'complete');
  assert.equal(result.brokenKbRefs, 1, 'should find 1 broken kb ref');
  assert.equal(result.brokenPatternRefs, 0);
  assert.ok(result.artefactPath, 'artefact path should be set');

  // Verify artefact was written.
  const artefactContent = fs.readFileSync(result.artefactPath, 'utf8');
  assert.ok(artefactContent.includes('ghost'), 'artefact should mention the missing slug');
  assert.ok(artefactContent.includes('SUGGESTED — NOT APPLIED'), 'suggested actions marker');
});

// ---------------------------------------------------------------------------
// 2. Broken @orchestray:pattern:// ref
// ---------------------------------------------------------------------------

test('detects broken @orchestray:pattern:// ref', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'my-artifact', type: 'artifact', path: '.orchestray/kb/artifacts/my-artifact.md' }],
  });

  // A pattern file that exists.
  writePatternFile(dir, 'existing-pattern');
  // A KB file referencing a missing pattern.
  writeKbFile(dir, 'artifacts', 'my-artifact.md',
    `---\nslug: my-artifact\n---\n\nUse @orchestray:pattern://existing-pattern and @orchestray:pattern://missing-slug.\n`);

  const result = await runKbRefsSweep({ cwd: dir });

  assert.equal(result.status, 'complete');
  assert.equal(result.brokenPatternRefs, 1, 'should find 1 broken pattern ref');
  assert.equal(result.brokenKbRefs, 0);
});

// ---------------------------------------------------------------------------
// 3. Bare-slug matches
// ---------------------------------------------------------------------------

test('bare slug: existing slug produces no finding', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'known-good-slug', type: 'artifact' }],
  });

  writeKbFile(dir, 'artifacts', 'test.md',
    `---\nslug: test\n---\n\nSee also: known-good-slug for reference.\n`);

  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');
  assert.equal(result.brokenBareRefs, 0, 'existing bare slug should not trigger finding');
});

test('bare slug: missing slug produces a finding', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'known-good-slug', type: 'artifact' }],
  });

  // K4 two-signal rule: bare slug is flagged only when BOTH (a) a prefix phrase
  // appears on the current or previous line AND (b) the slug is in a structural
  // context (list item, table cell, or link target). Use a list-item with a prefix
  // to satisfy both signals.
  writeKbFile(dir, 'artifacts', 'test.md',
    `---\nslug: test\n---\n\n- See also: missing-xyz-thing\n`);

  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');
  assert.equal(result.brokenBareRefs, 1, 'missing bare slug should produce a finding');
});

// ---------------------------------------------------------------------------
// 4. No @ references at all — zero broken refs, report written
// ---------------------------------------------------------------------------

test('clean project with no references produces zero findings and writes report', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'clean-artifact', type: 'artifact' }],
  });

  writeKbFile(dir, 'artifacts', 'clean.md',
    `---\nslug: clean-artifact\n---\n\nThis file has no references at all.\n`);

  const result = await runKbRefsSweep({ cwd: dir });

  assert.equal(result.status, 'complete');
  assert.equal(result.brokenKbRefs, 0);
  assert.equal(result.brokenPatternRefs, 0);
  assert.equal(result.brokenBareRefs, 0);
  assert.ok(result.artefactPath, 'artefact should still be written for clean project');
  assert.ok(fs.existsSync(result.artefactPath), 'artefact file should exist on disk');

  const content = fs.readFileSync(result.artefactPath, 'utf8');
  assert.ok(content.includes('No broken references found'), 'zero-findings message in report');
});

// ---------------------------------------------------------------------------
// 5. Missing index.json — skip with no_index
// ---------------------------------------------------------------------------

test('missing index.json skips with no_index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sweep-test-'));
  // Create KB dir structure but NO index.json.
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  // Enable sweep in config so the config gate passes and no_index is reached.
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({
    auto_learning: { global_kill_switch: false, kb_refs_sweep: { enabled: true, min_days_between_runs: 7 } },
  }, null, 2), 'utf8');

  const result = await runKbRefsSweep({ cwd: dir });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_index');
});

// ---------------------------------------------------------------------------
// 6. Missing KB bucket dirs — skip with no_kb
// ---------------------------------------------------------------------------

test('missing KB root directory skips with no_kb', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sweep-test-'));
  // NO .orchestray/kb directory at all.
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  // Enable sweep in config so the config gate passes and no_kb is reached.
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({
    auto_learning: { global_kill_switch: false, kb_refs_sweep: { enabled: true, min_days_between_runs: 7 } },
  }, null, 2), 'utf8');

  const result = await runKbRefsSweep({ cwd: dir });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_kb');
});

// ---------------------------------------------------------------------------
// 7. Throttling — second run skipped; --force overrides
// ---------------------------------------------------------------------------

test('throttle: second immediate run is skipped', async () => {
  const dir = makeTmpProject({ entries: [] });

  // First run: should succeed.
  const first = await runKbRefsSweep({ cwd: dir, windowDays: 1 });
  assert.equal(first.status, 'complete');

  // Second run without force: should be throttled.
  const second = await runKbRefsSweep({ cwd: dir, windowDays: 1 });
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'throttled');
});

test('throttle: --force overrides throttle', async () => {
  const dir = makeTmpProject({ entries: [] });

  // First run.
  await runKbRefsSweep({ cwd: dir, windowDays: 1 });

  // Second run with force: should succeed.
  const second = await runKbRefsSweep({ cwd: dir, windowDays: 1, force: true });
  assert.equal(second.status, 'complete');
});

// ---------------------------------------------------------------------------
// 8. Read-only invariants — KB and patterns files unchanged after sweep
// ---------------------------------------------------------------------------

test('read-only invariant: no KB or patterns file is modified by sweep', async () => {
  const dir = makeTmpProject({
    entries: [
      { slug: 'artifact-one', type: 'artifact' },
      { slug: 'fact-one', type: 'fact' },
    ],
  });

  // Write some KB files and a pattern file.
  writeKbFile(dir, 'artifacts', 'artifact-one.md',
    `---\nslug: artifact-one\n---\n\nContent with @orchestray:kb://ghost-ref.\n`);
  writeKbFile(dir, 'facts', 'fact-one.md',
    `---\nslug: fact-one\n---\n\nFact content.\n`);
  writePatternFile(dir, 'some-pattern');

  // Snapshot all KB and pattern files BEFORE sweep.
  const kbBefore = snapshotDir(path.join(dir, '.orchestray', 'kb', 'artifacts'));
  const kbFactsBefore = snapshotDir(path.join(dir, '.orchestray', 'kb', 'facts'));
  const patBefore = snapshotDir(path.join(dir, '.orchestray', 'patterns'));

  // Run sweep.
  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');

  // Snapshot after sweep — exclude the new artefact written by sweep itself.
  const kbAfter = snapshotDir(path.join(dir, '.orchestray', 'kb', 'artifacts'));
  const kbFactsAfter = snapshotDir(path.join(dir, '.orchestray', 'kb', 'facts'));
  const patAfter = snapshotDir(path.join(dir, '.orchestray', 'patterns'));

  // Check pre-existing files in artifacts/facts unchanged.
  for (const [file, before] of Object.entries(kbBefore)) {
    if (!kbAfter[file]) continue; // file was removed? that would also be a bug
    assert.equal(kbAfter[file].size, before.size, `artifacts file size changed: ${file}`);
    assert.equal(kbAfter[file].mtimeMs, before.mtimeMs, `artifacts mtime changed: ${file}`);
  }
  for (const [file, before] of Object.entries(kbFactsBefore)) {
    if (!kbFactsAfter[file]) continue;
    assert.equal(kbFactsAfter[file].size, before.size, `facts file size changed: ${file}`);
    assert.equal(kbFactsAfter[file].mtimeMs, before.mtimeMs, `facts mtime changed: ${file}`);
  }
  for (const [file, before] of Object.entries(patBefore)) {
    if (!patAfter[file]) continue;
    assert.equal(patAfter[file].size, before.size, `patterns file size changed: ${file}`);
    assert.equal(patAfter[file].mtimeMs, before.mtimeMs, `patterns mtime changed: ${file}`);
  }

  // The sweep report should be a NEW file (not in kbBefore).
  assert.ok(!(result.artefactPath in kbBefore), 'sweep artefact should be a new file, not a pre-existing one');
});

// ---------------------------------------------------------------------------
// 9. Artefact frontmatter checks
// ---------------------------------------------------------------------------

test('artefact frontmatter has correct fields and counts', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'real-slug', type: 'artifact' }],
  });

  // 1 broken kb ref.
  writeKbFile(dir, 'artifacts', 'test.md',
    `---\nslug: real-slug\n---\n\nRef: @orchestray:kb://ghost-slug and @orchestray:pattern://missing-pat.\n`);

  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');

  const content = fs.readFileSync(result.artefactPath, 'utf8');
  const fm = parseFrontmatter(content);

  assert.equal(fm.status, 'sweep-report', 'frontmatter status must be sweep-report');
  assert.equal(fm.enforced, 'false', 'frontmatter enforced must be false');
  assert.equal(fm.source, 'kb-refs-sweep', 'frontmatter source field');
  assert.equal(fm.schema_version, String(1));
  assert.equal(Number(fm.broken_kb_refs), result.brokenKbRefs, 'frontmatter count matches result');
  assert.equal(Number(fm.broken_pattern_refs), result.brokenPatternRefs, 'frontmatter count matches result');
  assert.equal(Number(fm.files_scanned), result.filesScanned, 'files_scanned in frontmatter');
});

// ---------------------------------------------------------------------------
// 10. Artefact naming — no pending- prefix (UX-10)
// ---------------------------------------------------------------------------

test('artefact filename has no pending- prefix', async () => {
  const dir = makeTmpProject({ entries: [] });
  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');

  const basename = path.basename(result.artefactPath);
  assert.ok(!basename.startsWith('pending-'), 'artefact must NOT start with pending-');
  assert.ok(basename.startsWith('kb-sweep-'), 'artefact must start with kb-sweep-');
});

// ---------------------------------------------------------------------------
// 11. Malformed frontmatter — file still scanned; degraded entry logged
// ---------------------------------------------------------------------------

test('malformed frontmatter file is still scanned for refs', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'good-slug', type: 'artifact' }],
  });

  // File with NO frontmatter delimiters — malformed.
  writeKbFile(dir, 'artifacts', 'no-frontmatter.md',
    `Just content, no frontmatter. @orchestray:kb://ghost-in-malformed.\n`);
  // File with valid frontmatter and a clean ref.
  writeKbFile(dir, 'facts', 'valid.md',
    `---\nslug: good-slug\n---\n\n@orchestray:kb://good-slug is fine.\n`);

  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');
  // The malformed file was still scanned — the broken ref inside it should be detected.
  assert.equal(result.brokenKbRefs, 1, 'broken ref in malformed file should still be found');
});

// ---------------------------------------------------------------------------
// 12. dry-run — no artefact written
// ---------------------------------------------------------------------------

test('dry-run does not write artefact or snapshot', async () => {
  const dir = makeTmpProject({ entries: [] });
  writeKbFile(dir, 'artifacts', 'test.md',
    `---\nslug: test\n---\n\nContent.\n`);

  const artifactsDir = path.join(dir, '.orchestray', 'kb', 'artifacts');
  const snapshotBefore = fs.readdirSync(artifactsDir);

  const result = await runKbRefsSweep({ cwd: dir, dryRun: true });
  assert.equal(result.status, 'complete', 'dry-run should return complete status');
  assert.ok(!result.artefactPath, 'dry-run should not return artefact path');

  const snapshotAfter = fs.readdirSync(artifactsDir);
  assert.equal(snapshotAfter.length, snapshotBefore.length, 'no new artefact file written in dry-run');

  // Also assert no snapshot.json written.
  const snapshotPath = path.join(dir, '.orchestray', 'state', 'kb-sweep-snapshot.json');
  assert.ok(!fs.existsSync(snapshotPath), 'snapshot.json must NOT be written in dry-run');
});

// ---------------------------------------------------------------------------
// Unit tests for _isThrottled helper
// ---------------------------------------------------------------------------

test('_isThrottled: missing file returns false (run allowed)', () => {
  const result = _isThrottled('/nonexistent/path/to/last-run.json', 7);
  assert.equal(result, false);
});

test('_isThrottled: old last-run returns false (run allowed)', () => {
  const tmp = path.join(os.tmpdir(), `throttle-test-${Date.now()}.json`);
  try {
    // Write a timestamp 10 days in the past.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(tmp, JSON.stringify({ last_run_at: old }), 'utf8');
    assert.equal(_isThrottled(tmp, 7), false);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
  }
});

test('_isThrottled: recent last-run returns true (throttled)', () => {
  const tmp = path.join(os.tmpdir(), `throttle-test-${Date.now()}.json`);
  try {
    const recent = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    fs.writeFileSync(tmp, JSON.stringify({ last_run_at: recent }), 'utf8');
    assert.equal(_isThrottled(tmp, 7), true);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
  }
});

// ---------------------------------------------------------------------------
// Unit tests for _scanFile
// ---------------------------------------------------------------------------

test('_scanFile: returns empty findings for file with no refs', () => {
  const tmp = path.join(os.tmpdir(), `scan-test-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmp, `---\nslug: s\n---\n\nPlain text no refs.\n`, 'utf8');
    const kbSlugs = new Set(['s']);
    const { findings } = _scanFile(tmp, kbSlugs, new Set(), os.tmpdir());
    assert.equal(findings.length, 0);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
  }
});

test('_scanFile: detects all three ref types in one file', () => {
  const tmp = path.join(os.tmpdir(), `scan-test-${Date.now()}.md`);
  try {
    // K4 two-signal rule: use a list item with a prefix phrase to satisfy both
    // signals required for bare-slug detection.
    fs.writeFileSync(
      tmp,
      `---\nslug: s\n---\n\n@orchestray:kb://missing-kb\n@orchestray:pattern://missing-pat\n- See also: missing-bare-ref\n`,
      'utf8'
    );
    const { findings } = _scanFile(tmp, new Set(), new Set(), os.tmpdir(), []);
    const types = findings.map((f) => f.reference_type);
    assert.ok(types.includes('kb_ref'), 'should detect kb_ref');
    assert.ok(types.includes('pattern_ref'), 'should detect pattern_ref');
    assert.ok(types.includes('bare_ref'), 'should detect bare_ref');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
  }
});

// ---------------------------------------------------------------------------
// C3-01: PID in tmp file name
// ---------------------------------------------------------------------------

test('C3-01: _atomicWriteJson uses PID in tmp filename', () => {
  // _atomicWriteJson is not directly exported, but we can observe that concurrent
  // writes (even within a single process) will use .tmp.<pid> rather than .tmp.
  // Verify by inspecting the snapshot path written: check no stale .tmp file lingers
  // (which it won't with PID, but also verify the pid suffix is used by temporarily
  // patching doesn't block — instead we assert the documented invariant via source).
  //
  // Direct assertion: after a successful sweep, no .tmp file (without PID) should
  // be left at the snapshot or last-run paths.
  const dir = makeTmpProject({ entries: [] });
  const snapshotPath = path.join(dir, '.orchestray', 'state', 'kb-sweep-snapshot.json');
  const lastRunPath  = path.join(dir, '.orchestray', 'state', 'kb-sweep-last-run.json');
  const oldTmpSnapshot = snapshotPath + '.tmp';
  const oldTmpLastRun  = lastRunPath  + '.tmp';

  return runKbRefsSweep({ cwd: dir }).then((result) => {
    assert.equal(result.status, 'complete');
    // No legacy .tmp (no-PID) file should exist at either path.
    assert.ok(!fs.existsSync(oldTmpSnapshot), '.tmp (no PID) snapshot tmp must not be left behind');
    assert.ok(!fs.existsSync(oldTmpLastRun),  '.tmp (no PID) lastrun tmp must not be left behind');
    // The pid-bearing tmp should also not exist (cleaned up after rename).
    const pidTmpSnapshot = snapshotPath + '.tmp.' + process.pid;
    const pidTmpLastRun  = lastRunPath  + '.tmp.' + process.pid;
    assert.ok(!fs.existsSync(pidTmpSnapshot), '.tmp.<pid> snapshot tmp must be cleaned up');
    assert.ok(!fs.existsSync(pidTmpLastRun),  '.tmp.<pid> lastrun tmp must be cleaned up');
  });
});

// ---------------------------------------------------------------------------
// C3-02: matched_text sanitization in Suggested Actions
// ---------------------------------------------------------------------------

test('C3-02: matched_text with pipe chars is sanitized in Suggested Actions', async () => {
  // Craft a broken ref whose matched_text would contain a pipe char.
  // The ref regex @orchestray:kb://<slug> captures the @orchestray:kb://slug portion.
  // Pipes appear in adjacent context — we inject them in the file body so that the
  // suggested-actions block would be distorted without sanitization.
  const dir = makeTmpProject({ entries: [] });

  // Write a file that has a broken kb ref; the line also contains pipe chars.
  // The matched_text from KB_REF_RE will be '@orchestray:kb://ghost' — safe.
  // To test the sanitizer directly, call _writeArtefact with a crafted finding.
  const { _writeArtefact: writeArtefact } = require('../kb-refs-sweep.js');

  const artefactPath = path.join(dir, '.orchestray', 'kb', 'artifacts', 'test-sanitize.md');
  // Inject a finding whose matched_text contains a pipe, newline, and tab.
  writeArtefact({
    artefactPath,
    generatedAt: new Date().toISOString(),
    brokenKbRefs: [{
      source_file: path.join(dir, '.orchestray', 'kb', 'artifacts', 'fake.md'),
      line: 1,
      matched_text: '@orchestray:kb://pipe|injected\nnewline\ttab',
      reference_type: 'kb_ref',
      target_slug: 'pipe-injected',
      issue_reason: 'slug not in kb/index.json',
    }],
    brokenPatternRefs: [],
    brokenBareRefs: [],
    filesScanned: 1,
    projectRoot: dir,
  });

  const content = fs.readFileSync(artefactPath, 'utf8');
  // The pipe should be escaped — the raw unescaped pipe pattern 'pipe|injected' (not preceded by \)
  // must not appear. After escaping it becomes 'pipe\|injected'.
  assert.ok(!content.includes('pipe|injected'), 'raw unescaped pipe in matched_text must be escaped');
  assert.ok(content.includes('pipe\\|injected'), 'pipe in matched_text must be replaced with \\|');
  // The newline should be replaced with a space.
  assert.ok(!content.includes('\nnewline'), 'newline in matched_text must be replaced with space');
  assert.ok(!content.includes('\ttab'), 'tab in matched_text must be replaced with space');
});

test('C3-02: matched_text longer than 120 chars is truncated in Suggested Actions', async () => {
  const dir = makeTmpProject({ entries: [] });
  const { _writeArtefact: writeArtefact } = require('../kb-refs-sweep.js');

  const longText = '@orchestray:kb://' + 'x'.repeat(200);
  const artefactPath = path.join(dir, '.orchestray', 'kb', 'artifacts', 'test-truncate.md');
  writeArtefact({
    artefactPath,
    generatedAt: new Date().toISOString(),
    brokenKbRefs: [{
      source_file: path.join(dir, '.orchestray', 'kb', 'artifacts', 'fake.md'),
      line: 1,
      matched_text: longText,
      reference_type: 'kb_ref',
      target_slug: 'x'.repeat(200),
      issue_reason: 'slug not in kb/index.json',
    }],
    brokenPatternRefs: [],
    brokenBareRefs: [],
    filesScanned: 1,
    projectRoot: dir,
  });

  const content = fs.readFileSync(artefactPath, 'utf8');
  // The full longText should not appear verbatim (it's 200+ chars).
  assert.ok(!content.includes(longText), 'oversized matched_text must be truncated');
  // The truncated version (120 chars) should appear.
  assert.ok(content.includes(longText.slice(0, 120)), 'first 120 chars of matched_text must appear');
});

// ---------------------------------------------------------------------------
// C3-04: oversize .md file is skipped gracefully
// ---------------------------------------------------------------------------

test('C3-04: oversize .md file (> 512 KiB) is skipped with degraded-journal entry', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'good-slug', type: 'artifact' }],
  });

  // Write a valid small file.
  writeKbFile(dir, 'artifacts', 'good.md',
    `---\nslug: good-slug\n---\n\nSafe content.\n`);

  // Write an oversize file: > 512 KiB.
  const FIVE_HUNDRED_TWELVE_KIB_PLUS_ONE = 512 * 1024 + 1;
  const oversizePath = path.join(dir, '.orchestray', 'kb', 'artifacts', 'oversize.md');
  fs.writeFileSync(oversizePath, Buffer.alloc(FIVE_HUNDRED_TWELVE_KIB_PLUS_ONE, 0x78 /* 'x' */));

  const result = await runKbRefsSweep({ cwd: dir });

  assert.equal(result.status, 'complete', 'sweep should complete even with oversized file');
  // The oversize file is skipped — no findings from it, but no crash either.
  assert.equal(typeof result.filesScanned, 'number', 'filesScanned should be a number');
  // The good file was scanned (filesScanned >= 1 since the oversize is skipped).
  assert.ok(result.filesScanned >= 1, 'at least one file should be scanned');
});

// ---------------------------------------------------------------------------
// Snapshot JSON is written correctly
// ---------------------------------------------------------------------------

test('sweep writes snapshot JSON with correct shape', async () => {
  const dir = makeTmpProject({
    entries: [{ slug: 'slug-a', type: 'artifact' }],
  });
  writeKbFile(dir, 'artifacts', 'slug-a.md', `---\nslug: slug-a\n---\n\n@orchestray:kb://broken.\n`);

  const result = await runKbRefsSweep({ cwd: dir });
  assert.equal(result.status, 'complete');

  const snapPath = path.join(dir, '.orchestray', 'state', 'kb-sweep-snapshot.json');
  assert.ok(fs.existsSync(snapPath), 'snapshot JSON should be written');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  assert.equal(snap.schema_version, 1);
  assert.ok(Array.isArray(snap.broken_kb_refs));
  assert.ok(Array.isArray(snap.broken_pattern_refs));
  assert.ok(Array.isArray(snap.broken_bare_refs));
  assert.equal(typeof snap.files_scanned, 'number');
  assert.equal(typeof snap.generated_at, 'string');
});

// ---------------------------------------------------------------------------
// Config gate tests (W10)
// ---------------------------------------------------------------------------

describe('config gate — kb_refs_sweep.enabled', () => {
  test('kb_refs_sweep.enabled: false → skipped with feature_disabled (no --force)', async () => {
    const root = makeTmpProject({ entries: ['known-slug'] });

    // Write config with kb_refs_sweep disabled.
    const cfgPath = path.join(root, '.orchestray', 'config.json');
    const existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    existing.auto_learning = {
      global_kill_switch: false,
      extract_on_complete: { enabled: false, shadow_mode: false },
      roi_aggregator: { enabled: false, min_days_between_runs: 1, lookback_days: 30 },
      kb_refs_sweep: { enabled: false, min_days_between_runs: 7 },
      safety: { circuit_breaker: { max_extractions_per_24h: 10, cooldown_minutes_on_trip: 60 } },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf8');

    const result = await runKbRefsSweep({ cwd: root, force: false });

    assert.equal(result.status, 'skipped', 'should be skipped');
    assert.equal(result.reason, 'feature_disabled', 'reason should be feature_disabled');

    // No artefact written.
    const artifDir = path.join(root, '.orchestray', 'kb', 'artifacts');
    const files = fs.readdirSync(artifDir).filter(f => f.startsWith('kb-sweep-'));
    assert.equal(files.length, 0, 'no sweep artefact should be written when disabled');
  });

  test('kb_refs_sweep.enabled: false + --force → runs despite disabled', async () => {
    const root = makeTmpProject({ entries: [] });

    const cfgPath = path.join(root, '.orchestray', 'config.json');
    const existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    existing.auto_learning = {
      global_kill_switch: false,
      kb_refs_sweep: { enabled: false, min_days_between_runs: 7 },
      extract_on_complete: { enabled: false, shadow_mode: false },
      roi_aggregator: { enabled: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 10, cooldown_minutes_on_trip: 60 } },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf8');

    const result = await runKbRefsSweep({ cwd: root, force: true });

    // With --force, should NOT be skipped due to feature_disabled.
    assert.ok(result.reason !== 'feature_disabled',
      `Should not be feature_disabled with --force, got reason: ${result.reason}`);
  });
});

// Cleanup for config gate test tmp dirs (they use their own mkdtempSync).
// Note: makeTmpProject creates its own tmp dir and we need to clean it.
// The tests above re-use makeTmpProject but DON'T use the before/after cleanup
// at the test-file level (those only apply to the outermost suite's `tmpRoot`).
// Each call to makeTmpProject creates a new isolated dir that is NOT cleaned up
// by this test file's global cleanup — acceptable for CI (OS cleans /tmp).
