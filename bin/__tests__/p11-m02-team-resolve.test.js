#!/usr/bin/env node
'use strict';

/**
 * p11-m02-team-resolve.test.js — P1.1 M0.2 teammate model resolver.
 *
 * Verifies bin/_lib/team-config-resolve.js:
 *   1. Forward-look: 'haiku-scout' → 'haiku' without disk read.
 *   2. Forward-look: 'pm-router' → 'haiku'.
 *   3. Frontmatter match: agents/architect.md `model: opus` → 'opus'.
 *   4. 'inherit' frontmatter → 'unknown_team_member'.
 *   5. Integration: SubagentStop with unknown agent_type writes
 *      model_used='unknown_team_member' + cost_confidence='estimated'.
 *   6. Missing agents/ dir: resolver returns 'unknown_team_member' without throw.
 *
 * Runner: node --test bin/__tests__/p11-m02-team-resolve.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const RESOLVER_PATH = path.resolve(__dirname, '..', '_lib', 'team-config-resolve.js');
const HOOK_SCRIPT   = path.resolve(__dirname, '..', 'collect-agent-metrics.js');

let tmpDir;
let resolver;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-p11-m02-'));
  // Re-require fresh so the per-process cache is empty per test.
  delete require.cache[require.resolve(RESOLVER_PATH)];
  resolver = require(RESOLVER_PATH);
  resolver._resetForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (resolver && resolver._resetForTest) resolver._resetForTest();
});

/** Write an agent definition file with given frontmatter. */
function writeAgentDef(slug, modelValue) {
  const dir = path.join(tmpDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${slug}\nmodel: ${modelValue}\n---\n\n# ${slug}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), body, 'utf8');
}

// --- Tests ------------------------------------------------------------------

test('forward-look: haiku-scout resolves to haiku without disk read', () => {
  // No agents/ dir present.
  assert.equal(resolver.resolveTeammateModel('haiku-scout', tmpDir), 'haiku');
});

test('forward-look: pm-router resolves to haiku', () => {
  assert.equal(resolver.resolveTeammateModel('pm-router', tmpDir), 'haiku');
});

// W6 S-003: forward-look must be exact match only. A crafted agent_type
// containing the substring (e.g. `evil-haiku-scout-suffix`) MUST NOT resolve
// to 'haiku' — that would let a malicious / typoed name silently downgrade
// the model tier and pay Haiku rates for what may be a Sonnet/Opus spawn.
test('forward-look exact-match only: substring containing haiku-scout does NOT resolve to haiku', () => {
  assert.equal(resolver.resolveTeammateModel('evil-haiku-scout-suffix', tmpDir), 'unknown_team_member');
  assert.equal(resolver.resolveTeammateModel('haiku-scout-v2', tmpDir), 'unknown_team_member');
  assert.equal(resolver.resolveTeammateModel('legacy-pm-router', tmpDir), 'unknown_team_member');
  // Sanity: exact match still works.
  assert.equal(resolver.resolveTeammateModel('haiku-scout', tmpDir), 'haiku');
  assert.equal(resolver.resolveTeammateModel('pm-router', tmpDir), 'haiku');
});

test('frontmatter match: agents/architect.md model:opus → opus', () => {
  writeAgentDef('architect', 'opus');
  assert.equal(resolver.resolveTeammateModel('architect', tmpDir), 'opus');
});

test('inherit: agents/<x>.md model:inherit → unknown_team_member', () => {
  writeAgentDef('inheritor', 'inherit');
  assert.equal(resolver.resolveTeammateModel('inheritor', tmpDir), 'unknown_team_member');
});

test('no agents dir present: resolver returns unknown_team_member without throwing', () => {
  // No agents/ dir; non-forward-look name.
  assert.equal(resolver.resolveTeammateModel('xyz-unknown', tmpDir), 'unknown_team_member');
});

test('integration: SubagentStop with unknown agent_type writes unknown_team_member + estimated', () => {
  // Seed orchestration, no agents/ dir, fake agent_type that no resolver tier matches.
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'O-int' }),
    'utf8'
  );
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');

  // Build a synthetic transcript so token usage is non-zero (drives cost path).
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const transcript = [
    JSON.stringify({ role: 'user', content: 'go' }),
    JSON.stringify({
      role: 'assistant',
      content: 'done',
      model: null,
      timestamp: '2026-04-26T17:00:00.000Z',
      usage: { input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  ].join('\n') + '\n';
  fs.writeFileSync(transcriptPath, transcript, 'utf8');

  const payload = {
    hook_event_name: 'SubagentStop',
    cwd: tmpDir,
    agent_id: 'A-int',
    agent_type: 'fake-team-member',
    session_id: 's',
    agent_transcript_path: transcriptPath,
  };

  const r = spawnSync('node', [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    env: process.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0, 'hook exits 0; stderr=' + (r.stderr || ''));

  const metricsPath = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  assert.ok(fs.existsSync(metricsPath), 'metrics file written');
  const rows = fs.readFileSync(metricsPath, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawn = rows.find((r) => r.row_type === 'agent_spawn');
  assert.ok(spawn, 'agent_spawn row present');
  assert.equal(spawn.model_used, 'unknown_team_member', 'model_used labeled unknown_team_member');
  assert.equal(spawn.cost_confidence, 'estimated', 'cost_confidence flipped to estimated');

  // Spot-check that cost is computed at sonnet rates (since unknown_team_member
  // contains none of opus/haiku/sonnet substrings, getPricing returns sonnet).
  // sonnet: input $3/M, output $15/M → 10000*3/1e6 + 2000*15/1e6 = 0.03 + 0.03 = 0.06
  assert.ok(spawn.estimated_cost_usd > 0.05 && spawn.estimated_cost_usd < 0.07,
    `expected ~$0.06 at sonnet rate; got ${spawn.estimated_cost_usd}`);
});
