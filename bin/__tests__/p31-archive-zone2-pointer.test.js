#!/usr/bin/env node
'use strict';

/**
 * P3.1 audit-round archive — Zone-2 pointer-substitution gate (AR-8).
 *
 * Spawns bin/compose-block-a.js against a tmp project root with an
 * active orchestration and a populated audit-round-archive sidecar
 * with one round-2 entry. Asserts:
 *   1. The composed Zone 2 contains `<audit-round-digest round="2"`.
 *   2. The digest_path attribute references the correct artifact.
 *   3. The verbatim transcript fixture text is NOT present in Zone 2
 *      (the negative assertion that proves the substitution happened
 *      — i.e. compose-block-a.js read the sidecar, not the raw events).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE   = path.join(REPO_ROOT, 'bin', 'compose-block-a.js');

let tmpDir;
const ORCH = 'orch-zone2-pointer-test';

const VERBATIM_SENTINEL = 'VERBATIM_FIXTURE_TEXT_THAT_MUST_NOT_LEAK_INTO_ZONE2';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-zone2-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'),     { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'),     { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'agents', 'pm-reference'),   { recursive: true });

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: ORCH, goal: 'zone2-test', constraints: [] }),
    'utf8'
  );

  // Stub the Zone 1 sources so compose-block-a.js still works.
  fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# stub\n', 'utf8');
  fs.writeFileSync(
    path.join(tmpDir, 'agents', 'pm-reference', 'handoff-contract.md'), 'stub', 'utf8'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'agents', 'pm-reference', 'phase-contract.md'),  'stub', 'utf8'
  );

  // Empty events.jsonl — keeps the audit-event-writer fail-open path quiet.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8'
  );

  // Disable schema-shadow validation in this tmp tree (no shadow file present).
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'config.json'),
    JSON.stringify({
      audit: { round_archive: { enabled: true, inline_digest_max_bytes: 3072 } },
      event_schema_shadow: { enabled: false },
    }),
    'utf8'
  );

  // Write the digest artifact.
  const digestRel  = path.join('.orchestray', 'kb', 'artifacts', ORCH + '-round-2-digest.md');
  const digestBody =
    '# Audit Round 2 Digest — ' + ORCH + '\n' +
    '> deterministic\n\n' +
    '## Findings\n' +
    '- **2.1.task-1.verify_fix_fail** [severity=n/a] [type=verify_fix_fail] task=task-1 round=2\n';
  fs.writeFileSync(path.join(tmpDir, digestRel), digestBody, 'utf8');

  // Sidecar entry — the substitution trigger.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'state', 'audit-round-archive.json'),
    JSON.stringify({
      archives: [{
        orchestration_id:      ORCH,
        round_n:               2,
        digest_path:           digestRel,
        full_transcript_bytes: 30182,
        digest_bytes:          digestBody.length,
        ratio:                 0.016,
        finding_ids:           ['2.1.task-1.verify_fix_fail'],
        mode:                  'deterministic',
        archived_at:           '2026-04-26T11:00:00.000Z',
      }],
      updated_at: '2026-04-26T11:00:00.000Z',
    }, null, 2),
    'utf8'
  );
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function runCompose() {
  const stdin = JSON.stringify({ cwd: tmpDir, prompt: 'noop' });
  const r = spawnSync('node', [COMPOSE], {
    cwd: tmpDir,
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, {
      // Ensure Block-A is active and shadow validation is bypassed
      // (test tmpdir has no shadow on disk; the config above also disables it).
      ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1',
    }),
  });
  return r;
}

function extractAdditionalContext(stdout) {
  const lines = (stdout || '').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.hookSpecificOutput &&
          typeof obj.hookSpecificOutput.additionalContext === 'string') {
        return obj.hookSpecificOutput.additionalContext;
      }
    } catch (_e) { /* try next line */ }
  }
  return '';
}

describe('P3.1 buildZone2 — audit-round-digest substitution', () => {
  test('Zone 2 contains <audit-round-digest round="2" pointer block', () => {
    const r = runCompose();
    assert.equal(r.status, 0,
                 'compose-block-a failed (status=' + r.status + ', stderr=' + r.stderr + ')');
    const ctx = extractAdditionalContext(r.stdout);
    assert.ok(ctx.length > 0,
              'compose-block-a must emit additionalContext. stdout=' + r.stdout);
    assert.match(ctx, /<audit-round-digest round="2"/,
                 'Zone 2 must contain <audit-round-digest round="2" pointer block. ctx=' + ctx);
    assert.match(ctx, /digest_path="\.orchestray\/kb\/artifacts\//,
                 'digest_path attribute must reference the artifact');
  });

  test('verbatim sentinel text is NOT present in Zone 2 (substitution proof)', () => {
    // Append the verbatim sentinel to events.jsonl. With the substitution
    // active, buildZone2 reads the sidecar (digest body) NOT the raw
    // events.jsonl, so the sentinel must NOT leak into the composed output.
    const verbatimEvent = JSON.stringify({
      version: 1,
      type: 'verify_fix_fail',
      orchestration_id: ORCH,
      round: 2,
      task_id: 'task-1',
      message: VERBATIM_SENTINEL,
    }) + '\n';
    fs.appendFileSync(
      path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
      verbatimEvent
    );

    const r = runCompose();
    assert.equal(r.status, 0);
    const ctx = extractAdditionalContext(r.stdout);
    assert.ok(!ctx.includes(VERBATIM_SENTINEL),
              'verbatim sentinel must NOT leak into Zone 2 (compose must read sidecar, not events.jsonl)');
  });
});
