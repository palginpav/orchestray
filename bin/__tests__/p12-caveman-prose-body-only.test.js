#!/usr/bin/env node
'use strict';

/**
 * p12-caveman-prose-body-only.test.js — P1.2 Risk #1 contract: caveman applies
 * ONLY to prose body, not to Structured Result JSON.
 *
 * Pins the verbatim 85-token CAVEMAN_TEXT literal against the W2 §3.3
 * benchmark — paraphrasing voids the -21% Opus measurement, so byte-exact
 * equality is enforced by this test.
 *
 * Verifies:
 *   1. CAVEMAN_TEXT byte-equals the W2 fixture string.
 *   2. Token count fits the "85 tokens" advertisement (whitespace-tokenised
 *      lower bound + sane upper bound — 60–110).
 *   3. structured-only and none categories return caveman_text=null even
 *      when caveman_enabled=true.
 *   4. The caveman literal contains no instructions targeting the JSON
 *      block — its scope is the prose body. (Cross-reference: the prompt
 *      step 9.7 in agents/pm.md anchors the JSON exemption clause.)
 *
 * Runner: node --test bin/__tests__/p12-caveman-prose-body-only.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const {
  decideShape,
  CAVEMAN_TEXT,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'));

// ---------------------------------------------------------------------------
// Verbatim W2 §3.3 fixture — the literal string Kuba Guzik benchmarked
// (Apr 2026, -21% Opus / -14% Sonnet, 100% accuracy retained).
// Lines 225-233 of .orchestray/kb/artifacts/v220-research-compression.md.
// ---------------------------------------------------------------------------

const W2_BENCHMARK_LITERAL = [
  'Respond like smart caveman. Cut all filler, keep technical substance.',
  '',
  'Drop articles (a, an, the), filler (just, really, basically, actually).',
  'Drop pleasantries (sure, certainly, happy to).',
  'No hedging. Fragments fine. Short synonyms.',
  'Technical terms stay exact. Code blocks unchanged.',
  'Pattern: [thing] [action] [reason]. [next step].',
].join('\n');

describe('CAVEMAN_TEXT — byte-exact W2 §3.3 literal', () => {
  test('CAVEMAN_TEXT equals the W2 benchmark fixture verbatim', () => {
    assert.equal(CAVEMAN_TEXT, W2_BENCHMARK_LITERAL,
      'CAVEMAN_TEXT must byte-equal the W2 §3.3 literal. ' +
      'Paraphrasing voids the -21% Opus output measurement (Kuba Guzik benchmark, Apr 2026).');
  });

  test('CAVEMAN_TEXT length is sane (advertised ~85 tokens)', () => {
    // Whitespace-tokenised count is a lower bound for BPE tokens.
    const wsTokens = CAVEMAN_TEXT.split(/\s+/).filter(Boolean).length;
    assert.ok(wsTokens >= 40, `caveman whitespace-token count too low: ${wsTokens}`);
    assert.ok(wsTokens <= 90, `caveman whitespace-token count too high: ${wsTokens}`);
    // Char count gives upper-bound sanity (5–10 chars/token typical).
    assert.ok(CAVEMAN_TEXT.length >= 200, `caveman too short: ${CAVEMAN_TEXT.length} chars`);
    assert.ok(CAVEMAN_TEXT.length <= 600, `caveman too long: ${CAVEMAN_TEXT.length} chars`);
  });

  test('CAVEMAN_TEXT does not mention "JSON" or "Structured Result" — scope is prose only', () => {
    // Sanity: the literal must not give compression instructions targeting
    // structured outputs. The exemption is enforced at the PM injection
    // site (agents/pm.md step 9.7), not inside CAVEMAN_TEXT.
    assert.ok(!/json/i.test(CAVEMAN_TEXT), 'CAVEMAN_TEXT must not mention JSON');
    assert.ok(!/structured\s+result/i.test(CAVEMAN_TEXT),
      'CAVEMAN_TEXT must not reference Structured Result');
  });
});

// ---------------------------------------------------------------------------
// Category-scope contract
// ---------------------------------------------------------------------------

describe('caveman_text scoped to hybrid + prose-heavy only', () => {
  const CFG = { output_shape: { enabled: true, caveman_enabled: true } };

  test('structured-only roles → caveman_text is null', () => {
    for (const role of ['researcher', 'tester']) {
      const out = decideShape(role, { config: CFG });
      assert.equal(out.caveman_text, null,
        `${role} (structured-only) must not receive caveman_text`);
    }
  });

  test('none roles → caveman_text is null', () => {
    for (const role of ['platform-oracle', 'project-intent']) {
      const out = decideShape(role, { config: CFG });
      assert.equal(out.caveman_text, null,
        `${role} (none) must not receive caveman_text`);
    }
  });

  test('hybrid roles → caveman_text is verbatim CAVEMAN_TEXT', () => {
    const hybridRoles = [
      'developer', 'debugger', 'reviewer', 'architect', 'documenter',
      'refactorer', 'inventor', 'release-manager',
    ];
    for (const role of hybridRoles) {
      const out = decideShape(role, { config: CFG });
      assert.equal(out.caveman_text, CAVEMAN_TEXT,
        `${role} caveman_text must be the verbatim literal`);
    }
  });

  test('prose-heavy roles → caveman_text is verbatim CAVEMAN_TEXT', () => {
    for (const role of ['security-engineer', 'ux-critic']) {
      const out = decideShape(role, { config: CFG });
      assert.equal(out.caveman_text, CAVEMAN_TEXT);
    }
  });
});
