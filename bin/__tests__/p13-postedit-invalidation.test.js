#!/usr/bin/env node
'use strict';

/**
 * P1.3 PostToolUse(Edit) hook regenerates BOTH shadow + tier2-index (v2.2.0).
 *
 * Asserts that running bin/regen-schema-shadow-hook.js with an Edit payload
 * targeting event-schemas.md regenerates BOTH:
 *   - agents/pm-reference/event-schemas.shadow.json
 *   - agents/pm-reference/event-schemas.tier2-index.json
 * and that they share the same _meta.source_hash.
 *
 * Editing a different file does NOT trigger regen of either.
 *
 * The hook exits 0 in all cases (fail-open).
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_BIN  = path.join(REPO_ROOT, 'bin', 'regen-schema-shadow-hook.js');
const SCHEMAS_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

function makeTmpClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-postedit-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMAS_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  return dir;
}

function runHook(cwd, payload) {
  return spawnSync('node', [HOOK_BIN], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ORCHESTRAY_PROJECT_ROOT: cwd },
  });
}

describe('P1.3 PostToolUse(Edit) hook regenerates both shadow and tier2-index', () => {
  test('Edit on event-schemas.md regenerates both files with matching source_hash', () => {
    const cwd = makeTmpClone();
    const filePath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md');
    const r = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);

    const shadowPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const indexPath  = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.tier2-index.json');
    assert.ok(fs.existsSync(shadowPath), 'shadow file must be generated');
    assert.ok(fs.existsSync(indexPath),  'tier2-index file must be generated');

    const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
    const index  = JSON.parse(fs.readFileSync(indexPath,  'utf8'));
    assert.ok(shadow._meta && shadow._meta.source_hash);
    assert.ok(index._meta && index._meta.source_hash);
    assert.equal(shadow._meta.source_hash, index._meta.source_hash,
      'shadow and tier2-index must agree on source_hash');
  });

  test('Edit on a different file does NOT trigger regen of either output', () => {
    const cwd = makeTmpClone();
    const r = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'agents', 'pm.md') },
    });
    assert.equal(r.status, 0);

    const shadowPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const indexPath  = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.tier2-index.json');
    assert.equal(fs.existsSync(shadowPath), false,
      'unrelated Edit must not produce a shadow regen');
    assert.equal(fs.existsSync(indexPath), false,
      'unrelated Edit must not produce a tier2-index regen');
  });

  test('hook exits 0 even if a side-effect fails (fail-open isolation)', () => {
    // Create a malformed event-schemas.md (no ### headers) so parse throws.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-postedit-fail-'));
    fs.mkdirSync(path.join(cwd, 'agents', 'pm-reference'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md'),
      '# nothing parseable here\n',
    );
    const r = runHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md') },
    });
    // Both shadow and tier2-index regen will fail. The hook must still exit 0.
    assert.equal(r.status, 0,
      'fail-open: hook must exit 0 even when regen fails. stderr=' + r.stderr);
  });
});
