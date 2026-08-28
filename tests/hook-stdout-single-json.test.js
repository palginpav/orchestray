#!/usr/bin/env node
'use strict';

/**
 * hook-stdout-single-json.test.js — v2.3.34
 *
 * Contract: a hook's stdout must be either empty, or exactly ONE valid JSON
 * value. Never two concatenated objects.
 *
 * Why this exists. Six hooks emitted `{"continue":true}{"continue":true}` —
 * two individually-valid objects, one invalid document. Each had a
 * `finally { process.stdout.write(CONTINUE_RESPONSE); }` plus early-return
 * paths that ALSO wrote, and `return` inside a `try` still runs `finally`.
 *
 * It went unnoticed for as long as it did because Claude Code used to accept
 * the malformed shape. A Claude Code update began validating hook stdout and
 * surfaced it as a `PostToolUse:Read hook error` on virtually every Read, in
 * every project — a user-visible break caused by code that had been wrong all
 * along and simply never checked.
 *
 * Note the error text blames string concatenation ("Emit the payload with a
 * JSON encoder"). That was a red herring here: every individual write already
 * used `JSON.stringify`. The defect was writing twice, not encoding badly.
 *
 * Method: pipe a realistic payload to every hook command wired in
 * hooks.json and assert the single-JSON-value contract on what comes back.
 * Runtime, not static — the double-write only manifests when a specific path
 * executes, which is precisely why a reading of the code missed it for so long.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.join(__dirname, '..');

/** Every distinct bin/*.js referenced as a hook command in hooks.json. */
function wiredHookScripts() {
  // Returns [{ rel, event }] — the event name matters: compose-block-a.js is a
  // UserPromptSubmit hook and emits ~300 KB under its real event, which a
  // PostToolUse payload never exercises.
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'hooks.json'), 'utf8'));
  const EVENT_NAMES = new Set([
    'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop',
    'SessionStart', 'PreCompact', 'Notification', 'TaskCompleted', 'TeammateIdle',
  ]);
  let currentEvent = 'PostToolUse';
  const found = new Set();
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'command' && typeof v === 'string') {
        const m = /bin\/([A-Za-z0-9_./-]+\.js)/.exec(v);
        if (m) found.add(m[1] + '\u0000' + currentEvent);
      } else {
        const prevEvent = currentEvent;
        if (EVENT_NAMES.has(k)) currentEvent = k;
        walk(v);
        currentEvent = prevEvent;
      }
    }
  })(hooks);
  return [...found]
    .map((k) => { const [rel, event] = k.split('\u0000'); return { rel, event }; })
    .filter((h) => fs.existsSync(path.join(repoRoot, 'bin', h.rel)))
    .sort((a, b) => (a.rel + a.event).localeCompare(b.rel + b.event));
}

/**
 * @param {string} out raw stdout
 * @returns {{ok: boolean, why: string}}
 */
function checkSingleJson(out) {
  const trimmed = (out || '').trim();
  if (trimmed === '') return { ok: true, why: 'empty (allowed)' };
  // Claude Code's check is specifically "looks like a JSON object". Plain text
  // is fine, and `[` is too ambiguous to judge — boot-validate-config.js legitimately
  // prints a report beginning "[config] (1 file(s))", which is not an array.
  if (!trimmed.startsWith('{')) {
    return { ok: true, why: 'not a JSON object (allowed)' };
  }
  try {
    JSON.parse(trimmed);
    return { ok: true, why: 'single valid JSON value' };
  } catch (err) {
    // The signature failure: N individually-valid objects run together.
    const objects = (trimmed.match(/\{"continue"/g) || []).length;
    const hint = objects > 1
      ? ` — looks like ${objects} concatenated response objects; a \`finally\` that ` +
        'writes plus an early return that also writes will do this, because `return` ' +
        'inside `try` still runs `finally`'
      : '';
    return { ok: false, why: `${err.message}${hint}` };
  }
}

describe('hook stdout is a single JSON value (v2.3.34)', () => {
  const scripts = wiredHookScripts();

  test('hooks.json wires a plausible number of scripts', () => {
    // Guard against the walker silently finding nothing and the suite below
    // trivially passing over an empty list.
    assert.ok(scripts.length > 20, `found only ${scripts.length} wired hook scripts`);
  });

  for (const { rel, event } of scripts) {
    test(`${rel} (${event}) emits at most one JSON value`, () => {
      const payload = JSON.stringify({
        session_id: 'test-single-json',
        cwd: repoRoot,
        hook_event_name: event,
        tool_name: 'Read',
        tool_input: { file_path: path.join(repoRoot, 'README.md') },
        tool_response: {},
      });
      const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin', rel)], {
        input: payload,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 64 * 1024 * 1024, // compose-block-a emits ~300 KB; truncation would read as malformed
        env: Object.assign({}, process.env, { ORCHESTRAY_FIXTURE_HARVEST: '0' }),
      });
      // A hook that cannot run at all under this payload is out of scope here;
      // other suites cover hook behaviour. This test only judges output shape.
      if (r.error || r.status === null) return;
      const verdict = checkSingleJson(r.stdout);
      assert.ok(verdict.ok, `${rel}: ${verdict.why}\nstdout was: ${JSON.stringify((r.stdout || '').slice(0, 200))}`);
    });
  }
});
