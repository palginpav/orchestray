'use strict';

/**
 * statusline-idle-suppress.test.js — F-19 (v2.2.21)
 *
 * The statusline emits '' (empty line) when:
 *   - zero subagents are active, AND
 *   - parent prompt fill is below the warn threshold (default 75%), AND
 *   - the cache is not stale (different session_id).
 *
 * This is the "idle" path — the line carries no actionable signal, so it is
 * suppressed to reduce visual noise.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-statusline-idle-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  return tmp;
}

function writeCache(cwd, cache) {
  const p = path.join(cwd, '.orchestray', 'state', 'context-telemetry.json');
  // Cache file must carry schema_version: 1 to be honoured by readCache().
  const fullCache = Object.assign({ schema_version: 1, updated_at: new Date().toISOString() }, cache);
  fs.writeFileSync(p, JSON.stringify(fullCache), 'utf8');
}

test('idle path: zero subagents + low fill → empty line', () => {
  const cwd = makeTempProject();
  writeCache(cwd, {
    session_id: 's-1',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 10000 } },
    active_subagents: [],
  });
  const stdin = JSON.stringify({
    session_id: 's-1',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0, 'exit 0');
  // 10K / 200K = 5%, below default warn 75%, no subagents → suppressed.
  assert.equal(out.stdout.trim(), '', 'idle path emits empty line');
});

test('active path: subagent present → full block', () => {
  const cwd = makeTempProject();
  writeCache(cwd, {
    session_id: 's-2',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 10000 } },
    active_subagents: [{
      agent_type: 'developer',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      tokens: { total_prompt: 5000 },
      context_window: 200000,
    }],
  });
  const stdin = JSON.stringify({
    session_id: 's-2',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /\[ctx /, 'parent block present');
  assert.match(out.stdout, /\[dev /, 'subagent block present');
});

test('high fill path: zero subagents but ≥ warn → full block', () => {
  const cwd = makeTempProject();
  // 160K / 200K = 80% — above default warn 75% threshold.
  writeCache(cwd, {
    session_id: 's-3',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 160000 } },
    active_subagents: [],
  });
  const stdin = JSON.stringify({
    session_id: 's-3',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /\[ctx \d+%/, 'parent block rendered when fill ≥ warn');
});

test('kill switch: idle_suppression=false restores always-render', () => {
  const cwd = makeTempProject();
  // Write config disabling idle suppression.
  fs.mkdirSync(path.join(cwd, '.orchestray'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.orchestray', 'config.json'),
    JSON.stringify({ context_statusbar: { idle_suppression: false } }),
    'utf8'
  );
  writeCache(cwd, {
    session_id: 's-4',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 10000 } },
    active_subagents: [],
  });
  const stdin = JSON.stringify({
    session_id: 's-4',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /\[ctx /, 'kill switch off → block renders even on idle');
});

test('stale cache (different session_id) → does NOT idle-suppress', () => {
  const cwd = makeTempProject();
  writeCache(cwd, {
    session_id: 's-X',
    session: { model: 'claude-opus-4-7', tokens: { total_prompt: 10000 } },
    active_subagents: [],
  });
  const stdin = JSON.stringify({
    session_id: 's-Y',
    cwd,
    model: { id: 'claude-opus-4-7' },
  });
  const out = runStatusline(stdin, { CLAUDE_PROJECT_DIR: cwd }, cwd);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /other-session/, 'stale-cache marker, not empty');
});
