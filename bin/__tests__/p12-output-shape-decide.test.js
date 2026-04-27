#!/usr/bin/env node
'use strict';

/**
 * p12-output-shape-decide.test.js — P1.2 category mapping + frontmatter ↔ map drift.
 *
 * Verifies:
 *   1. Each of the 14 declared roles returns the exact category from
 *      ROLE_CATEGORY_MAP when output_shape.enabled is true.
 *   2. Excluded roles (pm, haiku-scout, orchestray-housekeeper,
 *      pattern-extractor) and unknown roles return null.
 *   3. Master kill switch (output_shape.enabled = false) overrides every
 *      category to a category="none" non-emit shape.
 *   4. STAGED_FLIP_ALLOWLIST canary contract: researcher returns a non-null
 *      output_config_format; developer (hybrid, off-allowlist) returns null
 *      even with structured_outputs_enabled: true.
 *   5. Frontmatter ↔ in-code map drift detection: every agents/<role>.md
 *      with output_shape declares the exact value in ROLE_CATEGORY_MAP.
 *
 * Runner: node --test bin/__tests__/p12-output-shape-decide.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const {
  decideShape,
  ROLE_CATEGORY_MAP,
  EXCLUDED_ROLES,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

describe('decideShape — category mapping', () => {
  const ENABLED_CONFIG = { output_shape: { enabled: true } };

  for (const [role, expectedCategory] of Object.entries(ROLE_CATEGORY_MAP)) {
    test(`role "${role}" returns category "${expectedCategory}"`, () => {
      const out = decideShape(role, { config: ENABLED_CONFIG });
      assert.ok(out !== null, `expected non-null shape for ${role}`);
      assert.equal(out.category, expectedCategory);
    });
  }

  test('unknown role returns null (no default fallback)', () => {
    const out = decideShape('does-not-exist', { config: ENABLED_CONFIG });
    assert.equal(out, null);
  });

  test('null/undefined/empty role returns null', () => {
    assert.equal(decideShape(null), null);
    assert.equal(decideShape(undefined), null);
    assert.equal(decideShape(''), null);
  });

  for (const excluded of EXCLUDED_ROLES) {
    test(`excluded role "${excluded}" returns null`, () => {
      const out = decideShape(excluded, { config: ENABLED_CONFIG });
      assert.equal(out, null);
    });
  }
});

// ---------------------------------------------------------------------------
// Master kill switch
// ---------------------------------------------------------------------------

describe('decideShape — master kill switch', () => {
  test('enabled=false overrides every role to category="none" with all levers null', () => {
    for (const role of Object.keys(ROLE_CATEGORY_MAP)) {
      const out = decideShape(role, { config: { output_shape: { enabled: false } } });
      assert.ok(out !== null, `kill switch should still return a shape for ${role}`);
      assert.equal(out.category, 'none', `${role} should collapse to category=none`);
      assert.equal(out.caveman_text, null, `${role} caveman should be null`);
      assert.equal(out.output_config_format, null, `${role} output_config_format should be null`);
      assert.equal(out.length_cap, null, `${role} length_cap should be null`);
      assert.match(out.reason, /kill_switch/);
    }
  });
});

// ---------------------------------------------------------------------------
// Staged-flip allowlist (Risk #2)
// ---------------------------------------------------------------------------

describe('decideShape — staged-flip allowlist (canary contract)', () => {
  const CFG = {
    output_shape: {
      enabled: true,
      caveman_enabled: true,
      structured_outputs_enabled: true,
      length_cap_enabled: true,
      staged_flip_allowlist: ['researcher', 'tester'],
    },
  };

  test('researcher (allowlisted, structured-only) gets non-null output_config_format', () => {
    const out = decideShape('researcher', { config: CFG });
    assert.ok(out.output_config_format, 'researcher schema should be set');
    assert.equal(typeof out.output_config_format, 'object');
    assert.equal(out.output_config_format.type, 'object');
  });

  test('tester (allowlisted, structured-only) gets non-null output_config_format', () => {
    const out = decideShape('tester', { config: CFG });
    assert.ok(out.output_config_format, 'tester schema should be set');
  });

  test('developer (hybrid, off-allowlist) gets null output_config_format', () => {
    const out = decideShape('developer', { config: CFG });
    assert.equal(out.output_config_format, null,
      'hybrid roles must be held back from structured outputs in v2.2.0');
    assert.match(out.reason, /structured=staged_off/);
  });

  test('debugger (hybrid, off-allowlist) gets null output_config_format', () => {
    const out = decideShape('debugger', { config: CFG });
    assert.equal(out.output_config_format, null);
  });

  test('security-engineer (prose-heavy) never gets output_config_format', () => {
    const out = decideShape('security-engineer', { config: CFG });
    assert.equal(out.output_config_format, null);
    assert.match(out.reason, /structured=off_prose-heavy/);
  });

  test('structured_outputs_enabled=false overrides allowlist for researcher', () => {
    const cfg = JSON.parse(JSON.stringify(CFG));
    cfg.output_shape.structured_outputs_enabled = false;
    const out = decideShape('researcher', { config: cfg });
    assert.equal(out.output_config_format, null);
    assert.match(out.reason, /structured=off_disabled/);
  });
});

// ---------------------------------------------------------------------------
// Caveman lever — applies to hybrid + prose-heavy only
// ---------------------------------------------------------------------------

describe('decideShape — caveman lever scope', () => {
  const CFG = { output_shape: { enabled: true, caveman_enabled: true } };

  test('hybrid role gets caveman_text non-null', () => {
    const out = decideShape('developer', { config: CFG });
    assert.ok(out.caveman_text);
    assert.match(out.caveman_text, /smart caveman/);
  });

  test('prose-heavy role gets caveman_text non-null', () => {
    const out = decideShape('security-engineer', { config: CFG });
    assert.ok(out.caveman_text);
  });

  test('structured-only role does NOT get caveman_text', () => {
    const out = decideShape('researcher', { config: CFG });
    assert.equal(out.caveman_text, null);
    assert.match(out.reason, /caveman=off_structured-only/);
  });

  test('caveman_enabled=false suppresses caveman on hybrid roles', () => {
    const out = decideShape('developer', {
      config: { output_shape: { enabled: true, caveman_enabled: false } },
    });
    assert.equal(out.caveman_text, null);
    assert.match(out.reason, /caveman=off_disabled/);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter ↔ in-code map drift (§5.5)
// ---------------------------------------------------------------------------

describe('agents/<role>.md frontmatter agrees with ROLE_CATEGORY_MAP', () => {
  const FRONTMATTER_LINE_RE = /^output_shape:\s*(structured-only|hybrid|prose-heavy|none)\s*$/m;

  for (const [role, expectedCategory] of Object.entries(ROLE_CATEGORY_MAP)) {
    test(`agents/${role}.md declares output_shape: ${expectedCategory}`, () => {
      const file = path.join(REPO_ROOT, 'agents', `${role}.md`);
      const content = fs.readFileSync(file, 'utf8');
      const m = content.match(FRONTMATTER_LINE_RE);
      assert.ok(m, `agents/${role}.md must contain "output_shape: <enum>" line`);
      assert.equal(m[1], expectedCategory,
        `frontmatter declaration "${m[1]}" disagrees with ROLE_CATEGORY_MAP "${expectedCategory}"`);
    });
  }

  test('excluded agents do NOT declare output_shape', () => {
    for (const role of EXCLUDED_ROLES) {
      const file = path.join(REPO_ROOT, 'agents', `${role}.md`);
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      // Only check the frontmatter region (between first two ---)
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      const fmText = fm ? fm[1] : '';
      assert.ok(!FRONTMATTER_LINE_RE.test(fmText),
        `agents/${role}.md (excluded) must NOT declare output_shape:`);
    }
  });
});
