'use strict';

/**
 * v2.3.12 W14 (M2) — enforcement-substrate write denylist.
 *
 * Doc/test/review-tier roles must not write agent definition prompts
 * (agents/*.md) or CLAUDE.md, even where their allowlist would otherwise match.
 * release-manager keeps its legitimate agents/pm-reference/event-schemas.md write
 * (NOT under the denylist's agents/*.md single-segment scope).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const rw = require('../bin/_lib/role-write-allowlists');
const { isSubstrateDenied } = rw;

test('substrate denylist matches agent definitions + CLAUDE.md', () => {
  assert.strictEqual(isSubstrateDenied('agents/pm.md'), true);
  assert.strictEqual(isSubstrateDenied('agents/developer.md'), true);
  assert.strictEqual(isSubstrateDenied('./agents/architect.md'), true);
  assert.strictEqual(isSubstrateDenied('CLAUDE.md'), true);
});

test('substrate denylist does NOT match pm-reference or docs', () => {
  assert.strictEqual(isSubstrateDenied('agents/pm-reference/event-schemas.md'), false);
  assert.strictEqual(isSubstrateDenied('docs/guide.md'), false);
  assert.strictEqual(isSubstrateDenied('README.md'), false);
  assert.strictEqual(isSubstrateDenied('CHANGELOG.md'), false);
});

test('kill switch disables the substrate denylist', () => {
  const prev = process.env.ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED;
  process.env.ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED = '1';
  assert.strictEqual(isSubstrateDenied('agents/pm.md'), false);
  if (prev === undefined) delete process.env.ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED;
  else process.env.ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED = prev;
});

test('documenter allowlist no longer grants broad **/*.md', () => {
  const docPatterns = rw.ROLE_WRITE_ALLOWLISTS.documenter;
  assert.ok(!docPatterns.includes('**/*.md'), 'broad **/*.md removed');
  assert.ok(!docPatterns.includes('*.md'), 'broad *.md removed');
  assert.ok(docPatterns.includes('docs/**'));
});
