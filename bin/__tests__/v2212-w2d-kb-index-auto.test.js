#!/usr/bin/env node
'use strict';

/**
 * v2212-w2d-kb-index-auto.test.js — W2d KB-INDEX-AUTO (v2.2.12).
 *
 * Tests for the auto-append behaviour added to bin/redirect-kb-write.js.
 *
 * Coverage:
 *   1. Write to artifacts/test-foo.md → entry appended to index.json
 *   2. Write again (same slug) → no duplicate (idempotent)
 *   3. ORCHESTRAY_KB_INDEX_AUTO_DISABLED=1 → no auto-append
 *   4. File with `# My Title` H1 → entry title is "My Title"
 *   5. File with no H1 → title falls back to humanised slug
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const HOOK      = path.resolve(__dirname, '..', 'redirect-kb-write.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2212-w2d-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-w2d-kb-index-auto' }),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');

  return dir;
}

function writeKbFile(dir, bucket, slug, content) {
  const filePath = path.join(dir, '.orchestray', 'kb', bucket, slug + '.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function runHook(tmpDir, filePath, extraEnv = {}, content = 'test content') {
  const payload = JSON.stringify({
    cwd: tmpDir,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
  });

  // Write the actual file so deriveTitle can read it
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }

  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ORCHESTRAY_PLUGIN_ROOT: REPO_ROOT,
      ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1',
      ...extraEnv,
    },
  });

  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  const events = readJsonlFile(eventsPath);

  let stdout = {};
  try { stdout = JSON.parse(result.stdout || '{}'); } catch (_e) { stdout = {}; }

  return { stdout, stderr: result.stderr || '', events, exitCode: result.status };
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function readIndex(tmpDir) {
  const indexPath = path.join(tmpDir, '.orchestray', 'kb', 'index.json');
  if (!fs.existsSync(indexPath)) return null;
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2212-w2d KB-INDEX-AUTO', () => {

  test('1. Write to artifacts/test-foo.md → entry appended to index.json', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'artifacts', 'test-foo.md');
    const { stdout } = runHook(tmpDir, filePath, {}, '# Test Foo\nsome content');

    assert.strictEqual(stdout.continue, true, 'continue must be true');

    const index = readIndex(tmpDir);
    assert.ok(index, 'index.json must exist after write');
    assert.ok(Array.isArray(index.entries), 'index.entries must be array');

    const entry = index.entries.find((e) => e.slug === 'test-foo');
    assert.ok(entry, 'entry with slug "test-foo" must be present');
    assert.strictEqual(entry.type, 'artifact');
    assert.strictEqual(entry.path, '.orchestray/kb/artifacts/test-foo.md');
    assert.ok(typeof entry.created_at === 'string', 'created_at must be a string');
  });

  test('2. Write again with same slug → no duplicate (idempotent)', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'artifacts', 'test-foo.md');

    runHook(tmpDir, filePath, {}, '# Test Foo\nsome content');
    runHook(tmpDir, filePath, {}, '# Test Foo updated\nmore content');

    const index = readIndex(tmpDir);
    const matches = index.entries.filter((e) => e.slug === 'test-foo');
    assert.strictEqual(matches.length, 1, 'exactly one entry for slug "test-foo" (idempotent)');
  });

  test('3. ORCHESTRAY_KB_INDEX_AUTO_DISABLED=1 → no auto-append', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'artifacts', 'test-bar.md');

    runHook(tmpDir, filePath, { ORCHESTRAY_KB_INDEX_AUTO_DISABLED: '1' }, '# Test Bar');

    const index = readIndex(tmpDir);
    // index.json may not exist at all, or may exist but without the entry
    if (index) {
      const entry = (index.entries || []).find((e) => e.slug === 'test-bar');
      assert.ok(!entry, 'no entry for "test-bar" when kill switch is on');
    }
    // If index doesn't exist at all, that also satisfies the kill-switch requirement
  });

  test('4. File with `# My Title` H1 → entry title is "My Title"', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'facts', 'titled-entry.md');
    runHook(tmpDir, filePath, {}, '# My Title\nsome body text');

    const index = readIndex(tmpDir);
    const entry = (index && index.entries || []).find((e) => e.slug === 'titled-entry');
    assert.ok(entry, 'entry must exist');
    assert.strictEqual(entry.title, 'My Title', 'title must be extracted from H1');
  });

  test('5. File with no H1 → title falls back to humanised slug', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'facts', 'no-heading-entry.md');
    runHook(tmpDir, filePath, {}, 'Just some plain text without a heading.');

    const index = readIndex(tmpDir);
    const entry = (index && index.entries || []).find((e) => e.slug === 'no-heading-entry');
    assert.ok(entry, 'entry must exist');
    // humanised form: "facts/no-heading-entry" with hyphens replaced by spaces
    assert.ok(
      typeof entry.title === 'string' && entry.title.length > 0,
      'title must be a non-empty string'
    );
    assert.ok(!entry.title.startsWith('# '), 'title must not include # prefix');
    // falls back to "<bucket>/<slug>" with [-_] → space
    assert.ok(entry.title.includes('no heading entry') || entry.title.includes('facts/no heading entry'),
      `title should be humanised slug, got: ${entry.title}`);
  });

});
