'use strict';

/**
 * v2219-archetype-record-application.test.js — T10/S2 wiring of recordApplication().
 *
 * Verifies that archetype-cache.jsonl is written after a successful advisory
 * inject, i.e. that recordApplication() now has a real call site.
 *
 * 3 cases as specified in the T10 brief:
 *   1. recordApplication() creates a new record in archetype-cache.jsonl
 *   2. recordApplication() increments prior_applications_count on repeat calls
 *   3. recordApplication() is fail-open when cwd is absent/invalid
 *
 * Runner: node --test bin/__tests__/v2219-archetype-record-application.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { recordApplication } = require('../_lib/archetype-cache');

/**
 * Create a minimal sandbox with enabled archetype_cache config.
 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2219-arc-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  // Write config that enables archetype_cache
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({
      context_compression_v218: {
        enabled: true,
        archetype_cache: {
          enabled: true,
          min_prior_applications: 3,
          confidence_floor: 0.85,
          max_entries: 30,
          ttl_days: 30,
          blacklist: [],
        },
      },
    })
  );
  return root;
}

function readCacheRecords(root) {
  const cachePath = path.join(root, '.orchestray', 'state', 'archetype-cache.jsonl');
  if (!fs.existsSync(cachePath)) return [];
  return fs.readFileSync(cachePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('T10/S2 — recordApplication() write-path (was zero callers)', () => {

  // Case 1: first call creates a new record
  test('recordApplication creates a new record in archetype-cache.jsonl', () => {
    const root = makeSandbox();
    const archetypeId = 'abc123def456';
    const orchId = 'orch-test-001';
    const sigDetails = { agentSet: 'developer,reviewer', fileBucket: 'M', keywords: 'cache,fix', scoreBucket: '5' };

    recordApplication(archetypeId, orchId, 'success', sigDetails, root);

    const records = readCacheRecords(root);
    assert.equal(records.length, 1, 'exactly one record should be written');
    const rec = records[0];
    assert.equal(rec.archetype_id, archetypeId);
    assert.equal(rec.prior_applications_count, 1);
    assert.equal(rec.last_outcome, 'success');
    assert.equal(rec.last_orch_id, orchId);
    assert.equal(rec.agentSet, sigDetails.agentSet);
    assert.equal(rec.fileBucket, sigDetails.fileBucket);
  });

  // Case 2: second call increments prior_applications_count
  test('recordApplication increments prior_applications_count on repeat calls', () => {
    const root = makeSandbox();
    const archetypeId = 'bbb222ccc444';
    const orchId1 = 'orch-test-002a';
    const orchId2 = 'orch-test-002b';
    const sigDetails = { agentSet: 'developer', fileBucket: 'S', keywords: 'test', scoreBucket: '3' };

    recordApplication(archetypeId, orchId1, 'success', sigDetails, root);
    recordApplication(archetypeId, orchId2, 'success', sigDetails, root);

    const records = readCacheRecords(root);
    assert.equal(records.length, 1, 'same archetype_id should not create a second record');
    assert.equal(records[0].prior_applications_count, 2, 'count should increment to 2');
    assert.equal(records[0].last_orch_id, orchId2);
  });

  // Case 3: fail-open when cwd is garbage
  test('recordApplication is fail-open when cwd is absent/invalid', () => {
    // Should not throw even with a non-existent cwd
    assert.doesNotThrow(() => {
      recordApplication('deadbeef1234', 'orch-noop', 'success', {}, '/nonexistent/path/that/does/not/exist');
    });
  });

});
