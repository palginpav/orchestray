#!/usr/bin/env node
'use strict';

/**
 * Regression test: R-TGATE analytics rollup surface (v2.1.14).
 *
 * AC verified:
 *   - analytics SKILL.md references all three R-TGATE rollups:
 *     A) Tier-2 load rate per feature
 *     B) fields_used compliance %
 *     C) feature_gate_eval truthy histogram
 *   - event type references are present in SKILL.md
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_FILE = path.resolve(
  __dirname, '../../skills/orchestray:analytics/SKILL.md'
);

let content;
test('analytics SKILL.md can be read', () => {
  content = fs.readFileSync(SKILL_FILE, 'utf8');
  assert.ok(content.length > 0, 'SKILL.md must be non-empty');
});

describe('R-TGATE rollups in analytics SKILL.md', () => {

  test('Rollup A: tier2_load rate per feature section exists', () => {
    assert.ok(
      content.includes('tier2_load') || content.includes('Tier-2 Load Rate') || content.includes('Tier-2 load rate'),
      'analytics SKILL.md must reference tier2_load / Tier-2 Load Rate rollup'
    );
  });

  test('Rollup B: fields_used compliance section exists', () => {
    assert.ok(
      content.includes('fields_used'),
      'analytics SKILL.md must reference fields_used compliance rollup'
    );
  });

  test('Rollup B: compliance percentage is mentioned', () => {
    assert.ok(
      content.includes('compliance') || content.includes('Compliance'),
      'analytics SKILL.md must reference compliance percentage'
    );
  });

  test('Rollup C: feature_gate_eval histogram section exists', () => {
    assert.ok(
      content.includes('feature_gate_eval') || content.includes('Feature Gate') || content.includes('feature gate'),
      'analytics SKILL.md must reference feature_gate_eval histogram rollup'
    );
  });

  test('Rollup C: gates_true histogram is mentioned', () => {
    assert.ok(
      content.includes('gates_true') || content.includes('truthy histogram') || content.includes('Histogram'),
      'analytics SKILL.md must reference truthy gate histogram'
    );
  });

  test('R-TGATE section is numbered/referenced in protocol order', () => {
    assert.ok(
      content.includes('R-TGATE') || content.includes('Observability'),
      'analytics SKILL.md must include R-TGATE or Observability section heading'
    );
  });
});
