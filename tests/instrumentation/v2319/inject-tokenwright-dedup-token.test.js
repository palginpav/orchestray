'use strict';

/**
 * inject-tokenwright.js — dedupToken composition fix (v2.3.19 W4).
 *
 * v2319-guard-window-analysis.md §4 found `dedupToken` embedded a
 * locally-computed `Date.now()`, stamped independently inside each racing
 * process. Two dual-install processes handling the identical Agent-spawn
 * event each stamp their own millisecond value into the hash, so the tokens
 * essentially never collide — 0 detections across the entire production log
 * despite the hook firing on every spawn. No value of ttlMs can fix this;
 * the token composition itself is the defect.
 *
 * Fixed by keying on `event.tool_use_id` (identifies the underlying tool
 * call and is delivered identically to both racing installs) instead of a
 * per-process timestamp, falling back to the prompt text when tool_use_id is
 * absent.
 *
 * Spawns two REAL, independently materialized copies of the hook (distinct
 * __filename per copy, required for the guard's caller_path comparison) fed
 * the IDENTICAL payload, reproducing actual dual-install racing on one
 * logical spawn. The entry-level stdin-claim dedup layer
 * (bin/_lib/hook-stdin.js) is disabled so only the guard under test decides
 * the outcome.
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '../../..');
const SCRIPT_NAME = 'inject-tokenwright.js';
const SCRIPT_PATH = path.join(REPO_ROOT, 'bin', SCRIPT_NAME);

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

function materializeInstall(installRoot) {
  const dstBin = path.join(installRoot, 'bin');
  fs.mkdirSync(dstBin, { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, path.join(dstBin, SCRIPT_NAME));
  copyDirRecursive(path.join(REPO_ROOT, 'bin', '_lib'), path.join(dstBin, '_lib'));
  return path.join(dstBin, SCRIPT_NAME);
}

function makeProject(t, orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itw-token-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  return dir;
}

function runHook(scriptPath, dir, payload) {
  return spawnSync(process.execPath, [scriptPath], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  10000,
    cwd:      dir,
    env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP: '1' }),
  });
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

test('inject-tokenwright: two racing installs for the SAME spawn now produce matching dedup tokens (double-fire caught)', (t) => {
  const orchId = 'orch-itw-token-' + Date.now();
  const dir   = makeProject(t, orchId);
  const instA = materializeInstall(path.join(dir, '.install-a'));
  const instB = materializeInstall(path.join(dir, '.install-b'));

  const payload = {
    tool_name:   'Agent',
    tool_use_id: 'toolu_shared_spawn_001',
    cwd:         dir,
    tool_input: {
      subagent_type: 'developer',
      prompt: 'Implement feature Y with tests, following existing conventions.',
    },
  };

  const r1 = runHook(instA, dir, payload);
  const r2 = runHook(instB, dir, payload);
  assert.equal(r1.status, 0, 'install A must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'install B must exit 0; stderr=' + r2.stderr);

  const events = readEvents(dir);
  const doubleFire = events.filter(e => e.type === 'compression_double_fire_detected');
  assert.equal(
    doubleFire.length, 1,
    'the second racing install must be recognised as a duplicate of the first for the same tool_use_id'
  );
});

test('inject-tokenwright: two genuinely distinct spawns (different tool_use_id) are NOT falsely merged', (t) => {
  const orchId = 'orch-itw-token-distinct-' + Date.now();
  const dir   = makeProject(t, orchId);
  const instA = materializeInstall(path.join(dir, '.install-a'));
  const instB = materializeInstall(path.join(dir, '.install-b'));

  const base = {
    tool_name: 'Agent',
    cwd:       dir,
    tool_input: {
      subagent_type: 'developer',
      prompt: 'Implement feature Y with tests, following existing conventions.',
    },
  };

  const r1 = runHook(instA, dir, Object.assign({ tool_use_id: 'toolu_first_spawn' }, base));
  const r2 = runHook(instB, dir, Object.assign({ tool_use_id: 'toolu_second_spawn' }, base));
  assert.equal(r1.status, 0, 'first spawn must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'second spawn must exit 0; stderr=' + r2.stderr);

  const events = readEvents(dir);
  const doubleFire = events.filter(e => e.type === 'compression_double_fire_detected');
  assert.equal(
    doubleFire.length, 0,
    'two distinct spawns sharing identical prompt+agentType but different tool_use_id must not collide'
  );
});
