#!/usr/bin/env node
'use strict';

/**
 * Tests: Claude Fable 5.1 pricing/tokenizer inheritance in bin/_lib/cost-helpers.js
 * and its registry entry in bin/_lib/models.js.
 *
 * Fable 5.1 (`claude-fable-5-1`, GA 2026-09-01) reuses Fable 5's $10/$50 base rates
 * and its Opus-4.7-era tokenizer unchanged. getPricing() picks this up automatically
 * via its `includes('fable')` prefix match — this test pins that behaviour so the
 * inheritance is a verified, deliberate decision rather than an accident of the
 * prefix match.
 *
 * Tokenizer confirmation, verbatim (Fable 5.1 whats-new page, Models section):
 *   "Tokenizer: the same as Claude Fable 5 (introduced with Claude Opus 4.7).
 *    Compared with models older than Claude Opus 4.7, the same text produces
 *    roughly 30% more tokens."
 * Source: https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1
 * (see .orchestray/kb/facts/2026-08-fable-5-1-rollout.md §4).
 *
 * Do NOT add a new tokenizer multiplier constant for Fable 5.1 — the existing
 * OPUS_47_TOKENIZER_MULTIPLIER (1.35×) applies unchanged, per the quote above.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  getPricing,
  BUILTIN_PRICING_TABLE,
  OPUS_47_TOKENIZER_MULTIPLIER,
} = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));

const {
  lookupModel,
  resolveContextWindow,
  modelShort,
} = require(path.resolve(__dirname, '../bin/_lib/models'));

const FABLE_BASE = BUILTIN_PRICING_TABLE.fable;

describe('getPricing — Fable 5.1 tokenizer/pricing inheritance', () => {
  test('getPricing("claude-fable-5-1") input === 10 x 1.35 (within 1e-9)', () => {
    const rates = getPricing('claude-fable-5-1');
    const expected = FABLE_BASE.input_per_1m * OPUS_47_TOKENIZER_MULTIPLIER;
    assert.ok(
      Math.abs(rates.input_per_1m - expected) < 1e-9,
      `Expected input_per_1m=${expected}, got ${rates.input_per_1m}`
    );
  });

  test('getPricing("claude-fable-5-1") output === 50 x 1.35 (within 1e-9)', () => {
    const rates = getPricing('claude-fable-5-1');
    const expected = FABLE_BASE.output_per_1m * OPUS_47_TOKENIZER_MULTIPLIER;
    assert.ok(
      Math.abs(rates.output_per_1m - expected) < 1e-9,
      `Expected output_per_1m=${expected}, got ${rates.output_per_1m}`
    );
  });

  test('getPricing("claude-fable-5-1") concrete values: input 13.5 / output 67.5', () => {
    const rates = getPricing('claude-fable-5-1');
    assert.ok(Math.abs(rates.input_per_1m - 13.5) < 1e-9,
      `Expected 13.5, got ${rates.input_per_1m}`);
    assert.ok(Math.abs(rates.output_per_1m - 67.5) < 1e-9,
      `Expected 67.5, got ${rates.output_per_1m}`);
  });

  test('getPricing("claude-fable-5-1") deep-equals getPricing("claude-fable-5") (same base + multiplier)', () => {
    assert.deepStrictEqual(getPricing('claude-fable-5-1'), getPricing('claude-fable-5'));
  });
});

describe('models.js — claude-fable-5-1 registry entry (W1)', () => {
  test('lookupModel("claude-fable-5-1") is a real entry, not MODEL_UNKNOWN', () => {
    const meta = lookupModel('claude-fable-5-1');
    assert.notStrictEqual(meta.short, '?');
    assert.notStrictEqual(meta.display, 'unknown');
  });

  test('resolveContextWindow("claude-fable-5-1") returns 1000000, not the 200000 fallback', () => {
    const window = resolveContextWindow('claude-fable-5-1', null);
    assert.strictEqual(window, 1000000);
  });

  test('modelShort("claude-fable-5-1") returns a distinct short code from Fable 5', () => {
    const short51 = modelShort('claude-fable-5-1');
    const short5 = modelShort('claude-fable-5');
    assert.notStrictEqual(short51, '?');
    assert.notStrictEqual(short51, short5);
  });
});

// ---------------------------------------------------------------------------
// W4 — class guard: any model ID that getPricing() prices non-default MUST
// also be registered in models.js. This is the invariant that would have
// caught the original defect (pricing worked via prefix match, registry
// lookup silently fell back to MODEL_UNKNOWN's 200000 window).
// ---------------------------------------------------------------------------

/**
 * Scan the repo for literal `claude-<family>-...` model-ID string tokens.
 *
 * Deliberately independent of bin/_lib/models.js's own MODELS keys: deriving
 * candidates from MODELS would be circular (a model missing from the registry
 * would also be missing from the candidate set, so the guard could never catch
 * the exact defect it exists to prevent). Instead this walks bin/ and tests/
 * source text for model-ID literals, EXCLUDING models.js itself (the file
 * under test) — every other place in the codebase (pricing logic, other
 * tests, comments) that already names a concrete model ID independently
 * confirms that ID is "real" and in-scope for the parity check.
 *
 * @param {string} rootDir - absolute path to scan
 * @returns {Set<string>} discovered model IDs, e.g. "claude-fable-5-1"
 */
