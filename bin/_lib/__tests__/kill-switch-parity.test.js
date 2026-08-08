#!/usr/bin/env node
'use strict';

/**
 * kill-switch-parity.test.js — v2.3.21.
 *
 * Orchestray documents ~117 `ORCHESTRAY_*` kill switches in agent-facing prose.
 * A dozen of them were documented but read by no code at all, including the
 * escape hatch for a hard-blocking gate (`ORCHESTRAY_NON_PM_AGENT_BLOCK_DISABLED`).
 * An operator who set it saw the block fire anyway and concluded the gate was
 * broken; nothing in the suite noticed, because nothing was checking.
 *
 * This is the fence: a switch documented in `agents/**` must have a read in code.
 * The checker resolves injected-env, constructed-name and constant-indirection
 * reads, and is pinned against three known-good controls so it cannot pass by
 * being blind.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/_lib/__tests__/kill-switch-parity.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  EXEMPT,
  checkParity,
  extractDocumentedSwitches,
  extractCodeReads,
  resolveSwitch,
  splitFamily,
} = require('../kill-switch-parity.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('kill-switch parity: read-form resolution', () => {
  const reads = extractCodeReads(ROOT, ['bin']);

  // Control 1: injected env parameter — `env.ORCHESTRAY_HAIKU_ROUTING_DISABLED`
  // in bin/_lib/_haiku-routing-rule.js. A `process.env.X` grep misses this.
  test('resolves an injected-env read', () => {
    const r = resolveSwitch('ORCHESTRAY_HAIKU_ROUTING_DISABLED', reads);
    assert.equal(r.implemented, true, 'injected env read not resolved');
  });

  // Control 2: constructed name — the T15 family is documented with a
  // `<ROLE>` placeholder and built by string concatenation in role-schemas.js.
  test('resolves a constructed-name family', () => {
    const r = resolveSwitch('ORCHESTRAY_T15_<ROLE>_HARD_DISABLED', reads);
    assert.equal(r.implemented, true, 'T15 family not resolved');
    assert.equal(r.via, 'constructed');
  });

  test('resolves a concrete member of a constructed family', () => {
    const r = resolveSwitch('ORCHESTRAY_T15_DEVELOPER_HARD_DISABLED', reads);
    assert.equal(r.implemented, true, 'concrete T15 member not resolved');
  });

  // Control 3: constant indirection — `const ENV_TEAM_GATE_DISABLED = '...'`
  // then `process.env[ENV_TEAM_GATE_DISABLED]` in validate-task-completion.js.
  test('resolves a constant-indirection read', () => {
    const r = resolveSwitch('ORCHESTRAY_TEAM_EVENT_GATE_DISABLED', reads);
    assert.equal(r.implemented, true, 'constant-indirection read not resolved');
  });

  test('does not invent a read for a switch no code mentions', () => {
    const r = resolveSwitch('ORCHESTRAY_DEFINITELY_NOT_A_REAL_SWITCH', reads);
    assert.equal(r.implemented, false);
  });

  test('splitFamily separates prefix and suffix', () => {
    assert.deepEqual(splitFamily('ORCHESTRAY_T15_<ROLE>_HARD_DISABLED'),
      { prefix: 'ORCHESTRAY_T15_', suffix: '_HARD_DISABLED' });
    assert.deepEqual(splitFamily('ORCHESTRAY_A_${x}_B'),
      { prefix: 'ORCHESTRAY_A_', suffix: '_B' });
  });

  // A prose mention in a JSDoc block is not an implementation. bin/_lib/
  // migration-banner-ledger.js names several switches in banner copy only.
  test('a comment-only mention is not counted as a read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-parity-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'x.js'),
      '// Kill switch: ORCHESTRAY_COMMENT_ONLY_SWITCH=1\n* env.ORCHESTRAY_COMMENT_ONLY_SWITCH\n');
    const r = resolveSwitch('ORCHESTRAY_COMMENT_ONLY_SWITCH', extractCodeReads(dir, ['bin']));
    assert.equal(r.implemented, false, 'comment mention wrongly counted as a read');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('kill-switch parity: documentation extraction', () => {
  const documented = extractDocumentedSwitches(ROOT);

  test('extracts switches from kill-switch prose', () => {
    assert.ok(documented.has('ORCHESTRAY_NON_PM_AGENT_GATE_DISABLED'),
      'the non-PM block switch should be extracted from event-schemas.md');
  });

  test('extracts placeholder families without truncating them', () => {
    assert.ok(documented.has('ORCHESTRAY_T15_<ROLE>_HARD_DISABLED'),
      'family name truncated at the placeholder');
    assert.ok(!documented.has('ORCHESTRAY_T15_'), 'truncated family leaked into results');
  });

  test('does not treat a bare prose mention as a documented switch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-parity-doc-'));
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(path.join(dir, 'agents', 'a.md'),
      'The ORCHESTRAY_JUST_MENTIONED knob is discussed here in passing.\n');
    assert.equal(extractDocumentedSwitches(dir).has('ORCHESTRAY_JUST_MENTIONED'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('kill-switch parity: the fence', () => {
  const result = checkParity(ROOT);

  test('every documented switch has a code read', () => {
    const names = result.unimplemented.map(
      (r) => `${r.name} (documented at ${r.documented_at.map((s) => `${s.file}:${s.line}`).join(', ')})`
    );
    assert.deepEqual(names, [],
      'These switches are documented but no code reads them, so setting them does ' +
      'nothing. Either implement the read or remove the documentation:\n  ' +
      names.join('\n  '));
  });

  test('the check actually inspects a meaningful corpus', () => {
    assert.ok(result.documented.length >= 80,
      `only ${result.documented.length} switches extracted — extraction regressed`);
  });

  // Operability: a newly-documented switch with no implementation must fail
  // immediately, not on the next audit.
  test('a newly-documented switch with no implementation fails the check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-parity-new-'));
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'agents', 'gate.md'),
      'Hard-block: exit 2.\nKill switch: `ORCHESTRAY_BRAND_NEW_GATE_DISABLED=1`.\n');
    fs.writeFileSync(path.join(dir, 'bin', 'gate.js'), 'process.exit(2);\n');

    const r = checkParity(dir);
    assert.deepEqual(r.unimplemented.map((x) => x.name), ['ORCHESTRAY_BRAND_NEW_GATE_DISABLED']);

    // ...and passes once the read lands.
    fs.writeFileSync(path.join(dir, 'bin', 'gate.js'),
      "if (process.env.ORCHESTRAY_BRAND_NEW_GATE_DISABLED === '1') process.exit(0);\n");
    assert.deepEqual(checkParity(dir).unimplemented, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('every exemption carries a reason and is still documented', () => {
    const documented = extractDocumentedSwitches(ROOT);
    for (const [name, entry] of Object.entries(EXEMPT)) {
      assert.ok(entry.reason && entry.reason.length > 20, `${name}: exemption needs a reason`);
      assert.ok(documented.has(name),
        `${name}: exempted but no longer documented — delete the stale exemption`);
    }
  });
});
