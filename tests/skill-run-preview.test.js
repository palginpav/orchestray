#!/usr/bin/env node
'use strict';

/**
 * Tests for W8 (UX2): /orchestray:run --preview flag handling.
 *
 * The SKILL.md itself is a static markdown file processed by Claude Code — we
 * can't do a full PM round-trip in unit tests. Instead, we scope the tests to:
 *   1. The flag detection logic (does "--preview" appear in a given $ARGUMENTS).
 *   2. The stripping logic (correct task description extracted after stripping "--preview").
 *   3. The PREVIEW MODE instruction block is present and well-formed in SKILL.md.
 *   4. The SKILL.md frontmatter is valid.
 *
 * For the PM-side behaviour (no state files, no spawns), see tier1-orchestration.md §6.T.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills', 'orchestray:run', 'SKILL.md');

// ---------------------------------------------------------------------------
// Helpers: replicate the flag-detection + strip logic as pure JS
// These mirror what a bash-based or PM-based preprocessor would do.
// ---------------------------------------------------------------------------

/**
 * Detect --preview flag in an arguments string.
 * Matches "--preview" as a standalone token (space or start/end bounded).
 * @param {string} args
 * @returns {boolean}
 */
function hasPreviewFlag(args) {
  return /(?:^|\s)--preview(?:\s|$)/.test(args);
}

/**
 * Strip --preview from the arguments string and trim.
 * @param {string} args
 * @returns {string}
 */
