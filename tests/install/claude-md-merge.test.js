#!/usr/bin/env node
'use strict';

/**
 * SB2 fix tests: _mergeCompactInstructionsIntoCLAUDEmd
 *
 * Tests three cases:
 *   (a) No CLAUDE.md in project root → created with ## Compact Instructions section.
 *   (b) CLAUDE.md exists but lacks the marker → section appended.
 *   (c) CLAUDE.md already has the marker → unchanged (idempotent).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Pull out the function under test directly.  The installer is not designed
// to be required as a module (it runs on require), so we extract just the
// relevant helper via a lightweight shim.
// ---------------------------------------------------------------------------

/**
 * Extract the _mergeCompactInstructionsIntoCLAUDEmd function from install.js
 * without executing the install side-effects.
 */
function loadMergeFn() {
  // Read the source and extract the function definition.
  const src = fs.readFileSync(require.resolve('../../bin/install.js'), 'utf8');
  // We define the helper in a function scope and return it.
  // This avoids the module's top-level install invocation.
  const fnMatch = src.match(
    /function _mergeCompactInstructionsIntoCLAUDEmd[\s\S]*?^}/m
  );
  if (!fnMatch) {
    throw new Error('_mergeCompactInstructionsIntoCLAUDEmd not found in install.js');
  }
  // Build an eval'd version in a safe context.
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'fs', 'path', 'console', `
    ${fnMatch[0]}
    return _mergeCompactInstructionsIntoCLAUDEmd;
  `)(require, fs, path, console);
  return fn;
}

const IDEMPOTENCY_MARKER = '**Authoritative post-compact recovery source:**';

/**
 * Create a temporary project directory and a minimal package CLAUDE.md
 * that contains a ## Compact Instructions section with the marker.
 */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-'));
  const pkgClaudeMd = path.join(dir, 'PKG_CLAUDE.md');
  fs.writeFileSync(pkgClaudeMd, [
    '# Orchestray Plugin',
    '',
    '## Compact Instructions',
    '',
    'When summarizing this conversation during auto-compaction or `/compact`, ALWAYS preserve:',
    '',
    '- **Current orchestration state**: orchestration_id, phase',
    '',
    IDEMPOTENCY_MARKER + ' `.orchestray/state/resilience-dossier.json`. Recovery details here.',
    '',
    'May be compacted more aggressively:',
    '- Intermediate tool output',
    '',
    '## Other Section',
    '',
    'Other content.',
  ].join('\n'));
  return { dir, pkgClaudeMd };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SB2 — _mergeCompactInstructionsIntoCLAUDEmd', () => {
  test('case (a): no CLAUDE.md → file created containing the section and marker', () => {
    const mergeFn = loadMergeFn();
    const { dir, pkgClaudeMd } = setup();
    const projectRoot = path.join(dir, 'project-a');
    fs.mkdirSync(projectRoot);

    // No CLAUDE.md exists yet.
    assert.ok(!fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));

    mergeFn(pkgClaudeMd, projectRoot);

    const result = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
    assert.ok(result.includes('## Compact Instructions'), 'created file must contain section header');
    assert.ok(result.includes(IDEMPOTENCY_MARKER), 'created file must contain idempotency marker');
  });

  test('case (b): CLAUDE.md without marker → section appended', () => {
    const mergeFn = loadMergeFn();
    const { dir, pkgClaudeMd } = setup();
    const projectRoot = path.join(dir, 'project-b');
    fs.mkdirSync(projectRoot);
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');

    const originalContent = '# My Project\n\nSome existing content.\n';
    fs.writeFileSync(claudeMdPath, originalContent);

    mergeFn(pkgClaudeMd, projectRoot);

    const result = fs.readFileSync(claudeMdPath, 'utf8');
    // Original content must be preserved.
    assert.ok(result.includes('# My Project'), 'original content must be preserved');
    assert.ok(result.includes('Some existing content.'), 'original content must be preserved');
    // Section must have been appended.
    assert.ok(result.includes('## Compact Instructions'), 'section must be appended');
    assert.ok(result.includes(IDEMPOTENCY_MARKER), 'idempotency marker must be appended');
    // The appended text must come after the original.
    assert.ok(
      result.indexOf('Some existing content.') < result.indexOf(IDEMPOTENCY_MARKER),
      'original content must precede appended section'
    );
  });

  test('case (c): CLAUDE.md already has the marker → unchanged', () => {
    const mergeFn = loadMergeFn();
    const { dir, pkgClaudeMd } = setup();
    const projectRoot = path.join(dir, 'project-c');
    fs.mkdirSync(projectRoot);
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');

    const contentWithMarker = [
      '# My Project',
      '',
      '## Compact Instructions',
      '',
      IDEMPOTENCY_MARKER + ' `.orchestray/state/resilience-dossier.json`. Already here.',
      '',
      'More content.',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, contentWithMarker);

    const statBefore = fs.statSync(claudeMdPath);
    // Small sleep to ensure mtime would change if file is written.
    // Node test runner: use sync approach — check content equality instead.
    mergeFn(pkgClaudeMd, projectRoot);

    const result = fs.readFileSync(claudeMdPath, 'utf8');
    // Content must be exactly unchanged.
    assert.equal(result, contentWithMarker, 'file must be unchanged when marker already present');
    // mtime should not have changed (file was not rewritten).
    const statAfter = fs.statSync(claudeMdPath);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, 'mtime must not change for idempotent run');
  });
});
