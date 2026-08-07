'use strict';

/**
 * compose-block-a.js — per-turn dedup key fix (v2.3.19 W4).
 *
 * v2319-guard-window-analysis.md §3 found the post-fire guard's dedup_key
 * built from `event.session_id`, which is stable for the WHOLE Claude Code
 * session (confirmed: the same dedup_key recurred across a 47-minute span
 * in production). Any install-pair claim from an earlier turn is therefore
 * still "active" when a later, genuinely distinct turn arrives on the
 * sibling install within the TTL window, wrongly suppressing that turn's
 * additionalContext with no error surfaced. Fixed by hashing the actual
 * prompt text (a genuine per-turn value) instead of session_id, plus
 * narrowing ttlMs 60000 -> 2000 as defense-in-depth.
 *
 * Both tests below spawn two REAL, independently materialized copies of the
 * hook (distinct __filename per copy — required, since the guard only ever
 * flags a collision when caller_path differs) to reproduce actual
 * dual-install racing. The entry-level stdin-claim dedup layer
 * (bin/_lib/hook-stdin.js) is disabled so only the post-fire guard under
 * test decides the outcome.
 *
 * Tests:
 *   1. Two distinct turns (different prompts, same session) racing across
 *      installs must BOTH emit additionalContext — was: the second was
 *      silently suppressed by the first turn's stale claim.
 *   2. A genuine same-turn race (identical prompt, same session, two
 *      installs) must still be caught — regression guard so the fix does
 *      not also disable real dual-install dedup.
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT    = path.resolve(__dirname, '../../..');
const SCRIPT_NAME  = 'compose-block-a.js';
const SCRIPT_PATH  = path.join(REPO_ROOT, 'bin', SCRIPT_NAME);

// ---------------------------------------------------------------------------
// Dual-install materialization (mirrors tests/dual-install-double-fire.test.js)
// ---------------------------------------------------------------------------

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
  // _lib/config-schema.js requires 'zod'. Node resolves bare specifiers by
  // walking up from the requiring file looking for node_modules — symlink
  // the real one in so the materialized copy resolves it without vendoring.
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(installRoot, 'node_modules'), 'dir');
  return path.join(dstBin, SCRIPT_NAME);
}

function makeProject(t, orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-turn-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Test project\n\nCLAUDE.md content.\n', 'utf8');
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.writeFileSync(path.join(pmRefDir, 'handoff-contract.md'), '# Handoff Contract\n', 'utf8');
  fs.writeFileSync(path.join(pmRefDir, 'phase-contract.md'), '# Phase Contract\n', 'utf8');

  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId, goal: 'test goal', constraints: [] }),
    'utf8'
  );

  return dir;
}

function runCompose(scriptPath, dir, event) {
  return spawnSync(process.execPath, [scriptPath], {
    input:    JSON.stringify(Object.assign({ cwd: dir }, event)),
    encoding: 'utf8',
    timeout:  10000,
    cwd:      dir,
    env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP: '1' }),
  });
}

function hasAdditionalContext(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch (_e) { /* not JSON */ }
  return !!(parsed && parsed.hookSpecificOutput &&
    typeof parsed.hookSpecificOutput.additionalContext === 'string' &&
    parsed.hookSpecificOutput.additionalContext.length > 0);
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------

test('compose-block-a: a legitimate second turn (different prompt, same session) is not cross-suppressed by an earlier turn\'s stale claim', (t) => {
  const orchId = 'orch-cba-turn-fix-' + Date.now();
  const dir  = makeProject(t, orchId);
  const instA = materializeInstall(path.join(dir, '.install-a'));
  const instB = materializeInstall(path.join(dir, '.install-b'));

  const sessionId = 'sess-shared-across-turns';

  const r1 = runCompose(instA, dir, { session_id: sessionId, prompt: 'Turn 1: implement feature X' });
  assert.equal(r1.status, 0, 'turn 1 (install A) must exit 0; stderr=' + r1.stderr);
  assert.ok(hasAdditionalContext(r1), 'turn 1 (first fire, uncontested) must emit additionalContext');

  const r2 = runCompose(instB, dir, { session_id: sessionId, prompt: 'Turn 2: a completely different follow-up request' });
  assert.equal(r2.status, 0, 'turn 2 (install B) must exit 0; stderr=' + r2.stderr);
  assert.ok(
    hasAdditionalContext(r2),
    'turn 2 is a distinct legitimate turn on the sibling install and must NOT be suppressed ' +
    'by turn 1\'s still-active claim'
  );
});

test('compose-block-a: a genuine same-turn dual-install race is still caught (regression guard)', (t) => {
  const orchId = 'orch-cba-turn-race-' + Date.now();
  const dir  = makeProject(t, orchId);
  const instA = materializeInstall(path.join(dir, '.install-a'));
  const instB = materializeInstall(path.join(dir, '.install-b'));

  const sessionId  = 'sess-race';
  const samePrompt = 'Race turn: identical prompt text delivered to both installs for the same event';

  const r1 = runCompose(instA, dir, { session_id: sessionId, prompt: samePrompt });
  const r2 = runCompose(instB, dir, { session_id: sessionId, prompt: samePrompt });
  assert.equal(r1.status, 0, 'install A must exit 0; stderr=' + r1.stderr);
  assert.equal(r2.status, 0, 'install B must exit 0; stderr=' + r2.stderr);

  assert.ok(hasAdditionalContext(r1), 'the first install to fire on the race must emit additionalContext');
  assert.ok(!hasAdditionalContext(r2), 'the second install racing the SAME turn must still be suppressed');

  const events = readEvents(dir);
  const dfe = events.find(e => e.type === 'hook_double_fire_detected' && e.guard_name === 'compose-block-a');
  assert.ok(dfe, 'hook_double_fire_detected must be emitted for the genuine race');
});

// ---------------------------------------------------------------------------
// E7 (reviewer finding): promptText fell back to a constant '' when
// event.prompt was absent, so every prompt-less turn hashed to the SAME
// turnDiscriminator and collided inside the 2s TTL window — the guard
// failing toward suppression instead of toward firing. Fixed by falling
// back to crypto.randomUUID() per turn instead.
// ---------------------------------------------------------------------------

test('compose-block-a: two distinct prompt-less turns (event.prompt absent) do not collide on a constant discriminator', (t) => {
  const orchId = 'orch-cba-turn-noprompt-' + Date.now();
  const dir  = makeProject(t, orchId);
  const instA = materializeInstall(path.join(dir, '.install-a'));
  const instB = materializeInstall(path.join(dir, '.install-b'));

  const sessionId = 'sess-no-prompt';

  // No `prompt` field at all — event.prompt is undefined, exercising the
  // fallback branch.
  const r1 = runCompose(instA, dir, { session_id: sessionId });
  assert.equal(r1.status, 0, 'turn 1 (install A) must exit 0; stderr=' + r1.stderr);
  assert.ok(hasAdditionalContext(r1), 'turn 1 (first fire, uncontested) must emit additionalContext');

  const r2 = runCompose(instB, dir, { session_id: sessionId });
  assert.equal(r2.status, 0, 'turn 2 (install B) must exit 0; stderr=' + r2.stderr);
  assert.ok(
    hasAdditionalContext(r2),
    'a second, genuinely distinct prompt-less turn must NOT collide with the first on a ' +
    'constant \'\' discriminator — each missing-prompt turn must get a unique fallback'
  );
});
