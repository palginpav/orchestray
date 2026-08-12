#!/usr/bin/env node
'use strict';

/**
 * verify-tools.test.js — fixture-backed regression tests for
 * bin/_tools/verify.js, one per catalogued read-form failure (v2.3.25).
 *
 * Each `describe` block below is anchored to a numbered failure from the
 * tool's own header comment. A naive pattern for the same question is
 * included alongside the correct helper call so the contrast is explicit.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const v = require('../../bin/_tools/verify');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tools-'));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Failure #1 + #3: envSwitchIsRead — alias indirection, digits in the name
// ---------------------------------------------------------------------------

describe('envSwitchIsRead', () => {
  test('failure #1: alias form (const env = process.env; env.NAME) is detected', () => {
    const root = tmpDir();
    write(root, 'a.js', "const env = process.env;\nif (env.ORCHESTRAY_DR_FOO_DISABLED === '1') return null;\n");
    // A naive grep for the literal substring would find nothing here.
    const naive = fs.readFileSync(path.join(root, 'a.js'), 'utf8').includes('process.env.ORCHESTRAY_DR_FOO_DISABLED');
    assert.equal(naive, false, 'sanity: the naive direct-substring grep really does miss this');

    const r = v.envSwitchIsRead('ORCHESTRAY_DR_FOO_DISABLED', { root });
    assert.equal(r.read, true);
    assert.equal(r.confident, true);
    assert.ok(r.evidence.some((e) => e.form === 'alias'));
  });

  test('failure #3: a name containing digits (T15) is matched, not dropped by a [A-Z_]+ scan', () => {
    const root = tmpDir();
    write(root, 'b.js', "if (process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED === '1') return true;\n");
    // The naive bug: a discovery regex built on [A-Z_]+ silently drops digit
    // runs like "15" and never even forms the right variable name to look for.
    const naiveDiscover = /ORCHESTRAY_[A-Z_]+/.exec(
      fs.readFileSync(path.join(root, 'b.js'), 'utf8')
    )[0];
    assert.notEqual(naiveDiscover, 'ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED',
      'sanity: the naive discovery regex really does truncate at the digit run');

    const r = v.envSwitchIsRead('ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED', { root });
    assert.equal(r.read, true);
    assert.ok(r.evidence.some((e) => e.form === 'direct-dot'));
  });

  test('constant indirection (const N = "NAME"; process.env[N]) is detected', () => {
    const root = tmpDir();
    write(root, 'c.js', "const KEY = 'ORCHESTRAY_FOO_BAR';\nconst v = process.env[KEY];\n");
    const r = v.envSwitchIsRead('ORCHESTRAY_FOO_BAR', { root });
    assert.equal(r.read, true);
    assert.ok(r.evidence.some((e) => e.form === 'indirection'));
  });

  test('docstring-only mention is excluded — not counted as a read', () => {
    const root = tmpDir();
    write(root, 'd.js', "/**\n * Honors process.env.ORCHESTRAY_GHOST_DISABLED if set.\n */\nfunction f() {}\n");
    const r = v.envSwitchIsRead('ORCHESTRAY_GHOST_DISABLED', { root });
    assert.equal(r.read, false);
    assert.deepEqual(r.evidence, []);
  });

  test('bracket form process.env["NAME"] is detected', () => {
    const root = tmpDir();
    write(root, 'e.js', 'const x = process.env["ORCHESTRAY_BRACKETED"];\n');
    const r = v.envSwitchIsRead('ORCHESTRAY_BRACKETED', { root });
    assert.equal(r.read, true);
    assert.ok(r.evidence.some((e) => e.form === 'direct-bracket'));
  });

  test('a switch that is genuinely never read returns read:false, confident:true', () => {
    const root = tmpDir();
    write(root, 'f.js', "const env = process.env;\nif (env.SOME_OTHER_VAR === '1') {}\n");
    const r = v.envSwitchIsRead('ORCHESTRAY_TRULY_DEAD', { root });
    assert.equal(r.read, false);
    assert.equal(r.confident, true);
  });

  // Observed defect (v2.3.26): `{cwd: <worktree>}` was silently dropped
  // because the function only read `opts.root`, so `root` fell through to
  // process.cwd() of the running process — a confident:true answer built
  // from scanning the wrong tree entirely. Fixture is the exact real file
  // this defect was measured against.
  test('opts.cwd is honored as an alias for opts.root (real fixture: register-agent-spawn.js)', () => {
    const root = tmpDir();
    write(root, 'bin/register-agent-spawn.js', [
      "function lifecycleDisabled(cwd) {",
      "  if (process.env.ORCHESTRAY_DISABLE_AGENT_LIFECYCLE === '1') return true;",
      "  if (process.env.ORCHESTRAY_AGENT_REGISTRY_DISABLED === '1') return true;",
      "  return false;",
      "}",
    ].join('\n'));

    const r = v.envSwitchIsRead('ORCHESTRAY_AGENT_REGISTRY_DISABLED', { cwd: root });
    assert.equal(r.read, true);
    assert.equal(r.confident, true);
    assert.ok(r.evidence.some((e) => e.form === 'direct-dot'));
  });

  // Observed defect (v2.3.26): the alias detector only matched a literal
  // `const env = process.env` RHS. The DI pattern `const env = input.env ||
  // {}` (env injected as a parameter for testability, e.g. shouldSpawnScout
  // in _haiku-routing-rule.js) was invisible to it — a confident false
  // negative on the exact class the header documents as a known trap.
  test('injected-env DI pattern (const env = input.env || {}; env.NAME) is detected (real fixture: _haiku-routing-rule.js)', () => {
    const root = tmpDir();
    write(root, 'bin/_lib/_haiku-routing-rule.js', [
      "function shouldSpawnScout(input) {",
      "  const args = input.args || {};",
      "  const env = input.env || {};",
      "  if (env.ORCHESTRAY_HAIKU_ROUTING_DISABLED === '1') return false;",
      "  return true;",
      "}",
    ].join('\n'));

    const r = v.envSwitchIsRead('ORCHESTRAY_HAIKU_ROUTING_DISABLED', { root });
    assert.equal(r.read, true);
    assert.equal(r.confident, true);
    assert.ok(r.evidence.some((e) => e.form === 'alias' && e.snippet.includes('input.env')));
  });

  test('a var named env assigned from an unrelated .envelope-like property does not false-positive', () => {
    const root = tmpDir();
    write(root, 'n.js', "const env = config.envelope || {};\nif (env.ORCHESTRAY_UNRELATED === '1') {}\n");
    const r = v.envSwitchIsRead('ORCHESTRAY_UNRELATED', { root });
    assert.equal(r.read, false);
    assert.equal(r.confident, true);
  });
});

