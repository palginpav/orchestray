#!/usr/bin/env node
'use strict';

/**
 * Integration tests for bin/validate-config.js (v2.1.13 R-ZOD).
 *
 * Creates a temporary project root with .orchestray/config.json,
 * .orchestray/patterns/, and specialists/ contents and asserts that the
 * CLI produces the right exit code + output.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../../bin/validate-config.js');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-zod-cli-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(filePath, content) {
  const abs = path.join(tmp, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function captureStdout(fn) {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let code;
  try {
    code = fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, output: chunks.join('') };
}

describe('bin/validate-config.js — integration', () => {
  test('empty project (no artifacts) exits 0', () => {
    const { code, output } = captureStdout(() => run({ cwd: tmp }));
    assert.equal(code, 0);
    assert.match(output, /0 with findings/);
  });

  test('good config + good pattern + good specialist exits 0', () => {
    seed('.orchestray/config.json', JSON.stringify({
      auto_review: true,
      complexity_threshold: 4,
      retrieval: { scorer_variant: 'baseline' },
    }));
    seed('.orchestray/patterns/anti-pattern-x.md',
      '---\nname: anti-pattern-x\ncategory: anti-pattern\nconfidence: 0.7\ndescription: example\n---\n\n# content\n');
    seed('specialists/sample.md',
      '---\nname: sample\ndescription: A sample specialist.\nmodel: sonnet\n---\n\n# body\n');
    const { code, output } = captureStdout(() => run({ cwd: tmp }));
    assert.equal(code, 0);
    assert.match(output, /3 checked/);
    assert.match(output, /0 with findings/);
  });

  test('malformed config triggers non-zero exit and actionable message', () => {
    seed('.orchestray/config.json', JSON.stringify({
      auto_review: 'yes',
      retrieval: { scorer_variant: 'magic' },
    }));
    const { code, output } = captureStdout(() => run({ cwd: tmp }));
    assert.equal(code, 1);
    assert.match(output, /✗ .orchestray\/config\.json/);
    assert.match(output, /auto_review/);
    assert.match(output, /retrieval\.scorer_variant/);
  });

  test('malformed pattern frontmatter is flagged', () => {
    seed('.orchestray/patterns/bad.md',
      '---\nname: Bad-Name\ncategory: miscellaneous\nconfidence: 1.5\ndescription: ""\n---\n\n# body\n');
    const { code, output } = captureStdout(() => run({ cwd: tmp }));
    assert.equal(code, 1);
    assert.match(output, /✗ .orchestray\/patterns\/bad\.md/);
    assert.match(output, /category/);
    assert.match(output, /confidence/);
  });

  test('specialist filename↔name mismatch is flagged even if frontmatter is otherwise valid', () => {
    seed('specialists/api-contract-designer.md',
      '---\nname: something-else\ndescription: ok\nmodel: sonnet\n---\n\n');
    const { code, output } = captureStdout(() => run({ cwd: tmp }));
    assert.equal(code, 1);
    assert.match(output, /must match filename basename/);
    assert.match(output, /something-else/);
  });

  test('--json mode emits machine-readable output', () => {
    seed('.orchestray/config.json', JSON.stringify({ auto_review: 'nope' }));
    const { code, output } = captureStdout(() => run({ cwd: tmp, json: true }));
    assert.equal(code, 1);
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, false);
    assert.ok(Array.isArray(parsed.groups));
    // Must locate the failure under the 'config' group.
    const cfgGroup = parsed.groups.find((g) => g.group === 'config');
    assert.ok(cfgGroup);
    assert.equal(cfgGroup.results[0].ok, false);
  });
});
