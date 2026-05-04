#!/usr/bin/env node
'use strict';

/**
 * v2.2.0 post-upgrade banner regression tests — F-003 (P2.1+P2.2 fix-pass)
 * extended for the pre-ship cross-phase fix-pass to cover all NINE
 * default-on flips.
 *
 * The v2.2.0 release ships NINE default-on flips:
 *   P2.1
 *   1. caching.block_z.enabled                  (Block-Z prefix)
 *   2. caching.engineered_breakpoints.enabled   (4-slot manifest)
 *   P2.2
 *   3. haiku_routing.enabled                    (Haiku scout for PM I/O)
 *   P3.3
 *   4. haiku_routing.housekeeper_enabled        (orchestray-housekeeper subagent)
 *   P1.2
 *   5. output_shape.enabled                     (caveman + length cap + structured outputs)
 *   P1.3
 *   6. pm_protocol.tier2_index.enabled          (chunked schema lookup)
 *   7. event_schemas.full_load_disabled         (D-8: legacy full Read blocked)
 *   P3.2
 *   8. pm_protocol.delegation_delta.enabled     (delta spawn-context)
 *   P3.1
 *   9. audit.round_archive.enabled              (multi-round audit digests)
 *
 * Per the locked-scope §default-on policy and feedback_default_on_shipping.md,
 * the post-upgrade sweep MUST emit a one-time stderr banner naming each flip
 * and the corresponding env-var or per-config kill switch.
 *
 * Without the banner, a regression-detecting user has no idea which flag to
 * flip. This test pins the banner contents so a future refactor cannot
 * silently drop them.
 *
 * Test pattern mirrors tests/regression/v2114-r-flags.test.js — write a
 * well-formed upgrade sentinel, spawn the sweep with a session that predates
 * the install, and assert the stderr text.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const SWEEP_SCRIPT = path.resolve(REPO_ROOT, 'bin', 'post-upgrade-sweep.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
    try { fs.unlinkSync(d); } catch (_e) {}
  }
});

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-'));
  cleanup.push(dir);
  return dir;
}

/**
 * Run post-upgrade-sweep.js with a sentinel present (Case C — session
 * predates install) so the upgrade nudge fires. Returns spawn result.
 */
