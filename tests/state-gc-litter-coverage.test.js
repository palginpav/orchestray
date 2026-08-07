'use strict';

/**
 * v2.3.18 W7b (O-3) — mechanical guard against the state-GC list going stale.
 *
 * `MTIME_TTL_GLOBS` has now gone stale twice. v2.3.12 W8 added it for the two
 * families that existed then; by v2.3.18 five more per-run state families had
 * shipped without globs and leaked forever (proven by running `runOnce` against
 * 90-day-old fixtures). Prose in the source did not stop the second occurrence,
 * so this test does it mechanically instead.
 *
 * The scan: every `.orchestray/state/` path in `bin/` whose basename is a fixed
 * prefix concatenated with a runtime id (orchestration id, session id) is
 * per-run litter by construction. Each such prefix must be covered by a glob in
 * `bin/_lib/state-gc.js`. Add the file, add the glob, in the same commit.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const stateGc = require('../bin/_lib/state-gc');

const BIN_DIR = path.join(__dirname, '..', 'bin');

/** Create `name` in `stateDir` with an mtime `ageMs` in the past. */
function materialize(stateDir, name, ageMs) {
  const fp = path.join(stateDir, name);
  fs.writeFileSync(fp, '{}\n');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(fp, t, t);
  return fp;
}

// Prefixes the scan flags that are NOT unbounded per-run litter. Every entry is
// a hole in the guard, so each needs a reason that survives review.
const INTENTIONALLY_UNCOLLECTED = new Map([
  // Keyed by extraction SCOPE, a bounded set — not one file per run. The
  // `.tripped` sentinel is deliberately durable ("survives counter deletion",
  // learning-circuit-breaker.js F-04); a TTL would silently re-arm a breaker
  // somebody tripped on purpose.
  ['learning-breaker-', 'keyed by bounded scope; .tripped is durable by design'],
]);

/** Recursively list `.js` files under `dir`, skipping test directories. */
function listSources(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(fp, out);
    else if (entry.name.endsWith('.js')) out.push(fp);
  }
  return out;
}

// A path segment that means "the state directory": the literal `'state'` inside
// a path.join, or a variable already holding it.
const STATE_DIR_MARKER = /(['"]state['"]|\bstateDir\b|\bSTATE_DIR\b)\s*,/g;

/**
 * Extract per-run state-file prefixes from one source file.
 *
 * Matches the two ways a dynamic basename is built after a state-dir path
 * segment, in either quote style and across line breaks:
 *   path.join(..., 'state', 'claim-ledger-' + orchId + '.jsonl')
 *   path.join(stateDir, `dossier-orphan-counter.${orchId}`)
 *
 * @param {string} src
 * @returns {string[]} prefixes, e.g. ['claim-ledger-']
 */
function extractLitterPrefixes(src) {
  const found = [];
  STATE_DIR_MARKER.lastIndex = 0;
  let m;
  while ((m = STATE_DIR_MARKER.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const tail = src.slice(start, start + 200).replace(/^\s+/, '');
    const concat = /^(['"])([A-Za-z0-9._-]*[-.])\1\s*\+/.exec(tail);
    if (concat) { found.push(concat[2]); continue; }
    const template = /^`([A-Za-z0-9._-]*[-.])\$\{/.exec(tail);
    if (template) found.push(template[1]);
  }
  return found;
}

test('every per-run state-file family in bin/ has a state-gc glob', () => {
  const globs = stateGc.MTIME_TTL_GLOBS;
  const offenders = [];

  for (const file of listSources(BIN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const prefix of extractLitterPrefixes(src)) {
      if (INTENTIONALLY_UNCOLLECTED.has(prefix)) continue;
      // A covering glob starts with the literal prefix — `claim-ledger-*.jsonl`
      // covers `claim-ledger-<orchId>.jsonl`.
      if (globs.some(g => g.startsWith(prefix))) continue;
      offenders.push(prefix + '  (' + path.relative(BIN_DIR, file) + ')');
    }
  }

  assert.deepStrictEqual(
    offenders, [],
    'per-run state files with no MTIME_TTL_GLOBS entry — they leak forever.\n' +
    'Add a glob to bin/_lib/state-gc.js:\n  ' + offenders.join('\n  ')
  );
});

test('runOnce prunes a stale file for EVERY declared glob and keeps fresh ones', () => {
  // Data-driven off MTIME_TTL_GLOBS, so a glob added later is exercised without
  // anyone remembering to write a case for it. Catches a typo'd pattern (a glob
  // present in the list but matching nothing) as well as a missing one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gc-cover-'));
  const stateDir = path.join(root, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const stale = [];
  const fresh = [];
  for (const glob of stateGc.MTIME_TTL_GLOBS) {
    stale.push(materialize(stateDir, glob.replace(/\*/g, 'orch-old'), NINETY_DAYS));
    fresh.push(materialize(stateDir, glob.replace(/\*/g, 'orch-new'), 60 * 1000));
  }
  const unrelated = materialize(stateDir, 'orchestration.md', NINETY_DAYS);

  stateGc.runOnce(root);

  const leaked = stale.filter(fp => fs.existsSync(fp)).map(fp => path.basename(fp));
  assert.deepStrictEqual(leaked, [], 'stale litter must be pruned for every glob');
  const evicted = fresh.filter(fp => !fs.existsSync(fp)).map(fp => path.basename(fp));
  assert.deepStrictEqual(evicted, [], 'fresh litter must survive');
  assert.ok(fs.existsSync(unrelated), 'unrelated state files must be untouched');

  fs.rmSync(root, { recursive: true, force: true });
});

test('the scan actually finds the known families (guard is not vacuous)', () => {
  // If the extractor silently stops matching, the test above passes for the
  // wrong reason. Pin the families we know exist today.
  const seen = new Set();
  for (const file of listSources(BIN_DIR)) {
    for (const p of extractLitterPrefixes(fs.readFileSync(file, 'utf8'))) seen.add(p);
  }
  for (const expected of [
    'claim-ledger-',
    'claim-evidence-warn-count-',
    'companion-warn-count-',
    'roi-missing-dedup-',
    'dossier-orphan-counter.',
    '.gate-22b-warned-',
    '.curator-cursor-reset-',
  ]) {
    assert.ok(seen.has(expected), 'extractor must still find "' + expected + '"');
  }
});
