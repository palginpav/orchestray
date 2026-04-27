#!/usr/bin/env node
'use strict';

/**
 * P2.1 Block-Z invalidation (v2.2.0).
 *
 * Asserts that invalidate-block-a-zone1.js --watch-pm-md detects drift in
 * any of the four Block-Z component files (agents/pm.md, CLAUDE.md,
 * handoff-contract.md, phase-contract.md), clears the persisted manifest's
 * block_z_hash, and emits block_a_zone1_invalidated with
 * block_z_invalidated:true and block_z_components_changed:[<changed file>].
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', 'invalidate-block-a-zone1.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-invalidate-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  // Components
  const pmContent      = 'PM body initial\n';
  const claudeContent  = 'CLAUDE body initial\n';
  const handoffContent = 'handoff body initial\n';
  const phaseContent   = 'phase body initial\n';
  fs.writeFileSync(path.join(dir, 'agents', 'pm.md'),                                pmContent);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),                                       claudeContent);
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'), handoffContent);
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'phase-contract.md'),    phaseContent);
  // Persist a manifest with the original SHAs and a non-null block_z_hash.
  const manifest = {
    slots: [
      { slot: 1, ttl: '1h', marker_byte_offset: 100, prefix_hash: 'a'.repeat(64), prefix_token_estimate: 25 },
      { slot: 2, ttl: '1h', marker_byte_offset: 200, prefix_hash: 'a'.repeat(64), prefix_token_estimate: 50 },
      { slot: 3, ttl: '5m', marker_byte_offset: 250, prefix_hash: 'a'.repeat(64), prefix_token_estimate: 62 },
      { slot: 4, ttl: '5m', marker_byte_offset: 300, prefix_hash: 'a'.repeat(64), prefix_token_estimate: 75 },
    ],
    total_bytes: 300,
    ttl_downgrade_applied: false,
    block_z_hash: 'b'.repeat(64),
    block_z_components: [
      { name: 'agents/pm.md',                                  sha: sha256(Buffer.from(pmContent)),      byte_offset: 0 },
      { name: 'CLAUDE.md',                                     sha: sha256(Buffer.from(claudeContent)),  byte_offset: 100 },
      { name: 'agents/pm-reference/handoff-contract.md',       sha: sha256(Buffer.from(handoffContent)), byte_offset: 200 },
      { name: 'agents/pm-reference/phase-contract.md',         sha: sha256(Buffer.from(phaseContent)),   byte_offset: 300 },
    ],
    composed_at: new Date().toISOString(),
    error: null,
  };
  fs.writeFileSync(path.join(dir, '.orchestray', 'state', 'cache-breakpoint-manifest.json'),
    JSON.stringify(manifest, null, 2));
  // Also seed a block-a-zones.json with a non-null zone1_hash so the script
  // does not bail on "nothing to clear".
  fs.writeFileSync(path.join(dir, '.orchestray', 'state', 'block-a-zones.json'),
    JSON.stringify({ zone1_hash: 'c'.repeat(64), zone2_hash: 'd'.repeat(64), updated_at: new Date().toISOString() }, null, 2));
  return dir;
}

function readEvents(cwd) {
  const events = [];
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return events;
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (_e) {}
  }
  return events;
}

describe('P2.1 Block-Z invalidation (--watch-pm-md flag)', () => {
  test('component drift in agents/pm.md → block_z_invalidated:true, components_changed:["agents/pm.md"]', () => {
    const cwd = makeRepo();
    // Mutate pm.md
    fs.appendFileSync(path.join(cwd, 'agents', 'pm.md'), 'NEW BYTES\n');
    const r = spawnSync('node', [SCRIPT, 'P2.1 test', '--watch-pm-md'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { ORCHESTRAY_CWD: cwd }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(r.status, 0, 'invalidator must exit 0; stderr=' + r.stderr);
    // Manifest's block_z_hash should now be cleared
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'state', 'cache-breakpoint-manifest.json'), 'utf8'));
    assert.equal(manifest.block_z_hash, null, 'manifest.block_z_hash must be cleared');
    // Audit event records the change
    const events = readEvents(cwd).filter(e => e.type === 'block_a_zone1_invalidated');
    assert.ok(events.length >= 1, 'block_a_zone1_invalidated must be emitted');
    const ev = events[events.length - 1];
    assert.equal(ev.block_z_invalidated, true);
    assert.deepEqual(ev.block_z_components_changed, ['agents/pm.md']);
  });

  test('no component drift → block_z_invalidated:false, components_changed:[]', () => {
    const cwd = makeRepo();
    // Do NOT modify any component
    const r = spawnSync('node', [SCRIPT, 'no-drift', '--watch-pm-md'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { ORCHESTRAY_CWD: cwd }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(r.status, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'state', 'cache-breakpoint-manifest.json'), 'utf8'));
    // block_z_hash should still be present (no drift detected)
    assert.equal(manifest.block_z_hash, 'b'.repeat(64));
    const events = readEvents(cwd).filter(e => e.type === 'block_a_zone1_invalidated');
    assert.ok(events.length >= 1);
    const ev = events[events.length - 1];
    assert.equal(ev.block_z_invalidated, false);
    assert.deepEqual(ev.block_z_components_changed, []);
  });

  test('CLAUDE.md drift detected even without --watch-pm-md only-flag misuse', () => {
    const cwd = makeRepo();
    fs.appendFileSync(path.join(cwd, 'CLAUDE.md'), 'CLAUDE CHANGE');
    const r = spawnSync('node', [SCRIPT, 'claude-drift', '--watch-pm-md'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { ORCHESTRAY_CWD: cwd }),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(r.status, 0);
    const events = readEvents(cwd).filter(e => e.type === 'block_a_zone1_invalidated');
    const ev = events[events.length - 1];
    assert.deepEqual(ev.block_z_components_changed, ['CLAUDE.md']);
  });
});
