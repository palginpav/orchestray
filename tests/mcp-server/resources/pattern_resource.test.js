#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/resources/pattern_resource.js
 *
 * Coverage (v2.1.2 Bundle F Item 1 — shared-tier banner):
 *   (a) No banner when origin field is absent.
 *   (b) Banner is prepended when origin: shared.
 *   (c) Banner format matches the spec literally.
 *   (d) Body after stripping the banner is unchanged.
 *
 * Runner: node --test tests/mcp-server/resources/pattern_resource.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { read } = require('../../../bin/mcp-server/resources/pattern_resource');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pattern-resource-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  return dir;
}

function makeContext(root) {
  return { projectRoot: root };
}

function writePattern(dir, slug, frontmatter, body) {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = `---\n${fmLines}\n---\n\n${body}`;
  const filePath = path.join(dir, '.orchestray', 'patterns', slug + '.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return content;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pattern_resource — shared-tier banner (Bundle F Item 1)', () => {

  test('(a) no banner when origin field is absent (local pattern)', async () => {
    const tmp = makeTmpProject();
    try {
      const body = '## Context\nLocal context.\n\n## Approach\nLocal approach.\n';
      writePattern(tmp, 'local-pattern', {
        name: 'local-pattern',
        category: 'decomposition',
        confidence: 0.8,
        description: 'local pattern no origin',
      }, body);

      const uri = 'orchestray:pattern://local-pattern';
      const result = await read(uri, makeContext(tmp));

      assert.equal(result.contents.length, 1);
      const text = result.contents[0].text;
      assert.ok(!text.startsWith('> Source:'), 'must NOT have a banner for local patterns');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('(b) banner is prepended when origin is "shared"', async () => {
    const tmp = makeTmpProject();
    try {
      const body = '## Context\nShared context.\n\n## Approach\nShared approach.\n';
      writePattern(tmp, 'shared-pattern', {
        name: 'shared-pattern',
        category: 'routing',
        confidence: 0.75,
        description: 'shared pattern with origin',
        origin: 'shared',
        promoted_from: '7b2c91de',
        promoted_at: '2026-04-14T11:32:01.223Z',
      }, body);

      const uri = 'orchestray:pattern://shared-pattern';
      const result = await read(uri, makeContext(tmp));

      assert.equal(result.contents.length, 1);
      const text = result.contents[0].text;
      assert.ok(text.startsWith('> Source:'), 'must have a banner for shared patterns');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('(c) banner format matches the spec: "> Source: shared tier (from project <hash>, promoted <date>)."', async () => {
    const tmp = makeTmpProject();
    try {
      const body = '## Context\nContent.\n';
      writePattern(tmp, 'banner-format-check', {
        name: 'banner-format-check',
        category: 'routing',
        confidence: 0.70,
        description: 'check banner format',
        origin: 'shared',
        promoted_from: 'abcd1234',
        promoted_at: '2026-04-19T08:00:00.000Z',
      }, body);

      const uri = 'orchestray:pattern://banner-format-check';
      const result = await read(uri, makeContext(tmp));

      const text = result.contents[0].text;
      const firstLine = text.split('\n')[0];
      assert.equal(
        firstLine,
        '> Source: shared tier (from project abcd1234, promoted 2026-04-19).',
        'banner format must match spec exactly'
      );
      // Banner followed by blank line then original content.
      assert.equal(text.split('\n')[1], '', 'banner must be followed by a blank line');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('(d) body after stripping the banner is identical to the original file content', async () => {
    const tmp = makeTmpProject();
    try {
      const body = '## Context\nOriginal content.\n\n## Approach\nOriginal approach.\n';
      const originalContent = writePattern(tmp, 'body-unchanged', {
        name: 'body-unchanged',
        category: 'decomposition',
        confidence: 0.80,
        description: 'body unchanged after banner',
        origin: 'shared',
        promoted_from: 'deadbeef',
        promoted_at: '2026-01-01T00:00:00.000Z',
      }, body);

      const uri = 'orchestray:pattern://body-unchanged';
      const result = await read(uri, makeContext(tmp));

      const text = result.contents[0].text;
      // The output should be: banner + "\n" + originalContent
      assert.ok(text.startsWith('> Source:'), 'banner should be present');
      // Strip the banner (first line + blank line) to recover original content.
      const bannerEnd = text.indexOf('\n\n') + 2;
      const recoveredContent = text.slice(bannerEnd);
      assert.equal(
        recoveredContent,
        originalContent,
        'content after the banner must equal the original file content verbatim'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