// ---------------------------------------------------------------------------
// Failure #2: agentGrantsTool — YAML flow-sequence form
// ---------------------------------------------------------------------------

describe('agentGrantsTool', () => {
  test('failure #2: tools: [a, b] flow form — first/last entries are not bracket-mangled', () => {
    const root = tmpDir();
    const p = write(root, 'agents/scout.md', '---\nname: scout\ntools: [Read, Glob, Grep]\nmodel: haiku\n---\nbody\n');
    // Naive bug: splitting on comma without stripping brackets first yields
    // "[Read" and "Grep]" — neither equals "Read" or "Grep".
    const rawList = '[Read, Glob, Grep]'.split(',').map((s) => s.trim());
    assert.ok(!rawList.includes('Read'), 'sanity: the naive split really does mangle the first entry');
    assert.ok(!rawList.includes('Grep'), 'sanity: the naive split really does mangle the last entry');

    const r = v.agentGrantsTool(p, 'Read');
    assert.equal(r.granted, true);
    assert.equal(r.form, 'flow');
    assert.deepEqual(r.grantedList, ['Read', 'Glob', 'Grep']);
    assert.equal(v.agentGrantsTool(p, 'Grep').granted, true);
  });

  test('flat comma form still works', () => {
    const root = tmpDir();
    const p = write(root, 'agents/dev.md', '---\nname: dev\ntools: Read, Glob, Grep, Bash\n---\nbody\n');
    const r = v.agentGrantsTool(p, 'Bash');
    assert.equal(r.granted, true);
    assert.equal(r.form, 'flat');
  });

  test('empty flow form tools: [] legitimately grants nothing (distinct from "not found")', () => {
    const root = tmpDir();
    const p = write(root, 'agents/pe.md', '---\nname: pe\ntools: []\n---\nbody\n');
    const r = v.agentGrantsTool(p, 'Read');
    assert.equal(r.granted, false);
    assert.equal(r.confident, true);
    assert.deepEqual(r.grantedList, []);
  });

  test('no frontmatter at all is reported as low-confidence, not a silent false', () => {
    const root = tmpDir();
    const p = write(root, 'agents/broken.md', 'no frontmatter here\n');
    const r = v.agentGrantsTool(p, 'Read');
    assert.equal(r.confident, false);
    assert.equal(r.reason, 'no_frontmatter');
  });
});

// ---------------------------------------------------------------------------
// eventTypeIsDeclared — cross-checks md + both sidecars, reports disagreement
// ---------------------------------------------------------------------------

