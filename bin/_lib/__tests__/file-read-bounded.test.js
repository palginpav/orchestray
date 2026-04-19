#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/file-read-bounded.js.
 *
 * Verifies the four contract outcomes:
 *   1. Under-cap: file smaller than maxBytes → ok:true, content correct
 *   2. At-cap: file exactly maxBytes → ok:true, content correct
 *   3. Over-cap: file larger than maxBytes → ok:false, reason:'file_too_large'
 *   4. Non-existent file → ok:false, reason:'read_failed'
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readFileBounded } = require('../file-read-bounded');

function mkTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frb-'));
  const filePath = path.join(dir, 'test.txt');
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('readFileBounded', () => {
  test('under-cap: returns ok:true with correct content', () => {
    const content = 'hello world';
    const filePath = mkTmpFile(content);
    const result = readFileBounded(filePath, 1024);
    assert.equal(result.ok, true);
    assert.equal(result.content, content);
  });

  test('at-cap: file exactly maxBytes returns ok:true', () => {
    const content = 'a'.repeat(100);
    const filePath = mkTmpFile(content);
    const result = readFileBounded(filePath, 100);
    assert.equal(result.ok, true);
    assert.equal(result.content, content);
  });

  test('over-cap: file larger than maxBytes returns ok:false with file_too_large', () => {
    const content = 'b'.repeat(101);
    const filePath = mkTmpFile(content);
    const result = readFileBounded(filePath, 100);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'file_too_large');
    assert.ok(typeof result.size_hint === 'number', 'size_hint should be a number');
  });

  test('non-existent file returns ok:false with read_failed', () => {
    const result = readFileBounded('/does/not/exist/file.txt', 1024);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'read_failed');
    assert.ok(result.err !== undefined, 'err field should be present');
  });
});
