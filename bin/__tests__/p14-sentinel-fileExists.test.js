#!/usr/bin/env node
'use strict';

/**
 * Tests for P1.4 sentinel probe: fileExists.
 *
 * Coverage:
 *   - happy: existing file → {ok:true, exists:true, kind:'file'}
 *   - happy: existing dir → {ok:true, exists:true, kind:'dir'}
 *   - happy: nonexistent → {ok:true, exists:false, kind:null}
 *   - security: path-traversal → {ok:false, reason:'invalid_path'}
 *   - perf: 100 calls < 5 ms each on average
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const { fileExists } = require('../_lib/sentinel-probes');

function mkTmpProject() {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-fe-'));
  // Place a file and a subdir under the tmp project.
  fs.writeFileSync(pathMod.join(dir, 'sample.txt'), 'hello\n');
  fs.mkdirSync(pathMod.join(dir, 'subdir'));
  return dir;
}

describe('sentinel-probes.fileExists', () => {
  test('existing file → exists:true, kind:file', () => {
    const dir = mkTmpProject();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = fileExists({ path: 'sample.txt' });
      assert.equal(r.ok, true);
      assert.equal(r.exists, true);
      assert.equal(r.kind, 'file');
    } finally { process.chdir(cwd); }
  });

  test('existing dir → exists:true, kind:dir', () => {
    const dir = mkTmpProject();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = fileExists({ path: 'subdir' });
      assert.equal(r.ok, true);
      assert.equal(r.exists, true);
      assert.equal(r.kind, 'dir');
    } finally { process.chdir(cwd); }
  });

  test('nonexistent path → exists:false, kind:null (success negative)', () => {
    const dir = mkTmpProject();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = fileExists({ path: 'no-such-file.txt' });
      assert.equal(r.ok, true);
      assert.equal(r.exists, false);
      assert.equal(r.kind, null);
    } finally { process.chdir(cwd); }
  });

  test('security: path-traversal `..` → ok:false, reason:invalid_path', () => {
    const dir = mkTmpProject();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = fileExists({ path: '../../../etc/passwd' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid_path');
    } finally { process.chdir(cwd); }
  });

  test('perf: 100 calls average < 5ms each', () => {
    const dir = mkTmpProject();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const start = Date.now();
      for (let i = 0; i < 100; i++) fileExists({ path: 'sample.txt' });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 500, 'expected 100 calls < 500ms, got ' + elapsed + 'ms');
    } finally { process.chdir(cwd); }
  });
});