describe('eventTypeIsDeclared', () => {
  const MD_REL = path.join('agents', 'pm-reference', 'event-schemas.md');
  const SHADOW_REL = path.join('agents', 'pm-reference', 'event-schemas.shadow.json');
  const TIER2_REL = path.join('agents', 'pm-reference', 'event-schemas.tier2-index.json');

  function seedRoot() {
    const root = tmpDir();
    write(root, MD_REL, [
      '### `agent_start`',
      '',
      '```json',
      '{',
      '  "type": "agent_start",',
      '  "version": 1,',
      '  "orchestration_id": "..."',
      '}',
      '```',
      '',
    ].join('\n'));
    return root;
  }

  test('declared and agreeing across all three sources', () => {
    const root = seedRoot();
    write(root, SHADOW_REL, JSON.stringify({ _meta: {}, agent_start: { v: 1, r: 1, o: 0 } }));
    write(root, TIER2_REL, JSON.stringify({ _meta: {}, fingerprint: '', events: { agent_start: {} } }));
    const r = v.eventTypeIsDeclared('agent_start', { root });
    assert.deepEqual(r.declaredIn, { md: true, shadow: true, tier2: true });
    assert.equal(r.allAgree, true);
  });

  test('partial declaration (md has it, sidecar is stale/missing) surfaces as disagreement, not silently true', () => {
    const root = seedRoot();
    write(root, SHADOW_REL, JSON.stringify({ _meta: {} })); // regen never ran
    write(root, TIER2_REL, JSON.stringify({ _meta: {}, fingerprint: '', events: {} }));
    const r = v.eventTypeIsDeclared('agent_start', { root });
    assert.equal(r.declaredIn.md, true);
    assert.equal(r.declaredIn.shadow, false);
    assert.equal(r.allAgree, false);
  });

  test('a type declared nowhere is confidently false, not ambiguous', () => {
    const root = seedRoot();
    write(root, SHADOW_REL, JSON.stringify({ _meta: {} }));
    write(root, TIER2_REL, JSON.stringify({ _meta: {}, fingerprint: '', events: {} }));
    const r = v.eventTypeIsDeclared('totally_made_up_type', { root });
    assert.deepEqual(r.declaredIn, { md: false, shadow: false, tier2: false });
    assert.equal(r.allAgree, true); // all three sources confidently agree it's absent
  });
});

// ---------------------------------------------------------------------------
// Failure #10: undeclaredEventTypes — membership, not size subtraction
// ---------------------------------------------------------------------------