function runSweepForBanner(projectDir, sentinelPath, sessionId) {
  const installedAtMs = Date.now() - 5000;
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify({
    schema_version: 2,
    installed_at_ms: installedAtMs,
    installed_at: new Date(installedAtMs).toISOString(),
    version: '2.2.0',
    previous_version: '2.1.17',
    restart_gated_features: [],
  }), 'utf8');

  fs.mkdirSync(path.join(projectDir, '.orchestray', 'state'), { recursive: true });

  const encoded = '-' + projectDir.replace(/^\//, '').replace(/\//g, '-');
  const fakeHome = path.join(os.tmpdir(), 'v220-banner-claude-' + process.pid + '-' + Date.now());
  const transcriptDir = path.join(fakeHome, '.claude', 'projects', encoded);
  fs.mkdirSync(transcriptDir, { recursive: true });
  cleanup.push(fakeHome);

  const transcriptPath = path.join(transcriptDir, sessionId + '.jsonl');
  fs.writeFileSync(transcriptPath, '{}', 'utf8');
  const oldMs = (installedAtMs - 60000) / 1000;
  fs.utimesSync(transcriptPath, oldMs, oldMs);

  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: projectDir,
  });

  const result = spawnSync(process.execPath, [SWEEP_SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, {
      ORCHESTRAY_TEST_SENTINEL_PATH: sentinelPath,
      HOME: fakeHome,
      // dispatch collapses >2 banners into a single summary line; this
      // regression asserts on banner content text, so request the verbatim-fire
      // path via the documented escape hatch.
      ORCHESTRAY_MIGRATION_BANNERS_ALL: '1',
    }),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

describe('v2.2.0 post-upgrade banner (F-003 fix-pass)', () => {

  test('banner names Block-Z default-on flip + ORCHESTRAY_DISABLE_BLOCK_Z', () => {
    const projectDir  = makeTmpProject();
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-sentinel-'));
    cleanup.push(sentinelDir);
    const sentinelPath = path.join(sentinelDir, '.orchestray-upgrade-pending');

    const sessionId = 'aabbccdd-2200-0001-0001-000000000001';
    cleanup.push(path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId));
    cleanup.push(path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock'));

    const result = runSweepForBanner(projectDir, sentinelPath, sessionId);

    assert.equal(result.status, 0,
      'sweep must exit 0 (fail-open). stderr=' + result.stderr);
    assert.match(result.stderr, /v2\.2\.0 migration/,
      'banner must announce v2.2.0 migration. Got: ' + result.stderr);
    assert.match(result.stderr, /caching\.block_z\.enabled: true/,
      'banner must name caching.block_z.enabled: true');
    assert.match(result.stderr, /ORCHESTRAY_DISABLE_BLOCK_Z=1/,
      'banner must name ORCHESTRAY_DISABLE_BLOCK_Z=1 kill switch');
  });

  test('banner names engineered-breakpoints default-on flip + kill switch', () => {
    const projectDir  = makeTmpProject();
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-sentinel-'));
    cleanup.push(sentinelDir);
    const sentinelPath = path.join(sentinelDir, '.orchestray-upgrade-pending');

    const sessionId = 'aabbccdd-2200-0001-0002-000000000002';
    cleanup.push(path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId));
    cleanup.push(path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock'));

    const result = runSweepForBanner(projectDir, sentinelPath, sessionId);

    assert.match(result.stderr, /caching\.engineered_breakpoints\.enabled: true/,
      'banner must name caching.engineered_breakpoints.enabled: true');
    assert.match(result.stderr, /strict_invariant stays\s+false/,
      'banner must clarify strict_invariant remains false in v2.2.0');
    assert.match(result.stderr, /ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS=1/,
      'banner must name ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS=1 kill switch');
  });

  test('banner names haiku_routing default-on flip + ORCHESTRAY_HAIKU_ROUTING_DISABLED', () => {
    const projectDir  = makeTmpProject();
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-sentinel-'));
    cleanup.push(sentinelDir);
    const sentinelPath = path.join(sentinelDir, '.orchestray-upgrade-pending');

    const sessionId = 'aabbccdd-2200-0001-0003-000000000003';
    cleanup.push(path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId));
    cleanup.push(path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock'));

    const result = runSweepForBanner(projectDir, sentinelPath, sessionId);

    assert.match(result.stderr, /haiku_routing\.enabled: true/,
      'banner must name haiku_routing.enabled: true');
    assert.match(result.stderr, /scout_min_bytes: 12288/,
      'banner must name the scout_min_bytes threshold');
    assert.match(result.stderr, /ORCHESTRAY_HAIKU_ROUTING_DISABLED=1/,
      'banner must name ORCHESTRAY_HAIKU_ROUTING_DISABLED=1 per-session opt-out');
  });

  test('banner fires once per session — second invocation is silent on the same session_id', () => {
    const projectDir  = makeTmpProject();
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-sentinel-'));
    cleanup.push(sentinelDir);
    const sentinelPath = path.join(sentinelDir, '.orchestray-upgrade-pending');

    const sessionId = 'aabbccdd-2200-0001-0004-000000000004';
    cleanup.push(path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId));
    cleanup.push(path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock'));

    const first = runSweepForBanner(projectDir, sentinelPath, sessionId);
    assert.match(first.stderr, /v2\.2\.0 migration/,
      'first invocation must emit v2.2.0 banner');

    // Second run with same session_id should not re-emit (per-session marker).
    // The sentinel may have been unlinked (Case D once warned-marker exists);
    // if so, the second run is silent because the sentinel is gone.
    // Either way, the v2.2.0 banner must NOT appear twice in this session.
    const second = runSweepForBanner(projectDir, sentinelPath, sessionId);
    assert.doesNotMatch(second.stderr, /v2\.2\.0 migration: Block-Z prefix is enabled/,
      'second invocation in same session must NOT re-emit the Block-Z banner');
  });

  // -------------------------------------------------------------------------
  // F-003 (v2.2.0 pre-ship cross-phase fix-pass): expand to 9-of-9 flips.
  // The original F-003 fix landed banner lines for 4 of 9 flips. This block
  // pins each of the additional five so a future refactor cannot silently
  // drop any of them.
  // -------------------------------------------------------------------------

  test('banner names ALL 9 of 9 default-on v2.2.0 flips on first session post-upgrade', () => {
    const projectDir  = makeTmpProject();
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-sentinel-'));
    cleanup.push(sentinelDir);
    const sentinelPath = path.join(sentinelDir, '.orchestray-upgrade-pending');

    const sessionId = 'aabbccdd-2200-0001-0009-000000000009';
    cleanup.push(path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId));
    cleanup.push(path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock'));

    const result = runSweepForBanner(projectDir, sentinelPath, sessionId);

    assert.equal(result.status, 0,
      'sweep must exit 0 (fail-open). stderr=' + result.stderr);

    // The full 9-flip ledger. Each entry must appear in stderr; the
    // numbered comment matches the ledger in the file header.
    const requiredBannerSignals = [
      // P2.1
      /caching\.block_z\.enabled: true/,
      /caching\.engineered_breakpoints\.enabled: true/,
      // P2.2
      /haiku_routing\.enabled: true/,
      // P3.3
      /haiku_routing\.housekeeper_enabled: true/,
      // P1.2
      /output_shape\.enabled: true/,
      // P1.3
      /pm_protocol\.tier2_index\.enabled: true/,
      /event_schemas\.full_load_disabled: true/,
      // P3.2
      /pm_protocol\.delegation_delta\.enabled: true/,
      // P3.1
      /audit\.round_archive\.enabled: true/,
    ];

    for (const re of requiredBannerSignals) {
      assert.match(
        result.stderr, re,
        'F-003 regression: post-upgrade banner missing default-on flip matching ' +
        re.toString() + '. The v2.2.0 banner must announce ALL 9 flips. ' +
        'Got stderr:\n' + result.stderr,
      );
    }
  });

  test('banner names the kill switch / restoration step for each of the 5 added flips', () => {
    const projectDir  = makeTmpProject();
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v220-banner-sentinel-'));
    cleanup.push(sentinelDir);
    const sentinelPath = path.join(sentinelDir, '.orchestray-upgrade-pending');

    const sessionId = 'aabbccdd-2200-0001-0010-000000000010';
    cleanup.push(path.join(os.tmpdir(), 'orchestray-upgrade-warned-' + sessionId));
    cleanup.push(path.join(os.tmpdir(), 'orchestray-sweep-' + sessionId + '.lock'));

    const result = runSweepForBanner(projectDir, sentinelPath, sessionId);

    // Each of the five new banners must name a concrete restoration / kill
    // switch — operators need to know exactly which key to flip.
    assert.match(result.stderr, /pm_protocol\.tier2_index\.enabled: false/,
      'tier2-index banner must name the per-config disable step');
    assert.match(result.stderr, /event_schemas\.full_load_disabled: false/,
      'full-load-disabled banner must name how to restore legacy full Read');
    assert.match(result.stderr, /ORCHESTRAY_DISABLE_DELEGATION_DELTA=1/,
      'delegation-delta banner must name the per-session env opt-out');
    assert.match(result.stderr, /pm_protocol\.delegation_delta\.enabled: false/,
      'delegation-delta banner must also name the permanent per-config disable');
    assert.match(result.stderr, /audit\.round_archive\.enabled: false/,
      'round-archive banner must name the per-config disable step');
    assert.match(result.stderr, /output_shape\.staged_flip_allowlist/,
      'output-shape banner must reference the staged_flip_allowlist (operator-tunable)');
  });
});