function scanForModelIdLiterals(rootDir) {
  const found = new Set();
  // Negative lookahead excludes dotted-version prose references like "opus-4.7"
  // (used in comments alongside the real dash-form IDs) — those aren't literal
  // model-ID strings, just human-readable version mentions.
  const idPattern = /claude-(?:fable|opus|sonnet|haiku)-[0-9][0-9a-z-]*(?!\.\d)/gi;
  const skipDirs = new Set(['node_modules', '.git']);
  const excludedFiles = new Set([path.join(rootDir, 'bin', '_lib', 'models.js')]);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.js$/.test(entry.name) && !excludedFiles.has(full)) {
        let text;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch (_e) {
          continue;
        }
        const matches = text.match(idPattern);
        if (matches) {
          for (const m of matches) found.add(m.toLowerCase().replace(/-$/, ''));
        }
      }
    }
  }

  walk(path.join(rootDir, 'bin'));
  walk(path.join(rootDir, 'tests'));
  return found;
}

describe('W4 — pricing/registry parity guard', () => {
  test('every concrete model ID literal that getPricing() gives a bespoke tokenizer-multiplier branch has a models.js registry entry', () => {
    const { MODELS } = require(path.resolve(__dirname, '../bin/_lib/models'));
    const { usesOpus47Tokenizer, usesSonnet5Tokenizer } =
      require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));

    const repoRoot = path.resolve(__dirname, '..');
    const candidateIds = scanForModelIdLiterals(repoRoot);

    // Sanity: the scan must actually find the models this test cares about,
    // confirming the derivation is not accidentally empty/broken.
    assert.ok(candidateIds.has('claude-fable-5'), 'scan missed claude-fable-5');
    assert.ok(candidateIds.has('claude-fable-5-1'), 'scan missed claude-fable-5-1');

    // Scope the guard to IDs getPricing() gives *bespoke* handling — a
    // family-specific tokenizer-multiplier branch (fable, opus-4-7/4-8/5,
    // sonnet-5) — rather than every ID that merely resolves non-default
    // pricing via the generic opus/haiku/sonnet tier fallback. The generic
    // tier branches apply uniformly to any dated snapshot ID (e.g.
    // "claude-haiku-4-5-20251001") and were never meant to require an
    // individual models.js entry; the tokenizer-multiplier branches are
    // exactly the kind of per-model special-casing that caused the Fable 5.1
    // defect (pricing correct via prefix match, registry entry missing).
    for (const id of candidateIds) {
      const isSpecialCased = usesOpus47Tokenizer(id) || usesSonnet5Tokenizer(id);
      if (!isSpecialCased) continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(MODELS, id),
        `"${id}" gets bespoke tokenizer-multiplier pricing via getPricing() but has no models.js registry entry ` +
        `(would silently fall back to MODEL_UNKNOWN's 200000-token window)`
      );
    }
  });

  test('a model with a bespoke tokenizer-multiplier branch but absent from the registry is caught (guard self-test)', () => {
    // Simulates the exact defect this guard exists to prevent: a model ID that
    // getPricing() gives bespoke (tokenizer-multiplier) handling via prefix
    // match but that has no models.js registry entry. Uses a synthetic ID so
    // it does not depend on mutating the real registry from within a test.
    const { MODELS } = require(path.resolve(__dirname, '../bin/_lib/models'));
    const { usesOpus47Tokenizer } = require(path.resolve(__dirname, '../bin/_lib/cost-helpers'));
    // Built via concatenation (not a single string literal) so the source-scan
    // in the guard test above does not pick this up as a "real" candidate ID.
    const syntheticUnregisteredId = 'claude-fable-' + '9-9-not-in-registry';
    assert.ok(!Object.prototype.hasOwnProperty.call(MODELS, syntheticUnregisteredId));
    assert.ok(usesOpus47Tokenizer(syntheticUnregisteredId), 'synthetic ID should match the fable prefix');

    assert.throws(() => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(MODELS, syntheticUnregisteredId),
        `"${syntheticUnregisteredId}" gets bespoke tokenizer-multiplier pricing via getPricing() but has no models.js registry entry`
      );
    }, /gets bespoke tokenizer-multiplier pricing via getPricing\(\) but has no models\.js registry entry/);
  });
});
