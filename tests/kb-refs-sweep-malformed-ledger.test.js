'use strict';

/**
 * v2.3.12 W11 (B3) — kb-refs-sweep self-heal: skip_paths + per-run summary.
 *
 * _scanFile batches malformed files into a collector (instead of per-file emit)
 * and honors skip_paths. config-schema surfaces the skip_paths default.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sweep = require('../bin/kb-refs-sweep');
const { loadAutoLearningConfig } = require('../bin/_lib/config-schema');

function mkfile(dir, name, content) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, content);
  return fp;
}

test('config-schema kb_refs_sweep.skip_paths defaults to legacy prefixes', () => {
  const c = loadAutoLearningConfig(process.cwd());
  assert.ok(Array.isArray(c.kb_refs_sweep.skip_paths));
  assert.ok(c.kb_refs_sweep.skip_paths.includes('2012-'));
  assert.ok(c.kb_refs_sweep.skip_paths.includes('2013-'));
});

test('_scanFile batches malformed file into collector, skips matched paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sweep-'));
  const good = mkfile(dir, 'good.md', '---\ntitle: x\n---\nbody\n');
  const bad = mkfile(dir, 'bad.md', 'no frontmatter here\n');
  const legacy = mkfile(dir, '2012-legacy.md', 'no frontmatter either\n');

  const kbSlugs = new Set();
  const patSlugs = new Set();
  const collector = [];
  const opts = { skipPaths: ['2012-'], malformedCollector: collector };

  sweep._scanFile(good, kbSlugs, patSlugs, dir, [], opts);
  sweep._scanFile(bad, kbSlugs, patSlugs, dir, [], opts);
  sweep._scanFile(legacy, kbSlugs, patSlugs, dir, [], opts);

  assert.deepStrictEqual(collector, [bad], 'only the non-skipped malformed file is collected');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_scanFile back-compat: no collector → per-file path still works (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sweep-'));
  const bad = mkfile(dir, 'bad.md', 'no frontmatter\n');
  // No opts at all — legacy signature must not throw.
  assert.doesNotThrow(() => sweep._scanFile(bad, new Set(), new Set(), dir, []));
  fs.rmSync(dir, { recursive: true, force: true });
});
