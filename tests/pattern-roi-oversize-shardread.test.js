'use strict';

/**
 * v2.3.12 W12 (B6) — readBoundedTail returns the most-recent whole lines from
 * an oversize file, discarding the partial leading line.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _internal } = require('../bin/pattern-roi-aggregate.js');
const { readBoundedTail } = _internal;

test('readBoundedTail returns whole tail, drops partial leading line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-roi-'));
  const fp = path.join(dir, 'events.jsonl');
  // Build a file with 1000 lines; each ~100 bytes.
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    lines.push(JSON.stringify({ type: 'x', i, pad: 'y'.repeat(80) }));
  }
  fs.writeFileSync(fp, lines.join('\n') + '\n');

  const size = fs.statSync(fp).size;
  const tail = readBoundedTail(fp, Math.floor(size / 4)); // ~last quarter
  const tailLines = tail.split('\n').filter(Boolean);

  // Every returned line must parse cleanly (no partial leading fragment).
  for (const l of tailLines) {
    assert.doesNotThrow(() => JSON.parse(l), `tail line must be whole JSON: ${l.slice(0, 40)}`);
  }
  // Tail must contain the very last record and be a strict suffix.
  assert.ok(tailLines.length > 0 && tailLines.length < 1000);
  assert.strictEqual(JSON.parse(tailLines[tailLines.length - 1]).i, 999);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readBoundedTail returns full content when file smaller than cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-roi-'));
  const fp = path.join(dir, 'small.jsonl');
  fs.writeFileSync(fp, '{"a":1}\n{"a":2}\n');
  const tail = readBoundedTail(fp, 1024 * 1024);
  assert.strictEqual(tail, '{"a":1}\n{"a":2}\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
