#!/usr/bin/env node
'use strict';

/**
 * r-autodoc-off-default.test.js — coverage for R-AUTODOC-OFF (W4, v2.1.16).
 *
 * R-AUTODOC-OFF flips the `auto_document` config default from `true` to `false`
 * so the documenter agent only spawns on explicit `/orchestray:document` calls.
 * The reviewer's documentation dimension already covers docs-drift detection.
 *
 * Tests:
 *   1. Repo-level `.orchestray/config.json` declares `auto_document: false`.
 *   2. The auto-documenter Tier-2 doc declares the false default in plain text
 *      (single-source-of-truth check — if the config flips back, the prompt
 *      must flip back too, so they cannot drift).
 *   3. `bin/install.js` does NOT seed `auto_document: true` on fresh installs
 *      (the absence is what flips the runtime default to `false`).
 *
 * Runner: node --test tests/r-autodoc-off-default.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, '.orchestray', 'config.json');
const INSTALL_JS = path.join(ROOT, 'bin', 'install.js');
const AUTODOC_DOC = path.join(ROOT, 'agents', 'pm-reference', 'auto-documenter.md');

// ---------------------------------------------------------------------------
// Test 1 — repo config.json declares auto_document: false
// ---------------------------------------------------------------------------

describe('R-AUTODOC-OFF — repo config default', () => {
  test('.orchestray/config.json sets auto_document to false (or omits it; default-off)', () => {
    assert.ok(fs.existsSync(CONFIG_PATH), 'repo config.json must exist for this test');
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Per R-AUTODOC-OFF, the explicit value must be `false` if present at all.
    // An explicit `true` here would silently re-enable auto-doc spawn for the
    // repo and is the regression we are guarding against.
    if (Object.prototype.hasOwnProperty.call(cfg, 'auto_document')) {
      assert.equal(cfg.auto_document, false,
        'auto_document must be false in repo config (R-AUTODOC-OFF, v2.1.16)');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Tier-2 prompt declares the false default
// ---------------------------------------------------------------------------

describe('R-AUTODOC-OFF — auto-documenter prompt declares default-off', () => {
  test('agents/pm-reference/auto-documenter.md states "Default: false"', () => {
    assert.ok(fs.existsSync(AUTODOC_DOC), 'auto-documenter.md must exist');
    const body = fs.readFileSync(AUTODOC_DOC, 'utf8');
    // Single-source-of-truth: the prompt the PM reads at runtime must agree
    // with the config default. Match a tolerant regex (case + spacing) so
    // editorial reflows do not break the test.
    const declaresDefaultFalse = /Default:\s*`?false`?/i.test(body);
    assert.ok(declaresDefaultFalse,
      'auto-documenter.md must declare "Default: false" so prompt and config agree');
  });

  test('auto-documenter.md instructs PM to skip when auto_document is not true', () => {
    const body = fs.readFileSync(AUTODOC_DOC, 'utf8');
    // Defense-in-depth: even if the config flips, the prompt should bail out
    // unless the value is explicitly `true`.
    const skipsOnNonTrue = /not\s+`?true`?/i.test(body) || /skip.*section/i.test(body);
    assert.ok(skipsOnNonTrue,
      'auto-documenter.md must instruct PM to skip when auto_document is not explicitly true');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — install.js does not seed auto_document: true
// ---------------------------------------------------------------------------

describe('R-AUTODOC-OFF — fresh-install does not seed auto_document: true', () => {
  test('bin/install.js never writes "auto_document: true" into the seeded config', () => {
    assert.ok(fs.existsSync(INSTALL_JS), 'bin/install.js must exist');
    const installSource = fs.readFileSync(INSTALL_JS, 'utf8');
    // Look for any literal that would seed auto_document: true into the
    // freshConfig object. The string forms are the ones we guard against.
    const seedsTrue = /auto_document\s*:\s*true/.test(installSource);
    assert.equal(seedsTrue, false,
      'bin/install.js must not seed auto_document: true on fresh installs (R-AUTODOC-OFF)');
  });
});