describe('undeclaredEventTypes', () => {
  test('failure #10: size subtraction and true membership diff disagree on an overlapping set', () => {
    const root = tmpDir();
    const MD_REL = path.join('agents', 'pm-reference', 'event-schemas.md');
    write(root, MD_REL, [
      '### `a`',
      '```json', '{ "type": "a", "version": 1 }', '```',
      '### `b`',
      '```json', '{ "type": "b", "version": 1 }', '```',
      '### `c`',
      '```json', '{ "type": "c", "version": 1 }', '```',
      '',
    ].join('\n'));

    // "discovered" types include 2 declared (a, b) and 3 undeclared (x, y, z).
    const discovered = ['a', 'b', 'x', 'y', 'z'];

    // The naive bug: comparing SET SIZES (5 discovered - 3 declared-in-md = 2)
    // gives a plausible-looking number that is not the real answer.
    const naiveSizeDiff = discovered.length - 3;
    assert.notEqual(naiveSizeDiff, 3, 'sanity: size subtraction really does give the wrong count here');

    const r = v.undeclaredEventTypes(discovered, { root });
    assert.equal(r.confident, true);
    assert.deepEqual(r.undeclared.sort(), ['x', 'y', 'z']);
    assert.deepEqual(r.declared.sort(), ['a', 'b']);
    assert.equal(r.undeclared.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Failure #4: configKeyIsReferenced — snake_case config key vs camelCase code
// ---------------------------------------------------------------------------

describe('configKeyIsReferenced', () => {
  test('failure #4: literal snake_case grep misses the real camelCase call site', () => {
    const root = tmpDir();
    write(root, 'bin/install.js', 'const DEFAULTS = {\n  cold_init_async: true,\n};\n');
    write(root, 'bin/_lib/repo-map.js', "const coldInitAsync = opts.coldInitAsync !== false;\n");

    const naiveHits = v.walkFiles(root).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('cold_init_async'));
    assert.equal(naiveHits.length, 1, 'sanity: the naive literal grep only finds the declaration site');

    const r = v.configKeyIsReferenced('cold_init_async', { root });
    assert.equal(r.referenced, true);
    assert.equal(r.camelCase, 'coldInitAsync');
    assert.ok(r.evidence.some((e) => e.file === path.join('bin', '_lib', 'repo-map.js') && e.convention === 'camelCase'));
    assert.ok(r.evidence.some((e) => e.convention === 'snake_case'));
  });

  test('a key referenced under neither spelling is confidently unreferenced', () => {
    const root = tmpDir();
    write(root, 'a.js', 'const x = 1;\n');
    const r = v.configKeyIsReferenced('totally_unused_key', { root });
    assert.equal(r.referenced, false);
    assert.equal(r.confident, true);
  });
});

// ---------------------------------------------------------------------------
// Failure #6, #7, #8: callSitesMissingArg
// ---------------------------------------------------------------------------

describe('callSitesMissingArg', () => {
  test('failure #6: a docstring mention of fnName(...) is not counted as a call site', () => {
    const root = tmpDir();
    write(root, 'g.js', [
      '/**',
      ' * Self-calls getChunk() when the event type is unknown.',
      ' */',
      'function caller(eventType, cwd) {',
      '  return getChunk(eventType, { cwd });',
      '}',
    ].join('\n'));

    // Naive bug: a raw-text line scan for /getChunk\(/ counts both the
    // docstring line AND the real call — a phantom extra "call site".
    const naiveCount = (fs.readFileSync(path.join(root, 'g.js'), 'utf8').match(/getChunk\(/g) || []).length;
    assert.equal(naiveCount, 2, 'sanity: the naive raw-text scan really does count the docstring too');

    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.callSites.length, 1);
    assert.equal(r.callSites[0].hasArg, true);
  });

  test('failure #7: ES6 shorthand property { cwd } satisfies argName "cwd"', () => {
    const root = tmpDir();
    write(root, 'h.js', 'getChunk(eventType, { cwd });\n');
    // Naive bug: a regex requiring `cwd\s*:` never matches shorthand.
    const naiveKeyedOnly = /cwd\s*:/.test(fs.readFileSync(path.join(root, 'h.js'), 'utf8'));
    assert.equal(naiveKeyedOnly, false, 'sanity: a keyed-only regex really does miss the shorthand form');

    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.callSites.length, 1);
    assert.equal(r.callSites[0].hasArg, true);
    assert.equal(r.callSites[0].form, 'shorthand');
  });

  test('keyed form { cwd: someVar } is also recognized', () => {
    const root = tmpDir();
    write(root, 'i.js', 'getChunk(eventType, { cwd: projectRoot });\n');
    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.callSites[0].hasArg, true);
    assert.equal(r.callSites[0].form, 'keyed');
  });

  test('bare positional argument matching argName is recognized', () => {
    const root = tmpDir();
    write(root, 'j.js', 'resolvePath(cwd);\n');
    const r = v.callSitesMissingArg('resolvePath', 'cwd', { root });
    assert.equal(r.callSites[0].hasArg, true);
    assert.equal(r.callSites[0].form, 'bare');
  });

  test('a call site genuinely lacking the arg is reported as missing', () => {
    const root = tmpDir();
    write(root, 'k.js', 'getChunk(eventType, { other: 1 });\n');
    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].hasArg, false);
  });

  test('failure #8: every matching file is scanned, not just the first alphabetically', () => {
    const root = tmpDir();
    write(root, 'a-first.js', 'getChunk(eventType, { cwd });\n');       // has the arg
    write(root, 'z-second.js', 'getChunk(eventType, { other: 1 });\n'); // missing the arg
    // Naive bug: `find . | head -1` (or any single-file shortcut) would only
    // ever see a-first.js and report zero missing call sites.
    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.callSites.length, 2);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].file, 'z-second.js');
  });

  test('the function\'s own declaration line is not counted as a call site', () => {
    const root = tmpDir();
    write(root, 'l.js', [
      'function getChunk(event_type, opts) {',
      '  const cwd = (opts && opts.cwd) || process.cwd();',
      '  return cwd;',
      '}',
      'module.exports = { getChunk };',
    ].join('\n'));
    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.callSites.length, 0);
  });

  test('failure #9: root-based resolution, not cwd or __dirname of this file', () => {
    const root = tmpDir();
    write(root, 'nested/deep/dir/m.js', 'getChunk(eventType, { cwd });\n');
    // process.cwd() during the test run is the repo root — nowhere near
    // `root` — so a correct result here proves resolution went through the
    // explicit `root` option, not an implicit relative require/read.
    assert.notEqual(process.cwd(), root);
    const r = v.callSitesMissingArg('getChunk', 'cwd', { root });
    assert.equal(r.callSites.length, 1);
    assert.equal(r.callSites[0].file, path.join('nested', 'deep', 'dir', 'm.js'));
  });
});

