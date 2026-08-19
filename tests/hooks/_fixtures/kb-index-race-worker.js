#!/usr/bin/env node
'use strict';

/**
 * Worker process for the redirect-kb-write.js index-race regression test
 * (tests/hooks/redirect-kb-write-race.test.js).
 *
 * Runs as a standalone OS process (spawned by the test, not required
 * in-process) so the race is real inter-process contention, not an
 * in-process Promise race Node's single-threaded event loop would mask.
 *
 * Usage: node kb-index-race-worker.js <mode> <indexPath> <slug> <delayMs>
 *   mode: "unlocked" — pre-fix autoAppendKbIndex logic (verbatim, no lock),
 *         reproduces the lost-update race documented in
 *         .orchestray/kb/artifacts/v2330-kb-index-drift-diagnosis.md Finding 3.
 *   mode: "locked"   — the real, fixed autoAppendKbIndex from
 *         bin/redirect-kb-write.js (module.exports), which now serialises
 *         via the shared _withAdvisoryLock primitive on index.json.lock.
 *
 * `delayMs` is injected between the index.json read and write (both modes)
 * so a two-process race reliably overlaps instead of depending on OS
 * scheduling luck.
 */

const fs = require('fs');
const path = require('path');

const mode = process.argv[2];
const indexPath = process.argv[3];
const slug = process.argv[4];
const delayMs = Number(process.argv[5] || 0);

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (mode === 'unlocked') {
  // Verbatim pre-fix logic: plain read-JSON -> mutate -> write-JSON, no lock.
  let parsed;
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') process.exit(1);
    parsed = { version: '1.0', created_at: new Date().toISOString(), entries: [] };
  }
  if (!Array.isArray(parsed.entries)) parsed.entries = [];

  // Simulate work between read and write (I/O, hashing, etc. in the real hook).
  sleepMs(delayMs);

  parsed.entries.push({ slug, title: slug, type: 'artifact', path: 'artifacts/' + slug + '.md', created_at: new Date().toISOString() });

  const tmpPath = indexPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, indexPath);
  process.exit(0);
} else if (mode === 'locked') {
  const cwd = path.resolve(indexPath, '..', '..', '..');
  const filePath = path.join(cwd, '.orchestray', 'kb', 'artifacts', slug + '.md');

  // Inject the same artificial delay while the fixed code holds the lock, by
  // patching fs.readFileSync to sleep only when reading this test's index
  // file. This is a test-harness technique only — it does not modify
  // bin/redirect-kb-write.js. It proves two real processes serialise: the
  // second process's lock-acquire retries block until the first releases.
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(p, ...rest) {
    if (p === indexPath) sleepMs(delayMs);
    return origReadFileSync.call(fs, p, ...rest);
  };

  const { autoAppendKbIndex } = require('../../../bin/redirect-kb-write.js');
  autoAppendKbIndex(cwd, filePath, slug, 'artifacts');
  process.exit(0);
} else {
  process.stderr.write('unknown mode: ' + mode + '\n');
  process.exit(1);
}
