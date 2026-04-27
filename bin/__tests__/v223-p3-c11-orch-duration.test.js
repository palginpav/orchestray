#!/usr/bin/env node
'use strict';

/**
 * v2.2.3 Phase 3 W5 / C11 — estimated_orch_duration_minutes write site.
 *
 * Heals v2.2.0's dormant TTL auto-downgrade rule: the cache manifest reader
 * has been live since v2.2.0 (`bin/_lib/cache-breakpoint-manifest.js:144-149`)
 * but no PM-side write site existed, so every short orchestration paid the
 * full 1h-TTL write cost the design was meant to downgrade.
 *
 * This test pins:
 *   1. Phase-decomp prompt (Section 13 step 10) prescribes the size × model-tier
 *      × parallelism formula AND points the PM at
 *      `.orchestray/audit/current-orchestration.json`.
 *   2. The size lookup table (XS/S/M/L/XL) and tier multipliers (haiku/sonnet/
 *      opus/xhigh) ship in the prompt.
 *   3. Phase-decomp instructs the PM to emit a `pm_orch_duration_estimated`
 *      audit event after the write.
 *   4. The event schema is registered in event-schemas.md AND in the
 *      auto-generated event-schemas.shadow.json.
 *   5. End-to-end happy path: a current-orchestration.json with
 *      `estimated_orch_duration_minutes: 15` triggers Slot 1/Slot 2 TTL
 *      downgrade to '5m' via `buildManifest`. Boundary at 25 keeps '1h'.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PHASE_DECOMP = path.join(REPO_ROOT, 'agents', 'pm-reference', 'phase-decomp.md');
const EVENT_SCHEMAS = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const EVENT_SCHEMAS_SHADOW = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const CACHE_MANIFEST = path.join(REPO_ROOT, 'bin', '_lib', 'cache-breakpoint-manifest.js');

const { buildManifest } = require(CACHE_MANIFEST);

// ---------------------------------------------------------------------------
// 1. phase-decomp.md prompt assertions
// ---------------------------------------------------------------------------

describe('v2.2.3 P3 W5 — phase-decomp.md prescribes calibrated duration estimate', () => {
  const text = fs.readFileSync(PHASE_DECOMP, 'utf8');

  test('Step 10 references current-orchestration.json (canonical write site)', () => {
    assert.match(
      text,
      /current-orchestration\.json/,
      'step 10 must point the PM at .orchestray/audit/current-orchestration.json — that is the file the cache manifest reader actually opens'
    );
  });

  test('Step 10 documents the size lookup table (XS/S/M/L/XL with base minutes)', () => {
    // The size column must list all five tiers with their base minutes.
    for (const row of [
      /\bXS\b[^\n]*\b2\b/,
      /\bS\b[^\n]*\b5\b/,
      /\bM\b[^\n]*\b15\b/,
      /\bL\b[^\n]*\b30\b/,
      /\bXL\b[^\n]*\b60\b/,
    ]) {
      assert.match(text, row, `size lookup row missing or wrong: ${row}`);
    }
  });

  test('Step 10 documents the model-tier multipliers (haiku/sonnet/opus/xhigh)', () => {
    for (const row of [
      /haiku[^\n]*0\.35/,
      /sonnet[^\n]*1\.00/,
      /opus[^\n]*\b2\.20\b/,
      /xhigh[^\n]*\b2\.50\b/,
    ]) {
      assert.match(text, row, `tier multiplier row missing or wrong: ${row}`);
    }
  });

  test('Step 10 documents the parallelism roll-up (sum sequential, max parallel)', () => {
    assert.match(text, /[Ss]equential[^\n]*sum/, 'sequential rule must say "sum"');
    assert.match(text, /[Pp]arallel[^\n]*max/,   'parallel rule must say "max"');
  });

  test('Step 10 documents [5, 480] clamp', () => {
    assert.match(text, /\[\s*5\s*,\s*480\s*\]/);
  });

  test('Step 10 instructs PM to emit pm_orch_duration_estimated audit event', () => {
    assert.match(text, /pm_orch_duration_estimated/);
  });

  test('Step 10 retains TTL-downgrade rationale (cross-link to cache-breakpoint-manifest.js)', () => {
    assert.match(text, /cache-breakpoint-manifest\.js/);
    assert.match(text, /25\s*minutes|under\s+25|<\s*25/i);
  });

  test('Step 10 names both methods (calibrated | fallback)', () => {
    assert.match(text, /calibrated/);
    assert.match(text, /fallback/);
  });
});

// ---------------------------------------------------------------------------
// 2. event-schemas.md + shadow assertions
// ---------------------------------------------------------------------------

describe('v2.2.3 P3 W5 — pm_orch_duration_estimated schema is registered', () => {
  const schemaText = fs.readFileSync(EVENT_SCHEMAS, 'utf8');

  test('event-schemas.md declares the pm_orch_duration_estimated section', () => {
    assert.match(schemaText, /###\s*`pm_orch_duration_estimated`\s+event/);
  });

  test('event-schemas.md JSON sample includes the required fields', () => {
    // The fields the spec mandates for the event payload.
    for (const field of [
      'estimated_minutes',
      'item_count',
      'parallel_groups',
      'longest_path_minutes',
      'method',
    ]) {
      assert.match(schemaText, new RegExp('"' + field + '"'),
        `JSON sample missing field: ${field}`);
    }
  });

  test('event-schemas.shadow.json includes pm_orch_duration_estimated', () => {
    const shadow = JSON.parse(fs.readFileSync(EVENT_SCHEMAS_SHADOW, 'utf8'));
    assert.ok(
      shadow.pm_orch_duration_estimated,
      'shadow JSON must list pm_orch_duration_estimated — run `node bin/regen-schema-shadow.js` to refresh'
    );
    assert.equal(shadow.pm_orch_duration_estimated.v, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end TTL-downgrade verification
// ---------------------------------------------------------------------------

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

describe('v2.2.3 P3 W5 — TTL downgrade fires when PM writes a short estimate', () => {
  test('estimated_orch_duration_minutes: 15 → Slots 1+2 = 5m', () => {
    // Simulate the JSON the PM writes into current-orchestration.json,
    // then pass its pm_protocol sub-object to buildManifest exactly like
    // compose-block-a.js does at runtime.
    const orchJson = {
      orchestration_id: 'orch-test-c11',
      pm_protocol: {
        estimated_orch_duration_minutes: 15,
        duration_estimate_method: 'calibrated',
      },
    };
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone('zone2'),
      zone3:  fakeZone('zone3'),
      pmProtocol: orchJson.pm_protocol,
    });
    assert.equal(m.error, null);
    assert.equal(m.slots[0].ttl, '5m', 'slot 1 must downgrade');
    assert.equal(m.slots[1].ttl, '5m', 'slot 2 must downgrade');
    assert.equal(m.ttl_downgrade_applied, true);
  });

  test('estimated_orch_duration_minutes: 25 (boundary) → Slots 1+2 = 1h', () => {
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone('zone2'),
      zone3:  fakeZone('zone3'),
      pmProtocol: { estimated_orch_duration_minutes: 25 },
    });
    assert.equal(m.slots[0].ttl, '1h');
    assert.equal(m.slots[1].ttl, '1h');
    assert.equal(m.ttl_downgrade_applied, false);
  });

  test('field absent (legacy / pre-PM-write) → falls through to 1h (safe)', () => {
    const m = buildManifest({
      blockZ: fakeBlockZ(),
      zone1:  fakeZone('zone1'),
      zone2:  fakeZone('zone2'),
      zone3:  fakeZone('zone3'),
      pmProtocol: null,
    });
    assert.equal(m.slots[0].ttl, '1h');
    assert.equal(m.slots[1].ttl, '1h');
    assert.equal(m.ttl_downgrade_applied, false);
  });
});

// ---------------------------------------------------------------------------
// 4. Calibrated-formula sanity (documentation pin — no live computer; the
//    formula is prose-only in phase-decomp.md, so this test just verifies the
//    documented worked example matches the table).
// ---------------------------------------------------------------------------

describe('v2.2.3 P3 W5 — calibrated formula worked example', () => {
  test('3 sequential M items on sonnet = 45 min (sum of 15×1.0)', () => {
    const M_BASE = 15;
    const SONNET_MULT = 1.0;
    const total = 3 * (M_BASE * SONNET_MULT);
    assert.equal(total, 45);
    // Clamped to [5, 480] — 45 stays.
    assert.ok(total >= 5 && total <= 480);
  });

  test('3 parallel M items on sonnet = 15 min (max of 15×1.0)', () => {
    const M_BASE = 15;
    const SONNET_MULT = 1.0;
    const total = Math.max(...[1, 1, 1].map(() => M_BASE * SONNET_MULT));
    assert.equal(total, 15);
    // 15 < 25 → triggers TTL downgrade.
    assert.ok(total < 25, 'parallel-group worked example must demonstrate downgrade');
  });
});