// ---------------------------------------------------------------------------
// v2.3.25 bug: walkFiles' `exclude` matched only an exact directory
// basename, so `exclude: ['tests/']` matched nothing (no directory is
// literally named "tests/") — reproduced against callSitesMissingArg.
// ---------------------------------------------------------------------------

describe('isPathExcluded / walkFiles — segment-based exclude matching', () => {
  test('reproduction: exclude: ["tests/"] removes tests/-prefixed hits (0 production hits)', () => {
    const root = tmpDir();
    // 3 deliberate test-fixture calls missing the arg — the exact shape that
    // produced 9 phantom hits in the real bug report (one call per line in
    // tests/degraded-journal-persist-dedup.test.js).
    write(root, 'tests/degraded-journal-persist-dedup.helper.js', [
      "recordDegradation('a');",
      "recordDegradation('b');",
      "recordDegradation('c');",
    ].join('\n'));
    // One real production call site, correctly supplying the arg.
    write(root, 'lib/degrade.js', "recordDegradation('x', projectRoot);\n");

    // Sanity, with includeTests:true (bypasses the new default test-file
    // filter below) to isolate the `exclude` fix in isolation: all 4 call
    // sites are found before any exclude is applied.
    const before = v.callSitesMissingArg('recordDegradation', 'projectRoot', { root, includeTests: true });
    assert.equal(before.callSites.length, 4);
    assert.equal(before.missing.length, 3);

    const after = v.callSitesMissingArg('recordDegradation', 'projectRoot', {
      root, includeTests: true, exclude: ['tests/'],
    });
    assert.equal(after.callSites.length, 1);
    assert.equal(after.missing.length, 0, 'production hits after filtering tests/ must be 0');
  });

  test('exclusion by bare path segment does not also match an unrelated segment containing the same substring', () => {
    const root = tmpDir();
    write(root, 'pkg/__tests__/deep/spec.js', 'x');
    write(root, 'pkg/contested/spec2.js', 'x'); // contains "tests" as a substring, but is a different segment
    write(root, 'pkg/tests/spec3.js', 'x');

    const relsOf = (files) => files.map((f) => path.relative(root, f).split(path.sep).join('/'));

    const excludeTests = relsOf(v.walkFiles(root, { exclude: ['tests'] }));
    assert.ok(excludeTests.includes('pkg/contested/spec2.js'), 'segment matching must not treat "tests" as a substring of "contested"');
    assert.ok(!excludeTests.includes('pkg/tests/spec3.js'));

    const excludeDunder = relsOf(v.walkFiles(root, { exclude: ['__tests__'] }));
    assert.ok(!excludeDunder.includes('pkg/__tests__/deep/spec.js'), '__tests__ must match regardless of nesting depth');
  });

  test('exclusion by multi-segment prefix ("bin/_tools/") matches the exact contiguous run, at any depth', () => {
    const root = tmpDir();
    write(root, 'bin/_tools/verify.js', 'x');
    write(root, 'other/bin/_tools/helper.js', 'x'); // same segment run, nested deeper
    write(root, 'bin/_toolsx/notmatched.js', 'x'); // different segment name entirely

    const files = v.walkFiles(root, { exclude: ['bin/_tools/'] });
    const rels = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
    assert.ok(!rels.includes('bin/_tools/verify.js'));
    assert.ok(!rels.includes('other/bin/_tools/helper.js'), 'prefix fragment must match regardless of position in the path');
    assert.ok(rels.includes('bin/_toolsx/notmatched.js'), 'a different segment name must survive a prefix fragment exclude');
  });

  test('an empty exclude behaves as before (only the built-in noise dirs are pruned)', () => {
    const root = tmpDir();
    write(root, 'a.js', 'x');
    write(root, 'node_modules/dep/index.js', 'x'); // still pruned via DEFAULT_EXCLUDE_DIRS
    const files = v.walkFiles(root, { exclude: [] });
    const rels = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
    assert.deepEqual(rels, ['a.js']);
  });
});

