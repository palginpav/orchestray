#!/usr/bin/env node
'use strict';

/**
 * P3.2 first-spawn behaviour (v2.2.0).
 *
 * Asserts that the first computeDelta() call for a (orch, agent_type) pair
 * returns type='full' with reason='first_spawn', writes the prefix to disk,
 * and records a stable hash.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const pathMod = require('node:path');

const REPO_ROOT = pathMod.resolve(__dirname, '..', '..');
const { computeDelta, __resetCache } = require(pathMod.join(REPO_ROOT, 'bin', '_lib', 'spawn-context-delta.js'));

function makeTmpRoot() {
  return fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p32-first-spawn-'));
}

const STATIC_BODY = '## Handoff Contract\nfollow contract.md\n\n## Pre-Flight\n- read repo map\n- list files\n';
const PER_SPAWN_BODY = '## Task\nimplement feature X\n\ncontext_size_hint: { system: 1000 }\n';

function buildPrompt(staticBody, perSpawnBody) {
  return (
    '<!-- delta:static-begin -->\n' +
    staticBody +
    '\n<!-- delta:static-end -->\n' +
    '<!-- delta:per-spawn-begin -->\n' +
    perSpawnBody +
    '\n<!-- delta:per-spawn-end -->'
  );
}

describe('P3.2 first spawn returns type=full with reason=first_spawn', () => {
  test('first computeDelta call returns full with valid hash and writes prefix to disk', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const prompt = buildPrompt(STATIC_BODY, PER_SPAWN_BODY);
    const r = computeDelta(prompt, { orchestration_id: 'orch-A', agent_type: 'developer', cwd });

    assert.equal(r.type, 'full', 'first spawn must be type=full');
    assert.equal(r.text, prompt, 'full text must equal the input prompt verbatim');
    assert.equal(r.reason, 'first_spawn');
    assert.match(r.prefix_hash, /^[0-9a-f]{64}$/, 'prefix_hash must be 64-char hex');
    assert.equal(r.prefix_bytes, Buffer.byteLength('\n' + STATIC_BODY + '\n', 'utf8'),
      'prefix_bytes must be utf-8 byte length of the static portion');
    assert.equal(r.full_bytes_avoided, 0, 'full spawn avoids zero bytes');

    const cacheFile = pathMod.join(cwd, '.orchestray/state/spawn-prefix-cache/orch-A-developer.txt');
    assert.ok(fs.existsSync(cacheFile), 'prefix cache file must be written');
    const cacheBody = fs.readFileSync(cacheFile, 'utf8');
    assert.equal(cacheBody, '\n' + STATIC_BODY + '\n',
      'prefix cache file body must equal the static portion');
  });

  test('idempotent after __resetCache — second call after reset still returns full with same hash', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const prompt = buildPrompt(STATIC_BODY, PER_SPAWN_BODY);
    const r1 = computeDelta(prompt, { orchestration_id: 'orch-A', agent_type: 'developer', cwd });
    __resetCache();
    const cwd2 = makeTmpRoot();   // fresh disk too — would otherwise hit on-disk file
    const r2 = computeDelta(prompt, { orchestration_id: 'orch-A', agent_type: 'developer', cwd: cwd2 });
    assert.equal(r2.type, 'full');
    assert.equal(r2.prefix_hash, r1.prefix_hash, 'identical static portion → identical hash across resets');
  });

  test('empty prompt fails soft with reason=empty_prompt', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const r = computeDelta('', { orchestration_id: 'orch-A', agent_type: 'developer', cwd });
    assert.equal(r.type, 'full');
    assert.equal(r.reason, 'empty_prompt');
  });

  test('markers missing fails soft with reason=markers_missing', () => {
    __resetCache();
    const cwd = makeTmpRoot();
    const r = computeDelta('plain prompt without markers',
      { orchestration_id: 'orch-A', agent_type: 'developer', cwd });
    assert.equal(r.type, 'full');
    assert.equal(r.reason, 'markers_missing');
    assert.equal(r.text, 'plain prompt without markers', 'fail-soft preserves the input prompt verbatim');
  });
});
