#!/usr/bin/env node
'use strict';

/**
 * T20 kill-switch alphabetization lint (v2.2.21)
 *
 * Parses KILL_SWITCHES.md and asserts that §1 (Orchestration core) and
 * §6 (Telemetry & audit) table entries are sorted case-insensitive ASCII.
 *
 * Backtick/punctuation entries sort by their ASCII value, which places
 * them before letters — the test enforces the same comparison used in
 * localeCompare with sensitivity:'variant' disabled (plain charCodeAt
 * ordering on lowercased strings).
 *
 * This test catches future drift when new entries are added without
 * verifying sort order.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const KILL_SWITCHES_MD = path.join(ROOT, 'KILL_SWITCHES.md');

// ---------------------------------------------------------------------------
// Parser: extract table rows from a named section.
// Returns the Feature column (first column) for every data row (skips
// the header and separator rows).
// ---------------------------------------------------------------------------

/**
 * Extract section content between two h2 headings.
 * @param {string} content - full file content
 * @param {string} sectionHeading - e.g. "## 1. Orchestration core"
 * @returns {string} lines belonging to the section (until next ## or EOF)
 */
function extractSection(content, sectionHeading) {
  const lines = content.split('\n');
  let inSection = false;
  const result = [];
  for (const line of lines) {
    if (line.startsWith('## ') && inSection) break; // next section
    if (line.startsWith(sectionHeading)) { inSection = true; continue; }
    if (inSection) result.push(line);
  }
  return result.join('\n');
}

/**
 * Extract Feature column values from a markdown table section.
 * Skips the header row (starts with "| Feature") and the separator row (---|).
 * @param {string} sectionContent
 * @returns {string[]}
 */
function extractFeatureNames(sectionContent) {
  const features = [];
  for (const line of sectionContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (trimmed.startsWith('| Feature') || trimmed.startsWith('|---') || trimmed.startsWith('| ---')) continue;
    // Extract first column
    const parts = trimmed.split('|');
    if (parts.length < 2) continue;
    const feature = parts[1].trim();
    if (feature) features.push(feature);
  }
  return features;
}

/**
 * Check that an array of strings is sorted case-insensitive ASCII ascending.
 * Returns the first out-of-order pair, or null if sorted correctly.
 * @param {string[]} items
 * @returns {{ prev: string, curr: string, index: number } | null}
 */
function findFirstOutOfOrder(items) {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1].toLowerCase();
    const curr = items[i].toLowerCase();
    if (prev > curr) {
      return { prev: items[i - 1], curr: items[i], index: i };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KILL_SWITCHES.md alphabetization lint', () => {

  test('KILL_SWITCHES.md exists', () => {
    assert.ok(fs.existsSync(KILL_SWITCHES_MD), `${KILL_SWITCHES_MD} must exist`);
  });

  test('§1 Orchestration core entries are case-insensitive alphabetical', () => {
    const content = fs.readFileSync(KILL_SWITCHES_MD, 'utf8');
    const section = extractSection(content, '## 1. Orchestration core');
    assert.ok(section.length > 0, '§1 section must not be empty');
    const features = extractFeatureNames(section);
    assert.ok(features.length > 0, '§1 must have at least one table entry');
    const outOfOrder = findFirstOutOfOrder(features);
    assert.equal(
      outOfOrder,
      null,
      outOfOrder
        ? `§1: "${outOfOrder.curr}" (index ${outOfOrder.index}) sorts before "${outOfOrder.prev}" — fix alphabetical order`
        : ''
    );
  });

  test('§6 Telemetry & audit entries are case-insensitive alphabetical', () => {
    const content = fs.readFileSync(KILL_SWITCHES_MD, 'utf8');
    const section = extractSection(content, '## 6. Telemetry & audit');
    assert.ok(section.length > 0, '§6 section must not be empty');
    const features = extractFeatureNames(section);
    assert.ok(features.length > 0, '§6 must have at least one table entry');
    const outOfOrder = findFirstOutOfOrder(features);
    assert.equal(
      outOfOrder,
      null,
      outOfOrder
        ? `§6: "${outOfOrder.curr}" (index ${outOfOrder.index}) sorts before "${outOfOrder.prev}" — fix alphabetical order`
        : ''
    );
  });

});
