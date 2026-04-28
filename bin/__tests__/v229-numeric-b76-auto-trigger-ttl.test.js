'use strict';

/**
 * v2.2.9 B-7.6 — auto-trigger.json TTL sweep.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'expire-auto-trigger.js');
const { runSweep } = require('../_lib/auto-trigger-ttl');
const { loadAutoTriggerTtlSeconds } = require('../_lib/numeric-thresholds');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b76-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  return root;
}

function writeMarker(root, ageSeconds) {
  const filePath = path.join(root, '.orchestray', 'auto-trigger.json');
  const ts = new Date(Date.now() - ageSeconds * 1000).toISOString();
  fs.writeFileSync(filePath, JSON.stringify({
    score: 8,
    threshold: 4,
    timestamp: ts,
    created_at: ts,
  }));
  return filePath;
}

test('B-7.6: loadAutoTriggerTtlSeconds default is 3600', () => {
  const root = makeSandbox();
  assert.equal(loadAutoTriggerTtlSeconds(root), 3600);
});

test('B-7.6: loadAutoTriggerTtlSeconds honours config override', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ auto_trigger_ttl_seconds: 60 })
  );
  assert.equal(loadAutoTriggerTtlSeconds(root), 60);
});

test('B-7.6: runSweep on missing marker returns no_marker', () => {
  const root = makeSandbox();
  const r = runSweep(root);
  assert.equal(r.action, 'no_marker');
});

test('B-7.6: runSweep keeps a fresh marker', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ auto_trigger_ttl_seconds: 3600 })
  );
  const filePath = writeMarker(root, 30); // 30s old, well under 3600
  const r = runSweep(root);
  assert.equal(r.action, 'kept');
  assert.ok(fs.existsSync(filePath), 'fresh marker must remain on disk');
});

test('B-7.6: runSweep deletes an expired marker and emits auto_trigger_expired', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ auto_trigger_ttl_seconds: 60 })
  );
  const filePath = writeMarker(root, 7200); // 2h old
  const r = runSweep(root);
  assert.equal(r.action, 'expired');
  assert.equal(fs.existsSync(filePath), false, 'expired marker must be unlinked');
  // Event check.
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const emit = lines.map(l => JSON.parse(l)).find(e => e.type === 'auto_trigger_expired');
  assert.ok(emit, 'auto_trigger_expired must fire');
  assert.ok(emit.age_seconds >= 7000);
});

test('B-7.6: hook runs as a UserPromptSubmit early-tail and exits 0', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ auto_trigger_ttl_seconds: 60 })
  );
  writeMarker(root, 9000);
  let res;
  try {
    res = execFileSync('node', [HOOK], {
      cwd: root,
      input: JSON.stringify({ cwd: root, prompt: 'hello' }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  } catch (err) {
    res = err;
  }
  // Hook must exit 0 (UserPromptSubmit hooks must not block).
  assert.notEqual(res && res.status, 2);
  assert.equal(fs.existsSync(path.join(root, '.orchestray', 'auto-trigger.json')), false);
});
