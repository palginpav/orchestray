'use strict';

/**
 * v2.3.12 W13 (B4) — release-completeness gate.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.resolve(__dirname, '..', 'bin/release-manager/gate-release-completeness.js');
const { extractReleaseVersion, changelogSection, findDeferral } = require(GATE);

// ---- unit ----

test('extractReleaseVersion parses inline release commits only', () => {
  assert.strictEqual(extractReleaseVersion('git commit -m "release: v2.3.12"'), '2.3.12');
  assert.strictEqual(extractReleaseVersion("git commit -m 'release: v2.3.12 — notes'"), '2.3.12');
  assert.strictEqual(extractReleaseVersion('git commit -m "fix: something"'), null);
  assert.strictEqual(extractReleaseVersion('cat bin/gate-developer-git.js'), null);
  assert.strictEqual(extractReleaseVersion('grep release CHANGELOG.md'), null);
});

test('changelogSection + DEFERRAL_RE', () => {
  const cl = '# Changelog\n\n## v2.3.12\n- fixed X\n- shipped Y\n\n## v2.3.11\n- old\n';
  const sec = changelogSection(cl, '2.3.12');
  assert.ok(sec.includes('fixed X'));
  assert.ok(!sec.includes('old'));
  assert.ok(findDeferral('we deferred to next release').matched);
  assert.ok(!findDeferral('- fixed X\n- shipped Y').matched);
  // review F1: benign prose with no release cue near a non-strict phrase is NOT flagged.
  assert.ok(!findDeferral('this output format is stable and supported.').matched);
});

// ---- integration ----

function mkRepo({ pkgVer, versionFile, changelog }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-rel-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: pkgVer }));
  fs.writeFileSync(path.join(dir, 'VERSION'), versionFile);
  if (changelog != null) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function runGate(dir, command, env = {}) {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    cwd: dir,
    encoding: 'utf8',
    timeout: 10000,
    // Ack README so the check doesn't depend on a real git repo in the temp dir.
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ORCHESTRAY_RELEASE_NO_README: '1', ...env },
  });
}

const GOOD_CL = '# Changelog\n\n## v1.2.3\n- shipped the thing\n';

test('complete release commit passes (exit 0)', () => {
  const dir = mkRepo({ pkgVer: '1.2.3', versionFile: '1.2.3\n', changelog: GOOD_CL });
  const r = runGate(dir, 'git commit -m "release: v1.2.3"');
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('VERSION file absent → package.json is authoritative (exit 0)', () => {
  const dir = mkRepo({ pkgVer: '1.2.3', versionFile: '1.2.3\n', changelog: GOOD_CL });
  fs.rmSync(path.join(dir, 'VERSION')); // simulate install-generated/untracked VERSION
  const r = runGate(dir, 'git commit -m "release: v1.2.3"');
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('version mismatch blocks (exit 2)', () => {
  const dir = mkRepo({ pkgVer: '1.2.2', versionFile: '1.2.3\n', changelog: GOOD_CL });
  const r = runGate(dir, 'git commit -m "release: v1.2.3"');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /version parity/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing CHANGELOG entry blocks (exit 2)', () => {
  const dir = mkRepo({ pkgVer: '1.2.3', versionFile: '1.2.3\n', changelog: '# Changelog\n\n## v1.0.0\n- old\n' });
  const r = runGate(dir, 'git commit -m "release: v1.2.3"');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /CHANGELOG/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deferral language in CHANGELOG blocks (exit 2)', () => {
  const dir = mkRepo({ pkgVer: '1.2.3', versionFile: '1.2.3\n', changelog: '# Changelog\n\n## v1.2.3\n- did X; rest deferred to next release\n' });
  const r = runGate(dir, 'git commit -m "release: v1.2.3"');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /deferral language/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-release commit is ignored (exit 0)', () => {
  const dir = mkRepo({ pkgVer: '9.9.9', versionFile: '0.0.0\n', changelog: null });
  const r = runGate(dir, 'git commit -m "fix: a bug"');
  assert.strictEqual(r.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kill switch bypasses (exit 0 even when incomplete)', () => {
  const dir = mkRepo({ pkgVer: '0.0.0', versionFile: '0.0.0\n', changelog: null });
  const r = runGate(dir, 'git commit -m "release: v1.2.3"', { ORCHESTRAY_RELEASE_GATE_DISABLED: '1' });
  assert.strictEqual(r.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate never references npm publish in its code path output', () => {
  const dir = mkRepo({ pkgVer: '1.2.3', versionFile: '1.2.3\n', changelog: GOOD_CL });
  const r = runGate(dir, 'git commit -m "release: v1.2.3"');
  // publish reminder may appear on stderr, but the gate must not have run a publish.
  assert.ok(!/npm publish (executed|running|done)/i.test(r.stderr + r.stdout));
  fs.rmSync(dir, { recursive: true, force: true });
});
