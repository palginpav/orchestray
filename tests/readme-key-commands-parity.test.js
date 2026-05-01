#!/usr/bin/env node
'use strict';

/**
 * readme-key-commands-parity.test.js — v2.2.21 T16 (F-01 / F-16)
 *
 * Asserts that every `/orchestray:*` command listed in CLAUDE.md
 * "Use /orchestray:..." section also appears in README.md "Key commands"
 * table (or the "Recovery / debugging" subsection).
 *
 * Prevents future drift between the canonical CLAUDE.md command list
 * and the user-facing README discovery surface.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * In a git worktree, CLAUDE.md lives in the main worktree (project root),
 * not in the checked-out worktree directory. Find it via git's common-dir.
 *
 * `git rev-parse --git-common-dir` returns the path to the shared .git
 * directory (e.g. /home/user/project/.git). The main worktree is its parent.
 */
function findMainWorktreeRoot() {
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const absCommonDir = path.resolve(REPO_ROOT, gitCommonDir);
    return path.dirname(absCommonDir);
  } catch {
    return REPO_ROOT;
  }
}

const MAIN_ROOT = findMainWorktreeRoot();
const CLAUDE_MD = path.join(MAIN_ROOT, 'CLAUDE.md');
const README_MD = path.join(REPO_ROOT, 'README.md');

/**
 * Extract the base command slug from a `/orchestray:X ...` string.
 * e.g. "/orchestray:state peek" → "state"
 *      "/orchestray:learn-doc <url>" → "learn-doc"
 */
function extractSlug(line) {
  const m = line.match(/\/orchestray:([a-z][a-z0-9:_-]*)/);
  return m ? m[1] : null;
}

/**
 * Parse CLAUDE.md for unique `/orchestray:*` slugs from the
 * "Use /orchestray:..." bullet list.
 */
function parseClaudeMdCommands(content) {
  const slugs = new Set();
  const lines = content.split('\n');
  let inUsageSection = false;

  for (const line of lines) {
    // Match lines of the form "- Use `/orchestray:X ...`" (backtick-wrapped in markdown)
    // or "- Use /orchestray:X ..." (plain)
    if (/^- Use [`]?\/orchestray:/.test(line)) {
      inUsageSection = true;
      const slug = extractSlug(line);
      if (slug) slugs.add(slug);
    } else if (inUsageSection && /^## /.test(line)) {
      // Next top-level heading ends the usage section
      inUsageSection = false;
    } else if (inUsageSection && /\/orchestray:/.test(line)) {
      const slug = extractSlug(line);
      if (slug) slugs.add(slug);
    }
  }

  return slugs;
}

/**
 * Parse README.md for `/orchestray:*` slugs appearing in the
 * "Key commands" table or "Recovery / debugging" subsection.
 */
function parseReadmeCommands(content) {
  const slugs = new Set();
  const lines = content.split('\n');
  let inKeyCommands = false;

  for (const line of lines) {
    if (/^## Key commands/.test(line)) {
      inKeyCommands = true;
    } else if (inKeyCommands && /^## [^#]/.test(line)) {
      // Next top-level heading ends the section
      inKeyCommands = false;
    }

    if (inKeyCommands && /\/orchestray:/.test(line)) {
      const slug = extractSlug(line);
      if (slug) slugs.add(slug);
    }
  }

  return slugs;
}

describe('readme-key-commands-parity (F-01 / F-16)', () => {

  test('CLAUDE.md and README.md both exist', () => {
    assert.ok(fs.existsSync(CLAUDE_MD), `CLAUDE.md not found at ${CLAUDE_MD}`);
    assert.ok(fs.existsSync(README_MD), `README.md not found at ${README_MD}`);
  });

  test('CLAUDE.md lists at least 10 /orchestray:* commands', () => {
    const content = fs.readFileSync(CLAUDE_MD, 'utf8');
    const slugs = parseClaudeMdCommands(content);
    assert.ok(
      slugs.size >= 10,
      `Expected at least 10 commands in CLAUDE.md, found ${slugs.size}: ${[...slugs].join(', ')}`
    );
  });

  test('README.md "Key commands" table lists at least 10 /orchestray:* commands', () => {
    const content = fs.readFileSync(README_MD, 'utf8');
    const slugs = parseReadmeCommands(content);
    assert.ok(
      slugs.size >= 10,
      `Expected at least 10 commands in README Key commands, found ${slugs.size}: ${[...slugs].join(', ')}`
    );
  });

  test('every /orchestray:* command in CLAUDE.md appears in README Key commands', () => {
    const claudeContent = fs.readFileSync(CLAUDE_MD, 'utf8');
    const readmeContent = fs.readFileSync(README_MD, 'utf8');

    const claudeSlugs = parseClaudeMdCommands(claudeContent);
    const readmeSlugs = parseReadmeCommands(readmeContent);

    const missing = [...claudeSlugs].filter(s => !readmeSlugs.has(s)).sort();

    assert.deepEqual(
      missing,
      [],
      `Commands in CLAUDE.md missing from README "Key commands": ${missing.join(', ')}\n` +
      `CLAUDE.md has: ${[...claudeSlugs].sort().join(', ')}\n` +
      `README has:    ${[...readmeSlugs].sort().join(', ')}`
    );
  });

});
