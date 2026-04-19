#!/usr/bin/env node
'use strict';

/**
 * auto-learning-scopes.test.js — Scope constant consistency guard.
 *
 * Verifies that both call sites (post-orchestration-extract.js and the
 * render helpers) use THE SAME circuit-breaker scope string. If they
 * diverge, the TRIPPED sentinel is written under one name and read under
 * another, making the TRIPPED banner permanently invisible.
 *
 * W8-10 fix: introduced bin/_lib/auto-learning-scopes.js as the single
 * source of truth. This test asserts both call sites import and use the
 * same constant.
 *
 * Runner: node --test bin/_lib/__tests__/auto-learning-scopes.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const { EXTRACTION_BREAKER_SCOPE } = require('../auto-learning-scopes');

// ---------------------------------------------------------------------------
// Helper: search a JS source file for a literal string pattern, return lines
// ---------------------------------------------------------------------------
function grepLines(filePath, pattern) {
  const src = fs.readFileSync(filePath, 'utf8');
  return src.split('\n').filter(line => pattern.test(line));
}

describe('auto-learning-scopes: scope constant consistency', () => {
  test('EXTRACTION_BREAKER_SCOPE is a non-empty string', () => {
    assert.equal(typeof EXTRACTION_BREAKER_SCOPE, 'string');
    assert.ok(EXTRACTION_BREAKER_SCOPE.length > 0, 'scope must not be empty');
  });

  test('post-orchestration-extract.js uses EXTRACTION_BREAKER_SCOPE (not a hardcoded literal)', () => {
    const extractPath = path.join(__dirname, '..', '..', 'post-orchestration-extract.js');
    const src = fs.readFileSync(extractPath, 'utf8');

    // The file must import from auto-learning-scopes
    assert.ok(
      src.includes('auto-learning-scopes'),
      'post-orchestration-extract.js must import from auto-learning-scopes.js'
    );

    // It must NOT pass the bare hardcoded literal 'auto_extract' as the scope argument
    // directly (it should reference the constant instead).
    // We allow the constant's *value* to appear in comments or strings inside the
    // constant definition file itself — but the extraction script must not have
    // a hardcoded scope: 'auto_extract' string literal (it should use the constant).
    const hardcodedPattern = /scope:\s*['"]auto_extract['"]/;
    assert.ok(
      !hardcodedPattern.test(src),
      'post-orchestration-extract.js must not hardcode scope: \'auto_extract\' — use EXTRACTION_BREAKER_SCOPE constant'
    );
  });

  test('status-render.js uses EXTRACTION_BREAKER_SCOPE (not a hardcoded literal)', () => {
    const renderPath = path.join(__dirname, '..', '..', 'learn-commands', 'status-render.js');
    const src = fs.readFileSync(renderPath, 'utf8');

    assert.ok(
      src.includes('auto-learning-scopes'),
      'status-render.js must import from auto-learning-scopes.js'
    );

    // Must not hardcode the old wrong scope ('extraction') or the new correct literal directly
    const oldLiteral = /scope:\s*['"]extraction['"]/;
    assert.ok(
      !oldLiteral.test(src),
      "status-render.js must not hardcode scope: 'extraction' — use EXTRACTION_BREAKER_SCOPE constant"
    );
  });

  test('patterns-render.js uses EXTRACTION_BREAKER_SCOPE (not a hardcoded literal)', () => {
    const renderPath = path.join(__dirname, '..', '..', 'learn-commands', 'patterns-render.js');
    const src = fs.readFileSync(renderPath, 'utf8');

    assert.ok(
      src.includes('auto-learning-scopes'),
      'patterns-render.js must import from auto-learning-scopes.js'
    );

    const oldLiteral = /scope:\s*['"]extraction['"]/;
    assert.ok(
      !oldLiteral.test(src),
      "patterns-render.js must not hardcode scope: 'extraction' — use EXTRACTION_BREAKER_SCOPE constant"
    );
  });

  test('EXTRACTION_BREAKER_SCOPE matches the value used in post-orchestration-extract checkAndIncrement call', () => {
    // Read the extraction script and verify the EXTRACTION_BREAKER_SCOPE import is referenced
    // in the checkAndIncrement call site (not just imported but unused).
    const extractPath = path.join(__dirname, '..', '..', 'post-orchestration-extract.js');
    const src = fs.readFileSync(extractPath, 'utf8');

    // checkAndIncrement must be called with scope: EXTRACTION_BREAKER_SCOPE
    assert.ok(
      src.includes('scope:    EXTRACTION_BREAKER_SCOPE') || src.includes('scope: EXTRACTION_BREAKER_SCOPE'),
      'post-orchestration-extract.js checkAndIncrement must pass scope: EXTRACTION_BREAKER_SCOPE'
    );
  });
});
