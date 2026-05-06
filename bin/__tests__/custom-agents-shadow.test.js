#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/custom-agents-shadow.js — Arena v0 stub shadowing.
 *
 * Runner: node --test bin/__tests__/custom-agents-shadow.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { filterShadowedArenaV0s, ARENA_VERSIONED_RE } =
  require('../_lib/custom-agents-shadow');

const rec = (name) => ({ name, source_path: '/x/' + name + '.md' });

describe('filterShadowedArenaV0s', () => {
  test('#1 no versioned siblings: all visible', () => {
    const r = filterShadowedArenaV0s([rec('alpha'), rec('beta')]);
    assert.equal(r.visible.length, 2);
    assert.equal(r.hidden.length,  0);
  });

  test('#2 v0+v1 pair: v0 hidden, v1 visible', () => {
    const r = filterShadowedArenaV0s([
      rec('translator-pro'),
      rec('translator-pro-arena-v1'),
    ]);
    assert.equal(r.visible.length, 1);
    assert.equal(r.visible[0].name, 'translator-pro-arena-v1');
    assert.equal(r.hidden.length,  1);
    assert.equal(r.hidden[0].name, 'translator-pro');
  });

  test('#3 multiple versions (v1+v2+v3): only base hidden', () => {
    const r = filterShadowedArenaV0s([
      rec('foo'),
      rec('foo-arena-v1'),
      rec('foo-arena-v2'),
      rec('foo-arena-v3'),
    ]);
    assert.equal(r.visible.length, 3);
    assert.deepEqual(
      r.visible.map(x => x.name).sort(),
      ['foo-arena-v1', 'foo-arena-v2', 'foo-arena-v3']
    );
    assert.equal(r.hidden.length,  1);
    assert.equal(r.hidden[0].name, 'foo');
  });

  test('#4 v0 alone (no versioned sibling): visible', () => {
    const r = filterShadowedArenaV0s([rec('lonely')]);
    assert.equal(r.visible.length, 1);
    assert.equal(r.hidden.length,  0);
  });

  test('#5 versioned alone (no v0): visible', () => {
    const r = filterShadowedArenaV0s([rec('orphan-arena-v2')]);
    assert.equal(r.visible.length, 1);
    assert.equal(r.hidden.length,  0);
  });

  test('#6 mixed dataset (your homedir scenario): only v0s with siblings hidden', () => {
    const r = filterShadowedArenaV0s([
      rec('customer-psychology-expert'),
      rec('customer-psychology-expert-arena-v1'),
      rec('digital-biz-law-expert'),
      rec('digital-biz-law-expert-arena-v1'),
      rec('niche-research-analyst'),
      rec('niche-research-analyst-arena-v1'),
    ]);
    assert.equal(r.visible.length, 3);
    assert.deepEqual(
      r.visible.map(x => x.name).sort(),
      [
        'customer-psychology-expert-arena-v1',
        'digital-biz-law-expert-arena-v1',
        'niche-research-analyst-arena-v1',
      ]
    );
    assert.equal(r.hidden.length, 3);
  });

  test('#7 empty input: empty result', () => {
    const r = filterShadowedArenaV0s([]);
    assert.equal(r.visible.length, 0);
    assert.equal(r.hidden.length,  0);
  });

  test('#8 invalid records: tolerated, skipped', () => {
    const r = filterShadowedArenaV0s([null, undefined, {}, rec('alpha')]);
    assert.equal(r.visible.length, 4);
    assert.equal(r.hidden.length,  0);
  });

  test('#9 regex matches "-arena-vN" suffix only (not "-v1" alone)', () => {
    // 'beta-v1' is NOT a versioned Arena sibling — it lacks "-arena-".
    const r = filterShadowedArenaV0s([rec('beta'), rec('beta-v1')]);
    assert.equal(r.visible.length, 2);
    assert.equal(r.hidden.length,  0);
    assert.match('foo-arena-v9', ARENA_VERSIONED_RE);
    assert.doesNotMatch('foo-v9',         ARENA_VERSIONED_RE);
    assert.doesNotMatch('foo-arena-vbeta', ARENA_VERSIONED_RE);
  });
});
