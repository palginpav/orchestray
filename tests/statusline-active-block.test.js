'use strict';

/**
 * statusline-active-block.test.js — F-19 (v2.2.21)
 *
 * Companion to statusline-idle-suppress.test.js. The active-block render path
 * MUST remain byte-identical to the v2.2.20 baseline when:
 *   - one or more subagents are active, OR
 *   - parent prompt fill ≥ warn threshold, OR
 *   - cache is stale.
 *
 * This test pins the active-path output shape so the F-19 idle-suppress
 * change cannot regress the active-path block.
 */

const test     = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const { spawnSync } = require('node:child_process');

const STATUSLINE = path.resolve(__dirname, '..', 'bin', 'statusline.js');

function runStatusline(stdin, env, cwd) {
  const result = spawnSync(process.execPath, [STATUSLINE], {
    input: stdin,
    env: Object.assign({}, process.env, env || {}),
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
  });
  return result;
}

function makeTempProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-statusline-active-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  return tmp;
}

function writeCache(cwd, cache) {
  const p = path.join(cwd, '.orchestray', 'state', 'context-telemetry.json');
  const fullCache = Object.assign({ schema_version: 1, updated_at: new Date().toISOString() }, cache);
  fs.writeFileSync(p, JSON.stringify(fullCache), 'utf8');
}

test('active block contains [ctx ...] and one subagent block', () => {
  const cwd = makeTempProject();
  writeCache(cwd, {
    session_id: 's-A',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 50000 } },
    active_subagents: [{
      agent_type: 'developer',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      tokens: { total_prompt: 12000 },
      context_window: 200000,
    }],
  });
  const stdin = JSON.stringify({
    session_id: 's-A',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  // Parent block: [ctx PCT FILL/TOTAL MODEL]
  assert.match(out.stdout, /\[ctx \d+% [\d.]+K\/200K [a-z0-9-]+\]/, 'parent ctx block intact');
  // Subagent block: [dev PCT FILL/TOTAL MODEL EFFORT]
  assert.match(out.stdout, /\[dev \d+% [\d.]+K\/200K [a-z0-9-]+ md\]/, 'developer block intact');
});

test('active block: pressure markers fire at thresholds', () => {
  const cwd = makeTempProject();
  // 180K / 200K = 90% — at the critical default threshold.
  writeCache(cwd, {
    session_id: 's-B',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 180000 } },
    active_subagents: [],
  });
  const stdin = JSON.stringify({
    session_id: 's-B',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  // !! marker present at >= 90%.
  assert.match(out.stdout, /\[ctx \d+%!! /, 'critical pressure marker !! at 90%+');
});

test('multi-subagent block: all rendered up to width cap', () => {
  const cwd = makeTempProject();
  writeCache(cwd, {
    session_id: 's-C',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 50000 } },
    active_subagents: [
      { agent_type: 'developer', model: 'claude-sonnet-4-6', effort: 'medium', tokens: { total_prompt: 5000 }, context_window: 200000 },
      { agent_type: 'reviewer',  model: 'claude-sonnet-4-6', effort: 'low',    tokens: { total_prompt: 3000 }, context_window: 200000 },
    ],
  });
  const stdin = JSON.stringify({
    session_id: 's-C',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /\[dev /, 'developer block rendered');
  assert.match(out.stdout, /\[rev /, 'reviewer block rendered');
  // Separator " > " between parent and subagents.
  assert.match(out.stdout, / > /);
});
