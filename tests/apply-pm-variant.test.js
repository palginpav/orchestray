#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/apply-pm-variant.js (T-S3, v2.0.17-E)
 *
 * Coverage:
 *   A — lean config + pristine pm.md → no-op, exit 0
 *   B — fat config + pristine pm.md → pm.md replaced with pm.old.md content, .pm-variant=fat
 *   C — fat config + manually-edited pm.md → refuses (exit 1) without --force
 *   D — fat config + --force + edited pm.md → overwrites + exits 0 with warning
 *   E — --dry-run + fat config → no writes, exit 0
 *   F — back-to-back fat invocations → idempotent (second is a no-op via .pm-variant marker)
 *   G — fat config + missing pm.old.md → exit 2
 *   H — unrecognised variant value in config → exit 3
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const SCRIPT = path.resolve(__dirname, '../bin/apply-pm-variant.js');

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create an isolated tmp directory that mimics a project root with:
 *   .orchestray/config.json   (optional)
 *   .orchestray/state/        (created)
 *   agents/pm.md              (synthetic lean content)
 *   agents/pm.old.md          (synthetic fat content; optional)
 *
 * Returns an object with absolute paths to all relevant files.
 */
function makeProjectDir({
  variant = 'lean',        // pm_prompt_variant value in config
  omitConfig = false,      // skip writing config.json
  editPmMd = false,        // simulate a manual edit of pm.md
  omitPmOld = false,       // do not create pm.old.md
  invalidVariant = false,  // write a bogus variant value
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pv-test-'));
  cleanup.push(dir);

  // Directories
  const orchDir   = path.join(dir, '.orchestray');
  const stateDir  = path.join(orchDir, 'state');
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });

  // config.json
  if (!omitConfig) {
    const configVariant = invalidVariant ? 'bogus-value' : variant;
    fs.writeFileSync(
      path.join(orchDir, 'config.json'),
      JSON.stringify({ pm_prompt_variant: configVariant }, null, 2) + '\n',
      'utf8'
    );
  }

  // agents/pm.md  (lean content)
  const leanContent = '---\nname: pm\n---\n# LEAN PM content\n';
  fs.writeFileSync(path.join(agentsDir, 'pm.md'), leanContent, 'utf8');

  if (editPmMd) {
    // Simulate a manual edit: append extra text so the hash changes.
    fs.appendFileSync(path.join(agentsDir, 'pm.md'), '\n# MANUALLY EDITED\n', 'utf8');
  }

  // agents/pm.old.md  (fat content)
  if (!omitPmOld) {
    const fatContent = '---\nname: pm\n---\n# FAT PM content (pre-strip)\n';
    fs.writeFileSync(path.join(agentsDir, 'pm.old.md'), fatContent, 'utf8');
  }

  return {
    dir,
    orchDir,
    stateDir,
    agentsDir,
    pmPath:       path.join(agentsDir, 'pm.md'),
    pmOldPath:    path.join(agentsDir, 'pm.old.md'),
    pmVariant:    path.join(stateDir, '.pm-variant'),
    pmLeanHash:   path.join(stateDir, '.pm-lean-hash'),
    pmBakPath:    path.join(agentsDir, 'pm.md.bak'),
  };
}

/**
 * Run apply-pm-variant.js in the given project root.
 *
 * @param {string}   cwd    - Project root to use as working directory.
 * @param {string[]} [extra] - Additional CLI flags.
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function run(cwd, extra = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...extra], {
    encoding: 'utf8',
    cwd,
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Read the content of a file (utf8). Returns null if absent.
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (_e) { return null; }
}

/**
 * SHA-256 first-16-hex of a file (mirrors apply-pm-variant.js hashFile).
 * @param {string} filePath
 * @returns {string}
 */
function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ──────────────────────────────────────────────────────────────────────────────
// Test cases
// ──────────────────────────────────────────────────────────────────────────────