describe('callSitesMissingArg — default test-file exclusion is visible, not silent', () => {
  test('test files (tests/, __tests__/, *.test.js) are excluded by default and the count is surfaced', () => {
    const root = tmpDir();
    write(root, 'lib/prod.js', 'recordDegradation(reason);\n');
    write(root, 'lib/prod.test.js', 'recordDegradation(reason);\nrecordDegradation(reason2);\n');
    write(root, '__tests__/fixture.js', 'recordDegradation(reason3);\n');

    const r = v.callSitesMissingArg('recordDegradation', 'reason', { root });
    assert.equal(r.includeTests, false);
    assert.equal(r.callSites.length, 1, 'only the production file is in callSites by default');
    assert.equal(r.callSites[0].file, path.join('lib', 'prod.js'));
    assert.equal(r.excludedTestCallSites.length, 3, 'the 2 .test.js + 1 __tests__/ call sites are excluded but counted, not silently dropped');
  });

  test('includeTests: true opts back in and folds test call sites into callSites', () => {
    const root = tmpDir();
    write(root, 'lib/prod.test.js', 'recordDegradation(reason);\n');
    const r = v.callSitesMissingArg('recordDegradation', 'reason', { root, includeTests: true });
    assert.equal(r.includeTests, true);
    assert.equal(r.callSites.length, 1);
    assert.deepEqual(r.excludedTestCallSites, []);
  });
});

// ---------------------------------------------------------------------------
// Failure #5: jsonlRowsWhere — "event" vs "type" key
// ---------------------------------------------------------------------------

