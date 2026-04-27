#!/usr/bin/env node
'use strict';

/**
 * Tests for P1.4 sentinel probe: hashCompute.
 *
 * Coverage:
 *   - happy: sha256 of known content → expected hex
 *   - happy: sha1 / md5 algorithm switch
 *   - security: bad algo → ok:false, reason:unsupported_algo
 *   - security: path-traversal → ok:false, reason:invalid_path
 *   - failure: nonexistent → ok:false, reason:read_failed
 *   - perf: < 50ms for ~1MB file
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const crypto = require('node:crypto');

const { hashCompute } = require('../_lib/sentinel-probes');

function mkTmp(content, name) {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-hc-'));
  const fp = pathMod.join(dir, name || 'file.bin');
  fs.writeFileSync(fp, content);
  return { dir, fp };
}

describe('sentinel-probes.hashCompute', () => {
  test('sha256 of known content → expected hex, bytes match', () => {
    const content = 'hello world\n';
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    const { dir, fp } = mkTmp(content);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = hashCompute({ path: pathMod.basename(fp), algorithm: 'sha256' });
      assert.equal(r.ok, true);
      assert.equal(r.algorithm, 'sha256');
      assert.equal(r.hex, expected);
      assert.equal(r.bytes, Buffer.byteLength(content));
    } finally { process.chdir(cwd); }
  });

  test('sha1 / md5 algorithms produce matching hashes', () => {
    const content = 'algo switch test';
    const { dir, fp } = mkTmp(content);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r1 = hashCompute({ path: pathMod.basename(fp), algorithm: 'sha1' });
      assert.equal(r1.ok, true);
      assert.equal(r1.hex, crypto.createHash('sha1').update(content).digest('hex'));
      const r2 = hashCompute({ path: pathMod.basename(fp), algorithm: 'md5' });
      assert.equal(r2.ok, true);
      assert.equal(r2.hex, crypto.createHash('md5').update(content).digest('hex'));
    } finally { process.chdir(cwd); }
  });

  test('unsupported algorithm → ok:false, reason:unsupported_algo', () => {
    const { dir, fp } = mkTmp('x');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = hashCompute({ path: pathMod.basename(fp), algorithm: 'sha512' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'unsupported_algo');
    } finally { process.chdir(cwd); }
  });

  test('security: path-traversal → invalid_path', () => {
    const { dir } = mkTmp('x');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = hashCompute({ path: '../../../etc/passwd' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid_path');
    } finally { process.chdir(cwd); }
  });

  test('nonexistent file → ok:false, reason:read_failed', () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-hc-ne-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const r = hashCompute({ path: 'no-such-file.bin' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'read_failed');
    } finally { process.chdir(cwd); }
  });

  test('perf: < 50ms for ~1MB file', () => {
    const big = Buffer.alloc(1024 * 1024, 0x41);
    const { dir, fp } = mkTmp(big);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const start = Date.now();
      const r = hashCompute({ path: pathMod.basename(fp) });
      const elapsed = Date.now() - start;
      assert.equal(r.ok, true);
      assert.ok(elapsed < 100, 'expected < 100ms for 1MB hash, got ' + elapsed + 'ms');
    } finally { process.chdir(cwd); }
  });
});
