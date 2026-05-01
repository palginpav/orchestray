#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/jsonl-rotate.js — rotation direction invariant.
 *
 * Verifies F-08a finding: .3.jsonl is OLDEST, .1.jsonl is most recently
 * rotated, active (unsuffixed) is the live file.
 *
 * v2.2.21 W4-T18: test that catches the rotation-direction inversion described
 * in T2 debugger finding F-08a.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { appendJsonlWithRotation, _rotatedPath, _shiftGenerations } = require('../bin/_lib/jsonl-rotate');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-rotate-dir-test-'));
}

describe('jsonl-rotate direction invariant', () => {
  test('.1 is most recently rotated, .N is oldest', () => {
    const dir      = makeTmpDir();
    const filePath = path.join(dir, 'test.jsonl');

    // Write three distinct generations so we can distinguish them by content.
    // Simulate three manual rotations by:
    //   1. Write "gen-A" content → active
    //   2. Rotate → gen-A goes to .1
    //   3. Write "gen-B" content → active
    //   4. Rotate → gen-B goes to .1, gen-A goes to .2
    //   5. Write "gen-C" content → active
    //   6. Rotate → gen-C goes to .1, gen-B goes to .2, gen-A goes to .3

    const maxGenerations = 3;

    // Step 1: Write gen-A (oldest content) to active.
    fs.writeFileSync(filePath, JSON.stringify({ gen: 'A', seq: 1 }) + '\n');

    // Step 2: Rotate (shifts active → .1).
    _shiftGenerations(filePath, maxGenerations);

    // Step 3: Write gen-B to active.
    fs.writeFileSync(filePath, JSON.stringify({ gen: 'B', seq: 2 }) + '\n');

    // Step 4: Rotate (active→.1, old .1→.2).
    _shiftGenerations(filePath, maxGenerations);

    // Step 5: Write gen-C to active.
    fs.writeFileSync(filePath, JSON.stringify({ gen: 'C', seq: 3 }) + '\n');

    // Step 6: Rotate (active→.1, old .1→.2, old .2→.3).
    _shiftGenerations(filePath, maxGenerations);

    // Verify: .1 is most recent (gen-C), .2 is gen-B, .3 is oldest (gen-A).
    const gen1 = JSON.parse(fs.readFileSync(_rotatedPath(filePath, 1), 'utf8').trim());
    const gen2 = JSON.parse(fs.readFileSync(_rotatedPath(filePath, 2), 'utf8').trim());
    const gen3 = JSON.parse(fs.readFileSync(_rotatedPath(filePath, 3), 'utf8').trim());

    // .1 should be the MOST RECENTLY rotated (gen-C, seq 3).
    assert.equal(gen1.gen, 'C', '.1.jsonl must hold the most recently rotated content');
    assert.equal(gen1.seq, 3,   '.1.jsonl seq must be 3 (most recent)');

    // .2 should be gen-B (intermediate).
    assert.equal(gen2.gen, 'B', '.2.jsonl must hold intermediate content');
    assert.equal(gen2.seq, 2,   '.2.jsonl seq must be 2');

    // .3 should be the OLDEST (gen-A, seq 1).
    assert.equal(gen3.gen, 'A', '.3.jsonl must hold the oldest content');
    assert.equal(gen3.seq, 1,   '.3.jsonl seq must be 1 (oldest)');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('oldest generation is dropped when maxGenerations is exceeded', () => {
    const dir      = makeTmpDir();
    const filePath = path.join(dir, 'test.jsonl');
    const maxGenerations = 2; // Keep only 2 rotated files.

    // Write and rotate 3 times — 3rd rotation should drop the oldest (.2 before rename).
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(filePath, JSON.stringify({ seq: i }) + '\n');
      _shiftGenerations(filePath, maxGenerations);
    }

    // .1 should be seq=3 (most recent), .2 should be seq=2.
    // seq=1 (the oldest) should have been dropped.
    const gen1 = JSON.parse(fs.readFileSync(_rotatedPath(filePath, 1), 'utf8').trim());
    const gen2 = JSON.parse(fs.readFileSync(_rotatedPath(filePath, 2), 'utf8').trim());

    assert.equal(gen1.seq, 3, '.1 must be most recent');
    assert.equal(gen2.seq, 2, '.2 must be the second most recent');

    // The file that would have been .3 should not exist (dropped).
    const gen3Path = _rotatedPath(filePath, 3);
    assert.equal(
      fs.existsSync(gen3Path),
      false,
      '.3 should not exist when maxGenerations=2'
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('appendJsonlWithRotation triggers rotation when size cap is hit', () => {
    const dir      = makeTmpDir();
    const filePath = path.join(dir, 'data.jsonl');

    // Use a tiny size cap so we trigger rotation after the first line.
    const opts = { maxSizeBytes: 1, maxGenerations: 3 };

    const recA = { gen: 'A', content: 'first' };
    const recB = { gen: 'B', content: 'second' };

    // First append: file is new, no rotation.
    appendJsonlWithRotation(filePath, recA, opts);

    // Second append: file now exceeds maxSizeBytes → rotation triggers.
    appendJsonlWithRotation(filePath, recB, opts);

    // Active file should contain recB only.
    const activeLines = fs.readFileSync(filePath, 'utf8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    assert.equal(activeLines.length, 1, 'active file should have 1 line after rotation');
    assert.equal(activeLines[0].gen, 'B', 'active file should contain the newer record');

    // .1 should contain recA (the pre-rotation content).
    const gen1Lines = fs.readFileSync(_rotatedPath(filePath, 1), 'utf8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    assert.equal(gen1Lines.length, 1, '.1 should have 1 line');
    assert.equal(gen1Lines[0].gen, 'A', '.1 must hold the content that was in active before rotation');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('active file is unsuffixed; .N.jsonl suffix pattern is correct', () => {
    const dir      = makeTmpDir();
    const filePath = path.join(dir, 'events.jsonl');

    // Write and rotate once.
    fs.writeFileSync(filePath, JSON.stringify({ x: 1 }) + '\n');
    _shiftGenerations(filePath, 3);
    fs.writeFileSync(filePath, JSON.stringify({ x: 2 }) + '\n');

    // Active file must exist and be named without suffix.
    assert.ok(fs.existsSync(filePath), 'active file must exist at the unsuffixed path');

    // .1 must follow the N.jsonl pattern.
    const gen1Path = _rotatedPath(filePath, 1);
    assert.ok(gen1Path.endsWith('.1.jsonl'), '.1 path must end with .1.jsonl, got: ' + gen1Path);
    assert.ok(fs.existsSync(gen1Path), '.1.jsonl must exist after one rotation');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
