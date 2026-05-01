#!/usr/bin/env node
'use strict';

// v2.2.21 T17 — SKILL frontmatter lint
//
// Asserts for every SKILL.md under skills/orchestray:<name>/:
//  1. argument-hint: value is double-quoted
//  2. name: matches directory base name (e.g. "run" for orchestray:run)
//  3. Body is grep-clean of forbidden stale version-pin patterns

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

// Forbidden patterns in SKILL bodies (stale version promises).
const FORBIDDEN_BODY_PATTERNS = [
  /for v2\.0\./,
  /for v2\.1\./,
  /planned for v2\./,
  /held for v2\./,
];

function getSkillEntries() {
  return fs.readdirSync(SKILLS_DIR)
    .filter(d => d.startsWith('orchestray:'))
    .map(dir => ({
      dir,
      baseName: dir.replace('orchestray:', ''),
      skillPath: path.join(SKILLS_DIR, dir, 'SKILL.md'),
    }))
    .filter(e => fs.existsSync(e.skillPath));
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return match[1];
}

function extractField(frontmatter, field) {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = frontmatter.match(re);
  return m ? m[1].trim() : null;
}

describe('SKILL frontmatter lint', () => {
  const entries = getSkillEntries();

  test('at least one SKILL found', () => {
    assert.ok(entries.length > 0, 'No SKILL.md files found under skills/orchestray:*/');
  });

  for (const { dir, baseName, skillPath } of entries) {
    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(content);

    describe(dir, () => {
      test('has parseable frontmatter', () => {
        assert.ok(frontmatter !== null, `${skillPath}: missing or malformed --- frontmatter block`);
      });

      if (!frontmatter) return;

      test('argument-hint is double-quoted', () => {
        const raw = extractField(frontmatter, 'argument-hint');
        if (raw === null || raw === '') return; // absent or empty — no args, skip
        assert.ok(
          raw.startsWith('"') && raw.endsWith('"'),
          `${skillPath}: argument-hint must be double-quoted. Got: ${raw}`
        );
      });

      test('name matches directory base name', () => {
        const name = extractField(frontmatter, 'name');
        assert.ok(name !== null, `${skillPath}: missing name: field`);
        assert.strictEqual(
          name,
          baseName,
          `${skillPath}: name: "${name}" does not match directory base "${baseName}"`
        );
      });

      test('body is clean of stale version-pin patterns', () => {
        // Body = content after the closing --- of frontmatter.
        const bodyStart = content.indexOf('\n---\n', content.indexOf('---\n')) + 5;
        const body = content.slice(bodyStart);

        for (const pattern of FORBIDDEN_BODY_PATTERNS) {
          const m = body.match(pattern);
          assert.ok(
            !m,
            `${skillPath}: forbidden pattern "${pattern}" found near: "${m ? m[0] : ''}"`
          );
        }
      });
    });
  }
});
