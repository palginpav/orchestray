/**
 * tests/delegation-template-completeness.test.js — v2.2.21 W3-T10 (PM mid-flight fix)
 *
 * The documenter agent that authored agents/pm-reference/delegation-templates.md
 * was correctly hard-blocked by bin/gate-role-write-paths.js (W1-T8 hardening) when
 * it tried to create this test file. Documenter writes are restricted to docs/**.md.
 * The PM authored this test file directly post-merge.
 *
 * Asserts that the Reviewer Delegation Template in delegation-templates.md
 * contains every block required by the four reviewer-prompt hooks:
 *   - validate-reviewer-dimensions: ## Dimensions to Apply heading + bullet list
 *   - validate-reviewer-git-diff:   ## Git Diff section (with audit-mode example)
 *   - validate-reviewer-scope:      explicit file list (files: header or bulleted scope)
 *   - preflight-spawn-budget:       context_size_hint: line
 *
 * If a reviewer template change ever drops one of these blocks, this test fails
 * before the change reaches a real spawn.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = (() => {
  // Resolve repo root via git-toplevel so the test runs from any worktree.
  // (rev-parse --git-common-dir returns a path RELATIVE to cwd; use --show-toplevel
  // for an absolute path, or fall back to __dirname/..)
  try {
    const { execSync } = require('child_process');
    const top = execSync('git rev-parse --show-toplevel', { cwd: __dirname }).toString().trim();
    if (top && fs.existsSync(top)) {
      // If we're in a worktree, --show-toplevel is the worktree root, but
      // delegation-templates.md is committed to master — both worktree and master
      // have it. Use this directly.
      return top;
    }
  } catch (_) { /* fall through */ }
  return path.resolve(__dirname, '..');
})();

const TEMPLATE_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'delegation-templates.md');

describe('v2.2.21 W3-T10 — delegation-templates reviewer template completeness', () => {
  test('delegation-templates.md exists and is readable', () => {
    assert.ok(fs.existsSync(TEMPLATE_PATH), 'delegation-templates.md must exist');
    const stat = fs.statSync(TEMPLATE_PATH);
    assert.ok(stat.size > 1000, 'delegation-templates.md must be non-trivial');
  });

  test('reviewer template includes ## Dimensions to Apply heading + bullet list', () => {
    const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    // Anchor on a real H2 heading (line start), not an inline mention.
    assert.match(content, /^## Dimensions to Apply/im,
      'delegation-templates.md must include a ## Dimensions to Apply H2 heading');
    // Find the FIRST line-start heading and inspect the next 600 chars for bullets.
    const idx = content.search(/^## Dimensions to Apply/im);
    const slice = content.slice(idx, idx + 600);
    const bulletCount = (slice.match(/^- [a-zA-Z]/gm) || []).length;
    assert.ok(bulletCount >= 3,
      `Dimensions to Apply section must have >= 3 bullet entries; got ${bulletCount}`);
  });

  test('reviewer template includes ## Git Diff section with audit-mode example', () => {
    const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    assert.match(content, /## Git Diff/i,
      'delegation-templates.md must include a ## Git Diff section');
    assert.match(content, /n\/?a.*audit.?mode/i,
      'Reviewer template must show the audit-mode marker (e.g., _n/a — audit-mode dispatch_)');
  });

  test('reviewer template documents explicit file list / scope', () => {
    const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    // Either `files:` header or `scope:` section or a bulleted file list — any one suffices.
    const hasFilesHeader = /\bfiles\s*:/i.test(content);
    const hasScopeSection = /\bscope\s*:/i.test(content);
    assert.ok(hasFilesHeader || hasScopeSection,
      'reviewer template must document an explicit files: header or scope: section');
  });

  test('reviewer template references context_size_hint', () => {
    const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    assert.match(content, /context_size_hint\s*:/i,
      'reviewer template must show a context_size_hint: line');
  });

  test('reviewer template references acceptance_rubric for design-tier', () => {
    const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    // W2-T7 added design-tier acceptance_rubric enforcement. Template should explain.
    assert.match(content, /acceptance.?rubric/i,
      'reviewer/architect template should reference acceptance_rubric for design roles');
  });

  test('handoff-contract.md output-shape mapping table is present (W3-T10 §4a)', () => {
    const HC_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'handoff-contract.md');
    const content = fs.readFileSync(HC_PATH, 'utf8');
    assert.match(content, /Output Shape Mapping|output_shape/i,
      'handoff-contract.md must document the output-shape mapping (4 enum values)');
  });

  test('agent-common-protocol.md frontmatter declares always_available: true', () => {
    const ACP_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'agent-common-protocol.md');
    const content = fs.readFileSync(ACP_PATH, 'utf8');
    // Must appear in frontmatter (first 30 lines).
    const frontmatter = content.split('\n').slice(0, 30).join('\n');
    assert.match(frontmatter, /always_available\s*:\s*true/i,
      'agent-common-protocol.md frontmatter must declare always_available: true');
  });
});