describe('apply-pm-variant (T-S3)', () => {

  // A — lean config: no-op, exit 0
  test('A — lean config: exits 0, pm.md unchanged', () => {
    const { dir, pmPath } = makeProjectDir({ variant: 'lean' });

    const before = fs.readFileSync(pmPath, 'utf8');
    const { status, stdout } = run(dir);

    assert.equal(status, 0, 'should exit 0 for lean variant');
    assert.ok(stdout.includes('no change needed'), 'should report no change needed');
    assert.equal(fs.readFileSync(pmPath, 'utf8'), before, 'pm.md must not be modified');
  });

  // B — fat config + pristine pm.md → copy pm.old.md over pm.md
  test('B — fat config + pristine pm.md: copies pm.old.md → pm.md', () => {
    const { dir, pmPath, pmOldPath, pmVariant } = makeProjectDir({ variant: 'fat' });

    const fatContent = fs.readFileSync(pmOldPath, 'utf8');
    const { status, stdout } = run(dir);

    assert.equal(status, 0, 'should exit 0');
    assert.ok(stdout.includes('fat applied'), 'should report fat applied');
    assert.equal(fs.readFileSync(pmPath, 'utf8'), fatContent, 'pm.md should match pm.old.md content');
    assert.equal(readFileSafe(pmVariant), 'fat', '.pm-variant marker should be fat');
  });

  // B2 — fat config + pristine pm.md: backup is created
  test('B2 — fat config: pm.md.bak created with original lean content', () => {
    const { dir, pmPath, pmBakPath } = makeProjectDir({ variant: 'fat' });

    const originalContent = fs.readFileSync(pmPath, 'utf8');
    run(dir);

    assert.ok(fs.existsSync(pmBakPath), 'pm.md.bak should exist');
    assert.equal(fs.readFileSync(pmBakPath, 'utf8'), originalContent, 'pm.md.bak should contain original lean content');
  });

  // C — fat config + manually-edited pm.md → refuse without --force
  test('C — fat config + manually-edited pm.md: refuses without --force, exit 1', () => {
    // Step 1: prime the lean hash by running lean first
    const { dir, stateDir, pmPath, pmLeanHash } = makeProjectDir({ variant: 'lean' });
    run(dir); // seeds .pm-lean-hash

    // Step 2: simulate a manual edit
    fs.appendFileSync(pmPath, '\n# MANUALLY EDITED\n', 'utf8');

    // Step 3: switch config to fat
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ pm_prompt_variant: 'fat' }, null, 2) + '\n',
      'utf8'
    );

    // Step 4: attempt to apply without --force
    const { status, stderr } = run(dir);

    assert.notEqual(status, 0, 'should exit non-zero when pm.md was manually edited');
    assert.ok(stderr.includes('manually edited'), 'stderr should mention manual edit');
    assert.ok(stderr.includes('--force'), 'stderr should suggest --force');
    assert.equal(status, 1, 'exit code should be 1 for manual-edit guard');
  });

  // D — fat config + --force + edited pm.md → overwrites with warning
  test('D — fat config + --force + edited pm.md: overwrites and exits 0', () => {
    const { dir, pmPath, pmOldPath } = makeProjectDir({ variant: 'lean' });
    run(dir); // seed lean hash

    // Manually edit
    fs.appendFileSync(pmPath, '\n# MANUALLY EDITED\n', 'utf8');

    // Switch to fat
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ pm_prompt_variant: 'fat' }, null, 2) + '\n',
      'utf8'
    );

    const fatContent = fs.readFileSync(pmOldPath, 'utf8');
    const { status, stderr } = run(dir, ['--force']);

    assert.equal(status, 0, 'should exit 0 with --force');
    assert.ok(stderr.includes('WARNING'), 'stderr should include a warning');
    assert.equal(fs.readFileSync(pmPath, 'utf8'), fatContent, 'pm.md should be replaced with fat content');
  });

  // E — --dry-run: no writes regardless of variant
  test('E — --dry-run + fat config: exits 0, no files written', () => {
    const { dir, pmPath, pmVariant, pmLeanHash } = makeProjectDir({ variant: 'fat' });
    const before = fs.readFileSync(pmPath, 'utf8');

    const { status, stdout } = run(dir, ['--dry-run']);

    assert.equal(status, 0, 'should exit 0 in dry-run mode');
    assert.ok(stdout.includes('dry-run') || stdout.includes('would copy'), 'should mention dry-run');
    assert.equal(fs.readFileSync(pmPath, 'utf8'), before, 'pm.md must not be modified in dry-run');
    assert.equal(readFileSafe(pmVariant), null, '.pm-variant must not be created in dry-run');
  });

  // E2 — --dry-run + lean config: exits 0, no writes
  test('E2 — --dry-run + lean config: exits 0', () => {
    const { dir, pmPath } = makeProjectDir({ variant: 'lean' });
    const before = fs.readFileSync(pmPath, 'utf8');

    const { status } = run(dir, ['--dry-run']);

    assert.equal(status, 0);
    assert.equal(fs.readFileSync(pmPath, 'utf8'), before, 'pm.md must not be modified in dry-run');
  });

  // F — idempotent: back-to-back fat invocations
  test('F — idempotent: second fat invocation is a no-op', () => {
    const { dir, pmPath, pmVariant } = makeProjectDir({ variant: 'fat' });

    // First invocation: applies the switch.
    const r1 = run(dir);
    assert.equal(r1.status, 0, 'first invocation should succeed');
    const contentAfterFirst = fs.readFileSync(pmPath, 'utf8');
    const markerAfterFirst = readFileSafe(pmVariant);

    // Second invocation: should be a no-op.
    const r2 = run(dir);
    assert.equal(r2.status, 0, 'second invocation should succeed');
    assert.ok(
      r2.stdout.includes('already applied') || r2.stdout.includes('no-op') || r2.stdout.includes('no change'),
      'second invocation should report no-op'
    );
    assert.equal(fs.readFileSync(pmPath, 'utf8'), contentAfterFirst, 'pm.md must not change on second invocation');
    assert.equal(readFileSafe(pmVariant), markerAfterFirst, '.pm-variant marker must not change on second invocation');
  });

  // G — fat config + missing pm.old.md → exit 2
  test('G — fat config + missing pm.old.md: exits 2', () => {
    const { dir } = makeProjectDir({ variant: 'fat', omitPmOld: true });

    const { status, stderr } = run(dir);

    assert.equal(status, 2, 'should exit 2 when pm.old.md is missing');
    assert.ok(stderr.toLowerCase().includes('pm.old.md'), 'stderr should mention pm.old.md');
  });

  // H — unrecognised variant → exit 3
  test('H — unrecognised variant value: exits 3', () => {
    const { dir } = makeProjectDir({ invalidVariant: true });

    const { status, stderr } = run(dir);

    assert.equal(status, 3, 'should exit 3 for unrecognised variant');
    assert.ok(stderr.includes('unrecognised'), 'stderr should mention unrecognised variant');
  });

  // Additional: lean with no config.json — graceful fallback (lean default)
  test('no config.json present: defaults to lean, exits 0', () => {
    const { dir, pmPath } = makeProjectDir({ variant: 'lean', omitConfig: true });
    const before = fs.readFileSync(pmPath, 'utf8');

    const { status } = run(dir);

    assert.equal(status, 0);
    assert.equal(fs.readFileSync(pmPath, 'utf8'), before, 'pm.md must not be modified');
  });

  // Additional: .pm-lean-hash seeded on lean invocation
  test('lean invocation seeds .pm-lean-hash for future integrity checks', () => {
    const { dir, pmPath, pmLeanHash } = makeProjectDir({ variant: 'lean' });

    run(dir);

    const storedHash = readFileSafe(pmLeanHash);
    assert.ok(storedHash, '.pm-lean-hash should be written after lean invocation');
    assert.equal(storedHash.trim(), hashFile(pmPath), '.pm-lean-hash should match current pm.md SHA-256 prefix');
  });

  // F014 — findAgentsDir must reject a dir with only pm.md (no pm.old.md)
  test('F014 — fat config: exits 2 when agents/ has pm.md but no pm.old.md (not an Orchestray dir)', () => {
    // omitPmOld: true leaves agents/pm.md but no agents/pm.old.md — the directory
    // should NOT be accepted as an Orchestray agents dir under the new provenance check.
    const { dir } = makeProjectDir({ variant: 'fat', omitPmOld: true });

    const { status, stderr } = run(dir);

    // findAgentsDir returns null → exits 2 (could not locate agents dir).
    assert.equal(status, 2, 'should exit 2 when agents dir has only pm.md (no pm.old.md)');
    assert.ok(
      stderr.includes('pm.old.md') || stderr.includes('agents/pm.md'),
      'stderr should mention missing file'
    );
  });

  // F019 — fat apply with identical content: no-op, marker still written
  test('F019 — fat apply when pm.md already matches pm.old.md: logs no-op, marker is fat', () => {
    const { dir, pmPath, pmOldPath, pmVariant } = makeProjectDir({ variant: 'fat' });

    // Make pm.md and pm.old.md byte-identical before running.
    const fatContent = fs.readFileSync(pmOldPath, 'utf8');
    fs.writeFileSync(pmPath, fatContent, 'utf8');

    const { status, stdout } = run(dir);

    assert.equal(status, 0, 'should exit 0 on content-identical no-op');
    assert.ok(
      stdout.includes('no-op') || stdout.includes('already matches'),
      'stdout should report no-op'
    );
    // pm.md must remain unchanged.
    assert.equal(fs.readFileSync(pmPath, 'utf8'), fatContent, 'pm.md must not be modified');
    // Marker must still be written.
    assert.equal(readFileSafe(pmVariant), 'fat', '.pm-variant marker should be fat');
  });

});