function stripPreviewFlag(args) {
  return args.replace(/(?:^|\s)--preview(?:\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tests: flag detection
// ---------------------------------------------------------------------------

describe('--preview flag detection', () => {
  test('detects --preview at the start', () => {
    assert.ok(hasPreviewFlag('--preview add a new user endpoint'));
  });

  test('detects --preview at the end', () => {
    assert.ok(hasPreviewFlag('add a new user endpoint --preview'));
  });

  test('detects --preview in the middle', () => {
    assert.ok(hasPreviewFlag('add a new user --preview endpoint'));
  });

  test('does not false-positive on --preview-mode (different token)', () => {
    assert.ok(!hasPreviewFlag('--preview-mode add endpoint'));
  });

  test('does not false-positive on text containing preview without dashes', () => {
    assert.ok(!hasPreviewFlag('show preview of the changes'));
  });

  test('detects --preview when it is the only argument', () => {
    assert.ok(hasPreviewFlag('--preview'));
  });

  test('detects --preview surrounded by multiple spaces', () => {
    assert.ok(hasPreviewFlag('add endpoint   --preview   please'));
  });
});

// ---------------------------------------------------------------------------
// Tests: flag stripping
// ---------------------------------------------------------------------------

describe('--preview flag stripping', () => {
  test('strips from start, leaving task description', () => {
    const result = stripPreviewFlag('--preview add a new user endpoint');
    assert.strictEqual(result, 'add a new user endpoint');
  });

  test('strips from end, leaving task description', () => {
    const result = stripPreviewFlag('add a new user endpoint --preview');
    assert.strictEqual(result, 'add a new user endpoint');
  });

  test('strips from middle, leaving task description without double spaces', () => {
    const result = stripPreviewFlag('add a new user --preview endpoint');
    assert.strictEqual(result, 'add a new user endpoint');
  });

  test('strips when --preview is the only token, leaving empty string', () => {
    const result = stripPreviewFlag('--preview');
    assert.strictEqual(result, '');
  });

  test('preserves quoted task prose after stripping', () => {
    const input = '--preview "implement the auth flow with OAuth2"';
    const result = stripPreviewFlag(input);
    assert.strictEqual(result, '"implement the auth flow with OAuth2"');
  });

  test('strips --preview and trims surrounding whitespace', () => {
    const input = '  --preview   refactor the payment module  ';
    const result = stripPreviewFlag(input);
    // After strip + trim: "refactor the payment module"
    assert.ok(result.includes('refactor the payment module'), 'task preserved');
    assert.ok(!result.includes('--preview'), '--preview removed');
    assert.ok(!result.startsWith(' '), 'no leading space');
    assert.ok(!result.endsWith(' '), 'no trailing space');
  });
});

// ---------------------------------------------------------------------------
// Tests: SKILL.md content validation
// ---------------------------------------------------------------------------

describe('skills/orchestray:run/SKILL.md', () => {
  let content;

  test('file exists', () => {
    assert.ok(fs.existsSync(SKILL_PATH), 'SKILL.md exists at expected path');
    content = fs.readFileSync(SKILL_PATH, 'utf8');
  });

  test('frontmatter has disable-model-invocation: true', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('disable-model-invocation: true'),
      'disable-model-invocation: true is present'
    );
  });

  test('frontmatter has argument-hint that references --preview', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('--preview'),
      'argument-hint or content references --preview'
    );
  });

  test('PREVIEW MODE instruction block is present', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('PREVIEW MODE'),
      'PREVIEW MODE instruction block exists'
    );
  });

  test('PREVIEW MODE comment is present (v2.2.4: predicate forces escalate, verbose block removed)', () => {
    // v2.2.4 topology fix: --preview forces decision: "escalate" inside decideRoute(),
    // so the slash command dispatches PM directly. The verbose no-spawn / no-state /
    // cost-formula block moved to pm.md §PREVIEW. SKILL.md retains only a comment.
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('PREVIEW MODE'),
      'PREVIEW MODE comment still present'
    );
  });

  test('Routing Protocol section dispatches PM directly on escalate', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('Routing Protocol'),
      'Routing Protocol section present (v2.2.4 dispatcher)'
    );
    assert.ok(
      content.includes('subagent_type="pm"'),
      'PM spawn call present on escalate path'
    );
  });

  test('predicate CLI invocation is present', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('pm-router-cli.js'),
      'predicate CLI call present in routing step'
    );
  });

  test('SKILL.md references /orchestray:run re-issue pattern', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    // v2.2.4: predicate handles --preview stripping. Slash command passes $ARGUMENTS
    // through; no "without --preview" prose needed in SKILL.md because the predicate
    // forces escalate on --preview. The re-issue instruction now lives in the PM.
    assert.ok(
      content.includes('/orchestray:run'),
      '/orchestray:run is referenced in SKILL.md'
    );
  });

  test('standard routing instructions present (v2.2.4)', () => {
    if (!content) content = fs.readFileSync(SKILL_PATH, 'utf8');
    // v2.2.4: decomposition/scoring lives in pm.md. SKILL.md is now a dispatcher.
    // Assert the dispatcher step structure is present.
    assert.ok(
      content.includes('Step 1'),
      'Step 1 (Read config) present in routing protocol'
    );
    assert.ok(
      content.includes('Step 4'),
      'Step 4 (Branch on decision) present in routing protocol'
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: skills/orchestray:redo/SKILL.md content validation
// ---------------------------------------------------------------------------

describe('skills/orchestray:redo/SKILL.md', () => {
  const REDO_SKILL_PATH = path.join(REPO_ROOT, 'skills', 'orchestray:redo', 'SKILL.md');
  let content;

  test('file exists', () => {
    assert.ok(fs.existsSync(REDO_SKILL_PATH), 'redo SKILL.md exists');
    content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
  });

  test('frontmatter has disable-model-invocation: true', () => {
    if (!content) content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
    assert.ok(content.includes('disable-model-invocation: true'));
  });

  test('frontmatter has name: redo', () => {
    if (!content) content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
    assert.ok(content.includes('name: redo'));
  });

  test('documents OQ-TA-2 batch-confirm behaviour', () => {
    if (!content) content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('batch-confirm') || content.includes('single y/N'),
      'documents batch-confirm (OQ-TA-2)'
    );
  });

  test('documents guard for no active orchestration', () => {
    if (!content) content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
    assert.ok(
      content.includes('No active orchestration') ||
      content.includes('only works on the currently active'),
      'guard message is documented'
    );
  });

  test('documents --cascade flag', () => {
    if (!content) content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
    assert.ok(content.includes('--cascade'), '--cascade documented');
  });

  test('documents --prompt flag', () => {
    if (!content) content = fs.readFileSync(REDO_SKILL_PATH, 'utf8');
    assert.ok(content.includes('--prompt'), '--prompt documented');
  });
});

// ---------------------------------------------------------------------------
// Tests: tier1-orchestration.md §6.T
// ---------------------------------------------------------------------------

describe('tier1-orchestration.md §6.T', () => {
  // W5 split: §6.T content moved to tier1-orchestration-rare.md.
  // Tests scan both files so the suite passes regardless of which file hosts the content.
  const TIER1_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'tier1-orchestration.md');
  const TIER1_RARE_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'tier1-orchestration-rare.md');

  function getCombinedContent() {
    let c = '';
    try { c += fs.readFileSync(TIER1_PATH, 'utf8'); } catch (_e) { /* ok */ }
    try { c += '\n' + fs.readFileSync(TIER1_RARE_PATH, 'utf8'); } catch (_e) { /* ok */ }
    return c;
  }

  test('§6.T section exists', () => {
    const content = getCombinedContent();
    assert.ok(
      content.includes('6.T') && content.includes('Preview and Redo'),
      '§6.T section present in tier1-orchestration.md or tier1-orchestration-rare.md'
    );
  });

  test('§6.T documents cost formula', () => {
    const content = getCombinedContent();
    assert.ok(content.includes('base_cost'), 'cost formula base_cost present');
    assert.ok(content.includes('model_multiplier'), 'cost formula multiplier present');
    assert.ok(content.includes('0.25'), 'XS cost constant present');
    assert.ok(content.includes('2.2'), 'opus multiplier present');
  });

  test('§6.T documents redo.pending flow', () => {
    const content = getCombinedContent();
    assert.ok(content.includes('redo.pending'), 'redo.pending referenced');
  });

  test('§6.T documents NEW commit (no amend) rule', () => {
    const content = getCombinedContent();
    assert.ok(
      content.includes('never an amend') || content.includes('not an amend') ||
      content.includes('never amend') || content.includes('NEW commit'),
      'no-amend rule present'
    );
  });
});
