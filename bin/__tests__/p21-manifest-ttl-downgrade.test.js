#!/usr/bin/env node
'use strict';

/**
 * P2.1 manifest TTL auto-downgrade (v2.2.0).
 *
 * Asserts the < 25-minute boundary rule: estimated_orch_duration_minutes < 25
 * downgrades Slots 1+2 to '5m'; >= 25 keeps them at '1h'. Slots 3 and 4 are
 * always '5m'. Missing or absent pmProtocol falls through to long-orch default
 * (1h) per the design fail-safe.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildManifest } = require(path.join(REPO_ROOT, 'bin', '_lib', 'cache-breakpoint-manifest.js'));

function fakeBlockZ() {
  return {
    text: 'block-z body\n<!-- block-z:sha256=' + 'a'.repeat(64) + ' -->',
    hash: 'a'.repeat(64),
    components: [],
    error: null,
  };
}

function fakeZone(content) {
  return { content, hash: content ? 'b'.repeat(64) : 'empty', bytes: Buffer.byteLength(content || '', 'utf8') };
}

const fixtures = [
  { label: '20 min — downgrade',     pmProtocol: { estimated_orch_duration_minutes: 20 }, expectS1: '5m', expectS2: '5m', downgrade: true },
  { label: '25 min — boundary kept', pmProtocol: { estimated_orch_duration_minutes: 25 }, expectS1: '1h', expectS2: '1h', downgrade: false },
  { label: '60 min — long',          pmProtocol: { estimated_orch_duration_minutes: 60 }, expectS1: '1h', expectS2: '1h', downgrade: false },
  { label: 'pmProtocol = null',      pmProtocol: null,                                      expectS1: '1h', expectS2: '1h', downgrade: false },
  { label: 'pmProtocol = {} (field absent)', pmProtocol: {},                                expectS1: '1h', expectS2: '1h', downgrade: false },
];

describe('P2.1 buildManifest TTL auto-downgrade', () => {
  for (const fx of fixtures) {
    test(fx.label, () => {
      const m = buildManifest({
        blockZ: fakeBlockZ(),
        zone1:  fakeZone('zone1'),
        zone2:  fakeZone('zone2'),
        zone3:  fakeZone('zone3'),
        pmProtocol: fx.pmProtocol,
      });
      assert.equal(m.slots[0].ttl, fx.expectS1);
      assert.equal(m.slots[1].ttl, fx.expectS2);
      assert.equal(m.slots[2].ttl, '5m', 'slot 3 always 5m');
      assert.equal(m.slots[3].ttl, '5m', 'slot 4 always 5m');
      assert.equal(m.ttl_downgrade_applied, fx.downgrade);
    });
  }
});
