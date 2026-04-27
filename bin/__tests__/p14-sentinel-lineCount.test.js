#!/usr/bin/env node
'use strict';

/**
 * Tests for P1.4 sentinel probe: lineCount.
 *
 * Coverage:
 *   - happy: 100-line file → ok, lines:100
 *   - cap: file > max_bytes → ok:false, reason:file_too_large
 *   - security: path-traversal → ok:false, reason:invalid_path
 *   - failure: nonexistent → ok:false, reason:read_failed
 *   - perf: < 30ms for ~1MB
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const { lineCount } = require('../_lib/sentinel-probes');

function mkTmp(content, name) {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-lc-'));
  const fp = pathMod.join(dir, name || 'file.txt');
  fs.writeFileSync(fp, content);
  return { dir, fp };
}

describe('sentinel-probes.lineCount', () => {
  test('100-line file → lines:100, capped:false', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push('line ' + i);
    const content = lines.join('\n') + '\n';
    const { dir, fp } = mkTmp(content);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = lineCount({ path: pathMod.basename(fp) });
      assert.equal(r.ok, true);
      assert.equal(r.lines, 100);
      assert.equal(r.capped, false);
      assert.ok(r.bytes > 0);
    } finally { process.chdir(cwd); }
  });

  test('over-cap (max_bytes=10) → ok:false, reason:file_too_large', () => {
    const { dir, fp } = mkTmp('x'.repeat(1000));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = lineCount({ path: pathMod.basename(fp), max_bytes: 10 });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'file_too_large');
    } finally { process.chdir(cwd); }
  });

  test('nonexistent → ok:false, reason:read_failed', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-lc-ne-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = lineCount({ path: 'no-such-file.txt' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'read_failed');
    } finally { process.chdir(cwd); }
  });

  test('security: `..` traversal → invalid_path', () => {
    const { dir } = mkTmp('hello\n');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = lineCount({ path: '../../../etc/passwd' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid_path');
    } finally { process.chdir(cwd); }
  });

  test('perf: < 30ms for ~1MB file', () => {
    const big = 'a'.repeat(1024 * 1024 - 1) + '\n';
    const { dir, fp } = mkTmp(big);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const start = Date.now();
      const r = lineCount({ path: pathMod.basename(fp) });
      const elapsed = Date.now() - start;
      assert.equal(r.ok, true);
      assert.ok(elapsed < 30, 'expected < 30ms for 1MB, got ' + elapsed + 'ms');
    } finally { process.chdir(cwd); }
  });
});
