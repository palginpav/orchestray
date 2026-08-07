'use strict';

// Slice-loading kill switches name a `.md.legacy` monolith as their atomic rollback
// target — e.g. `curator_slice_loading.enabled: false` loads agents/curator.md.legacy,
// and `phase_slice_loading.enabled: false` loads pm-reference/tier1-orchestration.md.legacy.
//
// The installer filtered top-level agent files on `endsWith('.md')`, which silently
// dropped `curator.md.legacy`: it shipped in the npm tarball but reached no install.
// Flipping that kill switch left the curator with no definition at all — the rollback
// failed exactly when it was needed. Files under agents/*/ were unaffected because the
// subdirectory copy takes everything, which is why the PM's legacy monolith worked and
// masked the gap.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

function legacyFilesAtTopLevel() {
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md.legacy'));
}

describe('installer ships .md.legacy rollback targets', () => {
  test('the repo actually has top-level .md.legacy files (guard against vacuous pass)', () => {
    const found = legacyFilesAtTopLevel();
    assert.ok(
      found.length > 0,
      'no top-level agents/*.md.legacy files found — if these were intentionally removed, '
        + 'delete this test and the kill-switch rows in pm.md that reference them.',
    );
  });

  test('the installer filter accepts .md.legacy, not just .md', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'install.js'), 'utf8');
    // Locate the top-level agents/ filter and assert it admits .md.legacy.
    const m = src.match(/const agentFiles = fs\.readdirSync\(agentsDir\)[\s\S]{0,200}?;/);
    assert.ok(m, 'could not locate the agentFiles filter in bin/install.js');
    assert.ok(
      m[0].includes('.md.legacy'),
      'bin/install.js top-level agents filter does not admit .md.legacy — kill-switch '
        + `rollback targets (${legacyFilesAtTopLevel().join(', ')}) will not be installed.`,
    );
  });

  test('every kill-switch legacy target named in pm.md exists in the repo', () => {
    const pm = fs.readFileSync(path.join(AGENTS_DIR, 'pm.md'), 'utf8');
    const referenced = [...pm.matchAll(/agents\/([A-Za-z0-9._/-]+\.md\.legacy)/g)]
      .map((x) => x[1]);
    assert.ok(referenced.length > 0, 'pm.md references no .md.legacy rollback targets');
    const missing = referenced.filter(
      (rel) => !fs.existsSync(path.join(AGENTS_DIR, rel)),
    );
    assert.deepStrictEqual(
      missing,
      [],
      `pm.md documents rollback target(s) that do not exist: ${missing.join(', ')}`,
    );
  });
});
