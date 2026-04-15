#!/usr/bin/env node
'use strict';

/**
 * W9 — T2 F5 regression: `missingRequiredToolsFromRows([], [...])` must
 * return the FULL requiredSet (not `[]`).
 *
 * The pre-v2.0.15 implementation had an early `return []` on empty rows,
 * which inverted the semantic: "nothing missing" when in fact everything
 * was missing. That guard was removed in v2.0.15.
 *
 * Contract after fix:
 *   - `missingRequiredToolsFromRows([], requiredSet)` returns the full requiredSet.
 *   - `missingRequiredToolsFromRows(rows, [])` always returns `[]` (nothing required).
 *   - Normal matching (non-empty rows, non-empty set) still works.
 *
 * Source: bin/_lib/mcp-checkpoint.js:187-193 (JSDoc and implementation).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { missingRequiredToolsFromRows } = require('../../bin/_lib/mcp-checkpoint.js');

describe('W9 T2 F5 regression — missingRequiredToolsFromRows empty-array contract', () => {

  test('empty rows + non-empty requiredSet → returns full requiredSet (F5 core)', () => {
    const required = ['mcp__orchestray__pattern_find', 'mcp__orchestray__kb_search'];
    const result = missingRequiredToolsFromRows([], required);
    assert.deepEqual(result, required,
      'empty rows means all required tools are missing — must return full requiredSet');
  });

  test('empty rows + single-element requiredSet → returns that element', () => {
    const result = missingRequiredToolsFromRows([], ['mcp__orchestray__pattern_find']);
    assert.deepEqual(result, ['mcp__orchestray__pattern_find']);
  });

  test('empty rows + empty requiredSet → returns empty array', () => {
    const result = missingRequiredToolsFromRows([], []);
    assert.deepEqual(result, [],
      'nothing required → nothing missing, even with empty rows');
  });

  test('non-empty rows covering all required tools → returns empty array', () => {
    const rows = [
      { tool: 'mcp__orchestray__pattern_find', phase: 'pre-decomposition' },
      { tool: 'mcp__orchestray__kb_search',    phase: 'pre-decomposition' },
    ];
    const required = ['mcp__orchestray__pattern_find', 'mcp__orchestray__kb_search'];
    const result = missingRequiredToolsFromRows(rows, required, 'pre-decomposition');
    assert.deepEqual(result, [],
      'all required tools covered → nothing missing');
  });

  test('non-empty rows covering partial set → returns only the uncovered tools', () => {
    const rows = [
      { tool: 'mcp__orchestray__pattern_find', phase: 'pre-decomposition' },
    ];
    const required = ['mcp__orchestray__pattern_find', 'mcp__orchestray__kb_search'];
    const result = missingRequiredToolsFromRows(rows, required, 'pre-decomposition');
    assert.deepEqual(result, ['mcp__orchestray__kb_search'],
      'only uncovered tool must be returned');
  });

  test('rows with wrong phase are ignored — tool remains "missing"', () => {
    const rows = [
      { tool: 'mcp__orchestray__pattern_find', phase: 'post-decomposition' },
    ];
    const required = ['mcp__orchestray__pattern_find'];
    const result = missingRequiredToolsFromRows(rows, required, 'pre-decomposition');
    assert.deepEqual(result, ['mcp__orchestray__pattern_find'],
      'rows whose phase does not match phaseFilter are excluded');
  });

  test('phase filter null disables phase filtering — all rows count', () => {
    const rows = [
      { tool: 'mcp__orchestray__pattern_find', phase: 'post-decomposition' },
    ];
    const required = ['mcp__orchestray__pattern_find'];
    const result = missingRequiredToolsFromRows(rows, required, null);
    assert.deepEqual(result, [],
      'with phaseFilter=null, rows of any phase satisfy the requirement');
  });

});
