#!/usr/bin/env node
'use strict';

/**
 * Tests for P1.4 sentinel probe: gitStatus.
 *
 * Coverage:
 *   - happy: clean repo → clean:true
 *   - happy: dirty repo (untracked) → clean:false, untracked includes file
 *   - failure: non-git directory → ok:false, reason:not_a_git_repo
 *   - security: paths arg with `..` → ok:false, reason:invalid_path
 *   - perf: < 50ms in clean repo
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { execFileSync } = require('node:child_process');

const { gitStatus } = require('../_lib/sentinel-probes');

function mkGitRepo() {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-gs-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(pathMod.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('sentinel-probes.gitStatus', () => {
  test('clean repo → ok, clean:true, all arrays empty', () => {
    const repo = mkGitRepo();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const r = gitStatus({});
      assert.equal(r.ok, true);
      assert.equal(r.clean, true);
      assert.deepEqual(r.modified, []);
      assert.deepEqual(r.untracked, []);
      assert.deepEqual(r.staged, []);
    } finally { process.chdir(cwd); }
  });

  test('dirty repo (untracked file) → clean:false, untracked has file', () => {
    const repo = mkGitRepo();
    fs.writeFileSync(pathMod.join(repo, 'new.txt'), 'hi\n');
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const r = gitStatus({});
      assert.equal(r.ok, true);
      assert.equal(r.clean, false);
      assert.ok(r.untracked.includes('new.txt'), 'untracked should include new.txt');
    } finally { process.chdir(cwd); }
  });

  test('non-git directory → ok:false, reason:not_a_git_repo', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-nogs-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = gitStatus({});
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not_a_git_repo');
    } finally { process.chdir(cwd); }
  });

  test('security: paths arg with `..` → invalid_path', () => {
    const repo = mkGitRepo();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const r = gitStatus({ paths: ['../../../etc/passwd'] });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid_path');
    } finally { process.chdir(cwd); }
  });

  test('perf: < 50ms in clean small repo', () => {
    const repo = mkGitRepo();
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      // Warm git binary cache.
      gitStatus({});
      const start = Date.now();
      const r = gitStatus({});
      const elapsed = Date.now() - start;
      assert.equal(r.ok, true);
      assert.ok(elapsed < 200, 'expected < 200ms for clean repo, got ' + elapsed + 'ms');
    } finally { process.chdir(cwd); }
  });
});