describe('jsonlRowsWhere', () => {
  test('failure #5: rows keyed "event" instead of "type" are not silently missed', () => {
    const root = tmpDir();
    const file = write(root, 'events.jsonl', [
      JSON.stringify({ type: 'agent_start', id: 1 }),
      JSON.stringify({ event: 'agent_start', id: 2 }), // legacy/alternate key shape
      JSON.stringify({ type: 'agent_stop', id: 3 }),
      '',
    ].join('\n'));

    // Naive bug: grepping raw text for `"type":"agent_start"` only finds row 1.
    const naiveHits = fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.includes('"type":"agent_start"') || l.includes('"type": "agent_start"'));
    assert.equal(naiveHits.length, 1, 'sanity: the naive text grep really does miss the "event"-keyed row');

    const r = v.jsonlRowsWhere(file, (row) => (row.type || row.event) === 'agent_start');
    assert.equal(r.confident, true);
    assert.equal(r.matches.length, 2);
    assert.deepEqual(r.matches.map((m) => m.row.id).sort(), [1, 2]);
  });

  test('malformed lines are recorded, not thrown or silently dropped', () => {
    const root = tmpDir();
    const file = write(root, 'bad.jsonl', '{"type":"a"}\nnot json\n{"type":"b"}\n');
    const r = v.jsonlRowsWhere(file, (row) => row.type === 'b');
    assert.equal(r.matches.length, 1);
    assert.equal(r.malformed.length, 1);
    assert.equal(r.malformed[0].line, 2);
    assert.equal(r.totalRows, 3);
  });

  test('a missing file reports confident:false, not an empty-but-confident result', () => {
    const root = tmpDir();
    const r = v.jsonlRowsWhere(path.join(root, 'does-not-exist.jsonl'), () => true);
    assert.equal(r.confident, false);
    assert.equal(r.matches.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Shared primitives — direct coverage of the string/comment/bracket handling
// every function above depends on.
// ---------------------------------------------------------------------------

describe('stripComments', () => {
  test('block and line comments are blanked, string contents survive', () => {
    const src = "const x = '// not a comment'; // real comment\n/* block */ const y = 1;\n";
    const out = v.stripComments(src);
    assert.ok(out.includes("'// not a comment'"));
    assert.ok(!/real comment/.test(out));
    assert.ok(!/block/.test(out));
    assert.equal(out.split('\n').length, src.split('\n').length, 'line count preserved');
  });

  test('a slash inside a string is not mistaken for a comment start', () => {
    const src = "const url = 'http://example.com'; const kept = 2;\n";
    const out = v.stripComments(src);
    assert.ok(out.includes('kept'));
    assert.ok(out.includes('http://example.com'));
  });
});

describe('findMatchingBracket / splitTopLevel', () => {
  test('nested brackets and a comma inside a string do not confuse the split', () => {
    const args = "eventType, { cwd, nested: { a: 1, b: 2 } }, 'a,b,c'";
    const parts = v.splitTopLevel(args);
    assert.equal(parts.length, 3);
    assert.equal(parts[2], "'a,b,c'");
  });

  test('findMatchingBracket returns -1 on truncated input', () => {
    const idx = v.findMatchingBracket('foo(a, b', 3);
    assert.equal(idx, -1);
  });
});

describe('toCamelCase', () => {
  test('snake_case to camelCase', () => {
    assert.equal(v.toCamelCase('cold_init_async'), 'coldInitAsync');
    assert.equal(v.toCamelCase('already_camel_ok'), 'alreadyCamelOk');
    assert.equal(v.toCamelCase('single'), 'single');
  });
});

// ---------------------------------------------------------------------------
// CLI smoke test
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v2.3.25 hardening: every public function must fail soft on malformed
// input — {confident: false, reason} — never throw, and never fabricate a
// confident-looking answer from garbage input. Table-driven: null /
// wrong-type / empty / nonexistent-root for each of the seven exports.
// ---------------------------------------------------------------------------

describe('fail-soft contract on malformed input', () => {
  function assertFailSoft(r) {
    assert.equal(r.confident, false, 'expected confident:false for malformed input');
    assert.equal(typeof r.reason, 'string', 'expected a reason string');
    assert.ok(r.reason.length > 0, 'reason must not be empty');
  }

  function call(fn) {
    let r;
    assert.doesNotThrow(() => { r = fn(); }, 'a verification helper that crashes is worse than the grep it replaces');
    return r;
  }

  function goodRoot() {
    const root = tmpDir();
    write(root, path.join('agents', 'pm-reference', 'event-schemas.md'), [
      '### `known_event`', '```json', '{ "type": "known_event", "version": 1 }', '```', '',
    ].join('\n'));
    return root;
  }
  function missingRoot() { return path.join(tmpDir(), 'does-not-exist'); }

  describe('envSwitchIsRead', () => {
    const cases = [
      ['null name', () => v.envSwitchIsRead(null, { root: goodRoot() })],
      ['wrong-type name (number)', () => v.envSwitchIsRead(123, { root: goodRoot() })],
      ['empty name', () => v.envSwitchIsRead('', { root: goodRoot() })],
      ['nonexistent root', () => v.envSwitchIsRead('X', { root: missingRoot() })],
      ['wrong-type root (number)', () => v.envSwitchIsRead('X', { root: 123 })],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }
  });

  describe('agentGrantsTool', () => {
    const cases = [
      ['null agentFile', () => v.agentGrantsTool(null, 'Read')],
      ['wrong-type agentFile (number)', () => v.agentGrantsTool(123, 'Read')],
      ['empty agentFile', () => v.agentGrantsTool('', 'Read')],
      ['nonexistent agentFile', () => v.agentGrantsTool(path.join(missingRoot(), 'x.md'), 'Read')],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }
  });

  describe('eventTypeIsDeclared', () => {
    const cases = [
      ['null type', () => v.eventTypeIsDeclared(null, { root: goodRoot() })],
      ['wrong-type type (number)', () => v.eventTypeIsDeclared(123, { root: goodRoot() })],
      ['empty type', () => v.eventTypeIsDeclared('', { root: goodRoot() })],
      ['nonexistent root', () => v.eventTypeIsDeclared('known_event', { root: missingRoot() })],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }

    // Observed defect, verbatim: a confident:true, declaredIn:{md:false,...}
    // result for a malformed `type` is byte-identical to a real "declared
    // nowhere" negative. Assert the two are now distinguishable.
    test('eventTypeIsDeclared(null) is distinguishable from a genuine "not declared" result', () => {
      const root = goodRoot();
      const real = v.eventTypeIsDeclared('totally_made_up_type', { root });
      const malformed = v.eventTypeIsDeclared(null, { root });
      assert.equal(real.confident, true, 'sanity: a real absent type is still a confident negative');
      assert.equal(malformed.confident, false, 'a malformed type must not be confident');
      assert.notDeepEqual(malformed.declaredIn, real.declaredIn,
        'malformed-input declaredIn must not equal the real "declared nowhere" shape');
    });
  });

  describe('undeclaredEventTypes', () => {
    const cases = [
      ['null types', () => v.undeclaredEventTypes(null, { root: goodRoot() })],
      ['wrong-type types (plain object)', () => v.undeclaredEventTypes({ root: goodRoot() })],
      ['string types (would silently iterate by character)', () => v.undeclaredEventTypes('abc', { root: goodRoot() })],
      ['empty-string element in array', () => v.undeclaredEventTypes([''], { root: goodRoot() })],
      ['nonexistent root', () => v.undeclaredEventTypes(['a'], { root: missingRoot() })],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }

    // Observed defect, verbatim: options object passed positionally where the
    // array belonged (failure #7's shape — positional vs object args).
    test('undeclaredEventTypes({root}) — options object mistaken for the types array — fails soft, not "types is not iterable"', () => {
      const r = call(() => v.undeclaredEventTypes({ root: goodRoot() }));
      assertFailSoft(r);
      assert.equal(r.reason, 'invalid_types');
    });
  });

  describe('configKeyIsReferenced', () => {
    const cases = [
      ['null key', () => v.configKeyIsReferenced(null, { root: goodRoot() })],
      ['wrong-type key (number)', () => v.configKeyIsReferenced(123, { root: goodRoot() })],
      ['empty key', () => v.configKeyIsReferenced('', { root: goodRoot() })],
      ['nonexistent root', () => v.configKeyIsReferenced('cold_init_async', { root: missingRoot() })],
      ['wrong-type root (number)', () => v.configKeyIsReferenced('cold_init_async', { root: 123 })],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }
  });

  describe('callSitesMissingArg', () => {
    const cases = [
      ['null fnName', () => v.callSitesMissingArg(null, 'cwd', { root: goodRoot() })],
      ['wrong-type fnName (number)', () => v.callSitesMissingArg(123, 'cwd', { root: goodRoot() })],
      ['empty fnName', () => v.callSitesMissingArg('', 'cwd', { root: goodRoot() })],
      ['null argName', () => v.callSitesMissingArg('getChunk', null, { root: goodRoot() })],
      ['empty argName', () => v.callSitesMissingArg('getChunk', '', { root: goodRoot() })],
      ['nonexistent root', () => v.callSitesMissingArg('getChunk', 'cwd', { root: missingRoot() })],
      ['wrong-type root (number)', () => v.callSitesMissingArg('getChunk', 'cwd', { root: 123 })],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }

    // Observed defect, verbatim.
    test('callSitesMissingArg(null,"x",{root}) fails soft instead of throwing', () => {
      const r = call(() => v.callSitesMissingArg(null, 'x', { root: goodRoot() }));
      assertFailSoft(r);
      assert.equal(r.reason, 'invalid_fn_name');
    });
  });

  describe('jsonlRowsWhere', () => {
    const cases = [
      ['null file', () => v.jsonlRowsWhere(null, () => true)],
      ['wrong-type file (number)', () => v.jsonlRowsWhere(123, () => true)],
      ['empty file', () => v.jsonlRowsWhere('', () => true)],
      ['nonexistent file', () => v.jsonlRowsWhere(path.join(missingRoot(), 'x.jsonl'), () => true)],
    ];
    for (const [label, fn] of cases) {
      test(label, () => assertFailSoft(call(fn)));
    }
  });
});

// ---------------------------------------------------------------------------
// Performance: a real-repo-shaped four-case envSwitchIsRead probe must stay
// well under the 45s budget observed to be exceeded pre-fix. DEFAULT_EXCLUDE_DIRS
// already prunes node_modules/.git/.orchestray/.claude before descending, so a
// large-but-excluded subtree must not affect wall time.
// ---------------------------------------------------------------------------

describe('envSwitchIsRead — performance against a repo-shaped tree', () => {
  test('four-case probe against a root with a large excluded subtree completes well under 45s', () => {
    const root = tmpDir();
    write(root, 'bin/real.js', "if (process.env.ORCHESTRAY_PERF_CASE === '1') {}\n");
    // Simulate a bulky excluded subtree (stand-in for .claude/worktrees/*)
    // that must be pruned before descent, not walked and then discarded.
    for (let i = 0; i < 50; i++) {
      write(root, `.claude/worktrees/agent-${i}/bin/noise.js`, "if (process.env.ORCHESTRAY_PERF_CASE === '1') {}\n".repeat(20));
      write(root, `node_modules/pkg-${i}/index.js`, 'module.exports = {};\n'.repeat(20));
    }

    const start = Date.now();
    for (let i = 0; i < 4; i++) {
      v.envSwitchIsRead('ORCHESTRAY_PERF_CASE', { root });
    }
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 45000, `expected < 45000ms, got ${elapsedMs}ms`);
  });
});

describe('CLI', () => {
  test('main() prints JSON and returns 0 for a known subcommand', () => {
    const root = tmpDir();
    write(root, 'agents/x.md', '---\ntools: [Read]\n---\n');
    const origWrite = process.stdout.write;
    let captured = '';
    process.stdout.write = (chunk) => { captured += chunk; return true; };
    let code;
    try {
      code = v.main(['tool', path.join(root, 'agents', 'x.md'), 'Read']);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(code, 0);
    const parsed = JSON.parse(captured);
    assert.equal(parsed.granted, true);
  });

  test('an unknown subcommand exits 2', () => {
    const origWrite = process.stderr.write;
    let wrote = false;
    process.stderr.write = () => { wrote = true; return true; };
    let code;
    try { code = v.main(['bogus']); } finally { process.stderr.write = origWrite; }
    assert.equal(code, 2);
    assert.equal(wrote, true);
  });
});
