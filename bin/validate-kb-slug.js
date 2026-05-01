#!/usr/bin/env node
'use strict';

/**
 * validate-kb-slug.js — PreToolUse:Write hook (v2.2.11 W2-2).
 *
 * Triggers when a Write targets the KB directory tree
 * (`.orchestray/kb/{facts,decisions,artifacts}/...`). Extracts the filename
 * (slug) and rejects it via hard-block (exit 2) if it contains characters
 * outside `[a-zA-Z0-9_-]` (e.g. `..`, `/`, `.`, or any special char).
 *
 * Rationale: agent-common-protocol.md:22 — KB slugs are written without path
 * validation; `..` in slugs could escape the KB tree. This validator is the
 * mechanical enforcement described in the W2 audit.
 *
 * Behaviour:
 *   - Hard-block (exit 2) on invalid slug — emits `kb_slug_validation_failed`.
 *   - Exit 0 (allow) when slug is valid or path is not a KB target.
 *   - Fail-open on any internal error (exit 0).
 *   - Kill switch: ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED=1
 *
 * Input:  Claude Code PreToolUse:Write JSON payload on stdin
 * Output: { continue: true } or { continue: false, reason: ... } on stdout
 */

const path  = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// KB subdirectories that are subject to slug validation.
const KB_SUBDIRS_RE = /[/\\]\.orchestray[/\\]kb[/\\](?:facts|decisions|artifacts)[/\\]/;

// Valid slug characters (filename without .md extension).
const SLUG_VALID_RE = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the target path is within the KB tree.
 *
 * @param {string} targetPath
 * @returns {boolean}
 */
function isKbPath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  // Normalise separators for cross-platform safety.
  const normalised = targetPath.replace(/\\/g, '/');
  return /\/\.orchestray\/kb\/(?:facts|decisions|artifacts)\//.test(normalised);
}

/**
 * Extract the slug (basename without .md extension) from a path.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function extractSlug(targetPath) {
  const base = path.basename(targetPath);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Validate a slug — must match /^[a-zA-Z0-9_-]+$/.
 *
 * @param {string} slug
 * @returns {{ valid: boolean, reason: string }}
 */
function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    return { valid: false, reason: 'slug is empty' };
  }
  if (!SLUG_VALID_RE.test(slug)) {
    return { valid: false, reason: 'slug contains disallowed characters (only [a-zA-Z0-9_-] permitted)' };
  }
  return { valid: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only handle Write tool calls.
    const toolName = event.tool_name || event.hook_event_matcher || '';
    if (toolName !== 'Write') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const targetPath = (event.tool_input && typeof event.tool_input.file_path === 'string')
      ? event.tool_input.file_path
      : '';

    if (!isKbPath(targetPath)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const slug = extractSlug(targetPath);
    const { valid, reason } = validateSlug(slug);

    if (!valid) {
      let cwd;
      try {
        cwd = resolveSafeCwd(event.cwd);
      } catch (_) {
        cwd = process.cwd();
      }

      try {
        writeEvent({
          version:        SCHEMA_VERSION,
          schema_version: SCHEMA_VERSION,
          type:           'kb_slug_validation_failed',
          slug,
          path:           targetPath,
          reason,
        }, { cwd });
      } catch (_e) { /* fail-open on emit */ }

      process.stderr.write(
        '[orchestray] validate-kb-slug: BLOCKED — invalid KB slug "' + slug + '": ' + reason + '. ' +
        'Slugs must match /^[a-zA-Z0-9_-]+$/. ' +
        'Kill switch: ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: false, reason: 'kb_slug_invalid' }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  isKbPath,
  extractSlug,
  validateSlug,
  SLUG_VALID_RE,
};

if (require.main === module) {
  main();
}
