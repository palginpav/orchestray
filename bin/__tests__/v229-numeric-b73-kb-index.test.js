'use strict';

/**
 * v2.2.9 B-7.3 — KB index validator.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'validate-kb-index.js');
const { validate } = require('../_lib/kb-index-validator');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b73-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'kb'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  return root;
}

function runHook(cwd, payload) {
  try {
    return execFileSync('node', [HOOK], {
      cwd,
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
  } catch (err) {
    return err;
  }
}

test('B-7.3: validate returns valid when index.json is missing', () => {
  const root = makeSandbox();
  const r = validate(root);
  assert.equal(r.valid, true);
});

test('B-7.3: validate accepts a well-formed index', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'index.json'),
    JSON.stringify({
      version: '1.0',
      entries: [{ id: 'good-id', path: 'artifacts/foo.md' }],
    })
  );
  const r = validate(root);
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('B-7.3: validate rejects parse error', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'index.json'),
    'not json{{'
  );
  const r = validate(root);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'parse_error');
});

test('B-7.3: validate rejects path traversal', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'index.json'),
    JSON.stringify({ entries: [{ id: 'x', path: '../etc/passwd' }] })
  );
  const r = validate(root);
  assert.equal(r.valid, false);
  assert.match(r.reason, /path_unsafe/);
});

test('B-7.3: validate rejects duplicate ids in same bucket', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'index.json'),
    JSON.stringify({
      artifacts: [
        { id: 'dup', path: 'artifacts/a.md' },
        { id: 'dup', path: 'artifacts/b.md' },
      ],
    })
  );
  const r = validate(root);
  assert.equal(r.valid, false);
  assert.match(r.reason, /duplicate_id_dup/);
});

test('B-7.3: hook blocks Edit on a corrupt index and emits kb_index_invalid', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'index.json'),
    'not-json'
  );
  const result = runHook(root, {
    cwd: root,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(root, '.orchestray', 'kb', 'index.json') },
  });
  assert.equal(result && result.status, 2);
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const emit = lines.map(l => JSON.parse(l)).find(e => e.type === 'kb_index_invalid');
  assert.ok(emit, 'kb_index_invalid event must be present');
  assert.equal(emit.reason, 'parse_error');
});

test('B-7.3: hook ignores writes to unrelated files', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'kb', 'index.json'),
    'not-json'
  );
  const result = runHook(root, {
    cwd: root,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(root, 'agents', 'pm.md') },
  });
  // Even with a corrupt index, an Edit on pm.md is out of scope → exit 0.
  assert.notEqual(result && result.status, 2);
});
