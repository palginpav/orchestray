#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/pattern-offer-scan.js.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/_lib/__tests__/pattern-offer-scan.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { scanOffers } = require('../pattern-offer-scan');

const alwaysExists = () => true;

function buildToonGrounding(entries) {
  const catalog = entries
    .map((e) => 'PATTERN slug=' + e.slug + ' confidence=' + e.confidence.toFixed(2) +
      ' one_line="' + (e.one_line || '') + '" hook="' + (e.hook || '') + '"')
    .join('\n');
  const body = JSON.stringify({ mode: 'catalog', catalog, considered: entries.length, filtered_out: 0 }, null, 2);
  return [
    '<mcp-grounding cache_hint="transient">',
    '[role: developer | timestamp: 2026-08-07T09:00:00.000Z]',
    '## pattern_find results',
    body,
    '</mcp-grounding>',
  ].join('\n');
}

function buildJsonMatchesGrounding(entries) {
  const body = JSON.stringify({ matches: entries, considered: entries.length, filtered_out: 0 }, null, 2);
  return [
    '<mcp-grounding cache_hint="transient">',
    '[role: developer | timestamp: 2026-08-07T09:00:00.000Z]',
    '## pattern_find results',
    body,
    '</mcp-grounding>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Shape 2 — TOON catalog
// ---------------------------------------------------------------------------

describe('TOON catalog shape', () => {
  test('extracts slugs + confidence, shape_detected=toon_catalog', () => {
    const prompt = 'Task prompt.\n\n' + buildToonGrounding([
      { slug: 'foo-bar', confidence: 0.75 },
      { slug: 'baz-qux', confidence: 0.6 },
    ]);
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.shape_detected, 'toon_catalog');
    assert.equal(result.offers.length, 2);
    const bySlug = Object.fromEntries(result.offers.map((o) => [o.slug, o]));
    assert.equal(bySlug['foo-bar'].offer_kind, 'ambient');
    assert.equal(bySlug['foo-bar'].confidence, 0.75);
    assert.equal(bySlug['baz-qux'].confidence, 0.6);
    assert.deepEqual(result.unresolved_slugs, []);
  });
});

// ---------------------------------------------------------------------------
// Shape 3 — legacy JSON matches array (the §0.2 shape the old parser handled)
// ---------------------------------------------------------------------------

describe('legacy JSON matches array shape', () => {
  test('extracts slugs + confidence, shape_detected=json_matches', () => {
    const prompt = 'Task prompt.\n\n' + buildJsonMatchesGrounding([
      { slug: 'decompose-parallel', confidence: 0.8 },
      { slug: 'event-schema-declare', confidence: 0.9 },
    ]);
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.shape_detected, 'json_matches');
    assert.equal(result.offers.length, 2);
    assert.ok(result.offers.every((o) => o.offer_kind === 'ambient'));
  });

  test('also handles items/results/patterns keys', () => {
    for (const key of ['items', 'results', 'patterns']) {
      const body = JSON.stringify({ [key]: [{ slug: 'a-b', confidence: 0.5 }] });
      const prompt = [
        '<mcp-grounding cache_hint="transient">',
        '## pattern_find results',
        body,
        '</mcp-grounding>',
      ].join('\n');
      const result = scanOffers(prompt, alwaysExists);
      assert.equal(result.shape_detected, 'json_matches', 'key=' + key);
      assert.equal(result.offers.length, 1, 'key=' + key);
    }
  });
});

// ---------------------------------------------------------------------------
// Shape 1 — bare @orchestray:pattern:// citations
// ---------------------------------------------------------------------------

describe('curated citation shape', () => {
  test('bare URI with no grounding block, shape_detected=uri_only', () => {
    const prompt = 'Apply @orchestray:pattern://foo-bar [local] conf 0.82, applied 3x here.';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.shape_detected, 'uri_only');
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].offer_kind, 'curated');
    assert.equal(result.offers[0].confidence, 0.82);
  });

  test('URI with no conf tail yields confidence: null', () => {
    const prompt = 'See @orchestray:pattern://foo-bar for details.';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.offers[0].confidence, null);
  });

  test('slug inside a rejection sentence still counts as offered (presence, not sentiment)', () => {
    const prompt = 'We considered @orchestray:pattern://foo-bar but rejected it as not applicable here.';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].slug, 'foo-bar');
  });

  test('slug inside a code fence still counts as offered', () => {
    const prompt = 'Example:\n```\n@orchestray:pattern://foo-bar\n```\n';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.offers.length, 1);
  });
});

// ---------------------------------------------------------------------------
// RV-2 Issue 3 — quoted/echoed slug mentions must not be classified curated
// ---------------------------------------------------------------------------

