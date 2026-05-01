#!/usr/bin/env node
'use strict';

/**
 * T20 kill-switch Default column lint (v2.2.21)
 *
 * Parses KILL_SWITCHES.md and asserts that every table entry across all
 * sections has a Default column whose value is one of the canonical set:
 *   default-on | default-off | shadow | hard-block-opt-in
 *
 * This test catches future entries that are added without a Default value,
 * preventing KILL_SWITCHES.md from drifting back to a state where operators
 * cannot tell what is on or off by default.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const KILL_SWITCHES_MD = path.join(ROOT, 'KILL_SWITCHES.md');

const VALID_DEFAULT_VALUES = new Set(['default-on', 'default-off', 'shadow', 'hard-block-opt-in']);

// ---------------------------------------------------------------------------
// Parser: find all markdown table data rows across the entire file.
// A data row must:
//   - start with |
//   - not be a header row (| Feature ...)
//   - not be a separator row (| --- ...)
// Returns { feature, defaultValue, lineNumber } for each row.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ feature: string, defaultValue: string, lineNumber: number }} TableRow
 */

/**
 * Parse all table data rows from KILL_SWITCHES.md.
 * @param {string} content
 * @returns {TableRow[]}
 */
function parseAllTableRows(content) {
  const rows = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Skip header rows
    if (trimmed.startsWith('| Feature') || trimmed.startsWith('| ---') || trimmed.startsWith('|---')) continue;
    // Skip separator rows (cells are all dashes/spaces)
    if (/^\|[-| ]+\|$/.test(trimmed)) continue;

    const parts = trimmed.split('|').map(p => p.trim());
    // parts[0] = '' (before leading pipe), parts[1] = Feature, ..., parts[last-1] = Default, parts[last] = ''
    if (parts.length < 3) continue;
    const feature = parts[1];
    if (!feature) continue;
    // Default is the last non-empty cell
    const defaultValue = parts[parts.length - 2];
    rows.push({ feature, defaultValue, lineNumber: i + 1 });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KILL_SWITCHES.md Default column lint', () => {

  test('KILL_SWITCHES.md exists', () => {
    assert.ok(fs.existsSync(KILL_SWITCHES_MD), `${KILL_SWITCHES_MD} must exist`);
  });

  test('at least 50 table entries exist (sanity check)', () => {
    const content = fs.readFileSync(KILL_SWITCHES_MD, 'utf8');
    const rows = parseAllTableRows(content);
    assert.ok(
      rows.length >= 50,
      `Expected at least 50 table entries, found ${rows.length} — possible parser regression`
    );
  });

  test('every table entry has a valid Default column value', () => {
    const content = fs.readFileSync(KILL_SWITCHES_MD, 'utf8');
    const rows = parseAllTableRows(content);
    const invalid = rows.filter(r => !VALID_DEFAULT_VALUES.has(r.defaultValue));
    const messages = invalid.map(
      r => `  line ${r.lineNumber}: "${r.feature}" — got Default="${r.defaultValue}" (must be one of: ${[...VALID_DEFAULT_VALUES].join(', ')})`
    );
    assert.equal(
      invalid.length,
      0,
      `${invalid.length} table row(s) have missing or invalid Default values:\n${messages.join('\n')}`
    );
  });

});
