#!/usr/bin/env node
'use strict';

/**
 * v229-changelog-naming-firewall.test.js — F3 part 2 acceptance test.
 *
 * Anti-regression contract:
 *   1. Synthetic CHANGELOG with `snapshot_taken` (typo, not in shadow) →
 *      firewall exits 2 with the typo named in stderr + a
 *      `changelog_naming_drift_detected` event in the audit log.
 *   2. Synthetic CHANGELOG with all-correct names → firewall exits 0.
 *   3. Token filter: backtick `null`, `true`, MCP-tool names with `__`, and
 *      single-token tokens (no underscore) are ignored.
 *   4. Synthetic CHANGELOG with NO version section → firewall exits 0
 *      (nothing to check).
 *   5. Kill switch is honored for non-release commits but NOT for --release.
 *   6. The unit-level `extractEventNameTokens` returns the expected token
 *      set for a hand-crafted body.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const SCRIPT     = path.join(REPO_ROOT, 'bin', 'release-manager', 'changelog-event-name-check.js');
const MODULE     = require(SCRIPT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-f3-firewall-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '');
  return dir;
}

function writeShadow(dir, eventTypes) {
  const shadow = { _meta: { version: 1, source_hash: 'fakehash', generated_at: new Date().toISOString(), shadow_size_bytes: 100, event_count: eventTypes.length } };
  for (const t of eventTypes) shadow[t] = { v: 1, r: 1, o: 0 };
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
    JSON.stringify(shadow),
  );
}

function writeChangelog(dir, content) {
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), content);
}

function runScript(repoDir, extraArgs = [], env = {}) {
  return spawnSync('node', [SCRIPT, '--cwd', repoDir, ...extraArgs], {
    cwd: repoDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function readEvents(dir) {
  const live = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(live)) return [];
  return fs.readFileSync(live, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.9 F3 — changelog-event-name-check.js', () => {
  test('CHANGELOG with `snapshot_taken` typo (not in shadow) → exit 2', () => {
    const dir = makeRepo();
    writeShadow(dir, ['snapshot_captured', 'agent_stop']);
    writeChangelog(dir, [
      '# Changelog',
      '',
      '## [2.2.9] - 2026-04-29',
      '',
      'Adds `snapshot_taken` and improves `agent_stop` reporting.',
      '',
      '## [2.2.8] - 2026-04-28',
      '',
      'Older release.',
      '',
    ].join('\n'));

    const r = runScript(dir);
    assert.equal(r.status, 2, `expected exit 2; got ${r.status} stderr=${r.stderr}`);
    assert.match(r.stderr, /snapshot_taken/, 'stderr must name the missing token');

    const events = readEvents(dir);
    const drift = events.filter((e) => e.type === 'changelog_naming_drift_detected');
    assert.equal(drift.length, 1, 'exactly one telemetry row expected');
    assert.deepEqual(drift[0].missing_tokens.sort(), ['snapshot_taken']);
    assert.match(drift[0].changelog_section, /\[2\.2\.9\]/);
  });

  test('CHANGELOG with all-correct names → exit 0', () => {
    const dir = makeRepo();
    writeShadow(dir, ['snapshot_captured', 'agent_stop', 'routing_outcome']);
    writeChangelog(dir, [
      '# Changelog',
      '',
      '## [2.2.9] - 2026-04-29',
      '',
      'Adds `snapshot_captured` and improves `agent_stop` reporting.',
      'Also tweaks `routing_outcome`.',
      '',
    ].join('\n'));

    const r = runScript(dir);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const drift = events.filter((e) => e.type === 'changelog_naming_drift_detected');
    assert.equal(drift.length, 0, 'no drift telemetry expected');
  });

  test('token filter: `null`, `true`, MCP `__` tokens, no-underscore tokens are ignored', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_stop']);
    writeChangelog(dir, [
      '# Changelog',
      '',
      '## [2.2.9] - 2026-04-29',
      '',
      'Mentions `null`, `true`, `mcp__orchestray__spawn_agent`, `Foo`, ' +
      'and `agent_stop`. None of those should trigger except event names.',
      '',
    ].join('\n'));

    const r = runScript(dir);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status} stderr=${r.stderr}`);
  });

  test('CHANGELOG with NO version section → exit 0', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_stop']);
    writeChangelog(dir, [
      '# Changelog',
      '',
      'Just some preamble. No version sections at all.',
      '',
    ].join('\n'));

    const r = runScript(dir);
    assert.equal(r.status, 0, `expected exit 0; got ${r.status} stderr=${r.stderr}`);
  });

  test('kill switch honored for non-release commits but NOT for --release', () => {
    const dir = makeRepo();
    writeShadow(dir, ['agent_stop']);
    writeChangelog(dir, [
      '# Changelog',
      '',
      '## [2.2.9] - 2026-04-29',
      '',
      'Mentions `bogus_event_name`.',
      '',
    ].join('\n'));

    const noKill = runScript(dir);
    assert.equal(noKill.status, 2, 'baseline must drift');

    const withKill = runScript(dir, [], { ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED: '1' });
    assert.equal(withKill.status, 0, 'kill switch must short-circuit non-release commit');

    const releaseStrict = runScript(dir, ['--release'], { ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED: '1' });
    assert.equal(releaseStrict.status, 2, 'release commit must NOT honor kill switch');
  });

  test('extractEventNameTokens unit — token shape filter', () => {
    const tokens = MODULE.extractEventNameTokens(
      'mentions `agent_stop`, `null`, `loop_complete`, `mcp__orchestray__schema_get`, `MyClass`, `routing_outcome`'
    );
    const sorted = Array.from(tokens).sort();
    assert.deepEqual(sorted, ['agent_stop', 'loop_complete', 'routing_outcome']);
  });

  test('extractTopSection picks the topmost ## [<x>] heading', () => {
    const { header, body } = MODULE.extractTopSection([
      '# Changelog',
      '',
      '## [2.2.9] - 2026-04-29',
      '',
      'New stuff: `event_a`.',
      '',
      '## [2.2.8] - 2026-04-28',
      '',
      'Older: `event_b`.',
    ].join('\n'));
    assert.equal(header, '[2.2.9] - 2026-04-29');
    assert.match(body, /event_a/);
    assert.doesNotMatch(body, /event_b/);
  });
});