describe('quoted-span contamination guard (RV-2 Issue 3)', () => {
  test('reviewer repro: a slug quoted from a prior agent\'s free-text summary is not curated', () => {
    const prompt = 'You are the reviewer. Review the diff. ' +
      'Prior developer summary (for your context): "...resembles ' +
      '@orchestray:pattern://totally-unrelated-agent-authored-slug which I did not actually apply..."';
    const result = scanOffers(prompt, alwaysExists);
    assert.deepEqual(result.offers, [], 'a quoted mention must not enter the curated (or any) offer set');
    assert.equal(result.shape_detected, 'none');
  });

  test('an unquoted PM citation elsewhere in the same prompt is still curated', () => {
    const prompt = 'Apply @orchestray:pattern://real-citation [local] conf 0.9, applied 4x. ' +
      'Prior developer summary (for your context): "...mentioned ' +
      '@orchestray:pattern://echoed-slug in passing..."';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].slug, 'real-citation');
    assert.equal(result.offers[0].offer_kind, 'curated');
  });

  test('an escaped quote (\\") does not toggle quote parity', () => {
    const prompt = 'Note: \\"the developer\\" mentioned @orchestray:pattern://foo-bar in the summary.';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.offers.length, 1, 'an escaped quote must not be counted as an open/close delimiter');
    assert.equal(result.offers[0].offer_kind, 'curated');
  });

  test('a later unquoted occurrence of the same slug is still recorded after an earlier quoted one', () => {
    const prompt = 'Prior summary: "...saw @orchestray:pattern://dup-slug mentioned..." ' +
      'Now apply @orchestray:pattern://dup-slug [local] conf 0.8, applied 1x for real.';
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].slug, 'dup-slug');
    assert.equal(result.offers[0].offer_kind, 'curated');
    assert.equal(result.offers[0].confidence, 0.8, 'confidence must come from the unquoted occurrence');
  });
});

// ---------------------------------------------------------------------------
// Zero patterns
// ---------------------------------------------------------------------------

describe('zero patterns', () => {
  test('plain prompt, no grounding, no citations → empty, shape_detected=none', () => {
    const result = scanOffers('Just do the task, no patterns involved.', alwaysExists);
    assert.deepEqual(result.offers, []);
    assert.equal(result.shape_detected, 'none');
    assert.deepEqual(result.unresolved_slugs, []);
  });

  test('empty/non-string promptText → safe empty result', () => {
    assert.deepEqual(scanOffers('', alwaysExists), { offers: [], shape_detected: 'none', unresolved_slugs: [] });
    assert.deepEqual(scanOffers(null, alwaysExists), { offers: [], shape_detected: 'none', unresolved_slugs: [] });
    assert.deepEqual(scanOffers(undefined, alwaysExists), { offers: [], shape_detected: 'none', unresolved_slugs: [] });
  });

  test('malformed JSON in the pattern_find section fails open to none (does not throw)', () => {
    const prompt = [
      '<mcp-grounding cache_hint="transient">',
      '## pattern_find results',
      '{not valid json',
      '</mcp-grounding>',
    ].join('\n');
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.shape_detected, 'none');
    assert.deepEqual(result.offers, []);
  });
});

// ---------------------------------------------------------------------------
// Unresolvable slugs
// ---------------------------------------------------------------------------

describe('unresolved slugs', () => {
  test('slug failing exists() is dropped from offers and reported in unresolved_slugs', () => {
    const prompt = 'Apply @orchestray:pattern://real-slug and @orchestray:pattern://fake-slug here.';
    const exists = (slug) => slug === 'real-slug';
    const result = scanOffers(prompt, exists);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].slug, 'real-slug');
    assert.deepEqual(result.unresolved_slugs, ['fake-slug']);
  });

  test('exists() throwing is treated as unresolved (fail toward dropping, not crashing)', () => {
    const prompt = 'Apply @orchestray:pattern://boom-slug here.';
    const exists = () => { throw new Error('resolver blew up'); };
    const result = scanOffers(prompt, exists);
    assert.deepEqual(result.offers, []);
    assert.deepEqual(result.unresolved_slugs, ['boom-slug']);
  });
});

// ---------------------------------------------------------------------------
// Mixed shape + curated precedence
// ---------------------------------------------------------------------------

describe('mixed and precedence rules', () => {
  test('both TOON and JSON-matches ambient shapes present → shape_detected=mixed', () => {
    // Synthetic: not a real prefetch output, but exercises the enum path per
    // design §8.1 (shape_detected: toon_catalog | json_matches | uri_only |
    // mixed | none).
    const toon = 'PATTERN slug=toon-slug confidence=0.70 one_line="" hook=""';
    const prompt = [
      '<mcp-grounding cache_hint="transient">',
      toon,
      '## pattern_find results',
      JSON.stringify({ matches: [{ slug: 'json-slug', confidence: 0.65 }] }),
      '</mcp-grounding>',
    ].join('\n');
    const result = scanOffers(prompt, alwaysExists);
    assert.equal(result.shape_detected, 'mixed');
    assert.equal(result.offers.length, 2);
  });

  test('curated citation wins over ambient offer for the same slug', () => {
    const prompt = 'Cite @orchestray:pattern://shared-slug [local] conf 0.90, applied 2x.\n\n' +
      buildToonGrounding([{ slug: 'shared-slug', confidence: 0.40 }]);
    const result = scanOffers(prompt, alwaysExists);
    const entry = result.offers.find((o) => o.slug === 'shared-slug');
    assert.equal(result.offers.length, 1, 'must not duplicate the shared slug');
    assert.equal(entry.offer_kind, 'curated');
    assert.equal(entry.confidence, 0.90);
  });
});
