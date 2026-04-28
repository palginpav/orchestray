'use strict';

/**
 * v2.2.9 B-7.5 — Cite-label scanner (warn-tier).
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'scan-cite-labels.js');
const { scan } = require('../_lib/cite-label-scanner');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b75-'));
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

test('B-7.5: scan returns empty for text with no pattern URLs', () => {
  assert.deepEqual(scan('hello world'), []);
});

test('B-7.5: scan flags an unlabelled pattern URL', () => {
  const matches = scan('we apply @orchestray:pattern://retry-on-flake here.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].pattern_url, '@orchestray:pattern://retry-on-flake');
  assert.match(matches[0].surrounding_text, /retry-on-flake/);
});

test('B-7.5: scan accepts label after the URL', () => {
  const labelled = '@orchestray:pattern://retry-on-flake [local] conf 0.9';
  const labelledNoSpace = '@orchestray:pattern://retry-on-flake[local]';
  assert.deepEqual(scan(labelled), []);
  assert.deepEqual(scan(labelledNoSpace), []);
});

test('B-7.5: scan flags multiple URLs independently', () => {
  const text =
    'See @orchestray:pattern://a [local] and @orchestray:pattern://b. Also @orchestray:pattern://c.';
  const matches = scan(text);
  // 'a' is labelled; 'b' and 'c' are not.
  assert.equal(matches.length, 2);
  assert.equal(matches[0].pattern_url, '@orchestray:pattern://b');
  assert.equal(matches[1].pattern_url, '@orchestray:pattern://c');
});

test('B-7.5: hook never blocks (always exit 0)', () => {
  const root = makeSandbox();
  const result = runHook(root, {
    cwd: root,
    message_text: 'unlabelled @orchestray:pattern://x here',
  });
  assert.notEqual(result && result.status, 2, 'cite scanner must never block');
});

test('B-7.5: hook emits cite_unlabelled_detected for unlabelled URL', () => {
  const root = makeSandbox();
  runHook(root, {
    cwd: root,
    message_text: 'we cite @orchestray:pattern://my-pattern here without label',
  });
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    assert.fail('events.jsonl missing — hook did not emit');
  }
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const emit = lines.map(l => JSON.parse(l)).find(e => e.type === 'cite_unlabelled_detected');
  assert.ok(emit, 'cite_unlabelled_detected must be emitted');
  assert.equal(emit.pattern_url, '@orchestray:pattern://my-pattern');
});

test('B-7.5: hook does not emit when all URLs are labelled', () => {
  const root = makeSandbox();
  runHook(root, {
    cwd: root,
    message_text: 'cite @orchestray:pattern://x [local] conf 0.8 cleanly.',
  });
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    const emits = lines.map(l => JSON.parse(l)).filter(e => e.type === 'cite_unlabelled_detected');
    assert.equal(emits.length, 0, 'no unlabelled cites → no emits');
  }
});
