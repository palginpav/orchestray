#!/usr/bin/env node
'use strict';

/**
 * T8 — ghost event regression: `active_phase_slice_changed` must not exist in production code.
 *
 * RCA: `.orchestray/kb/artifacts/v2220-ghost-event-rca.md`
 *
 * In v2.2.19, `active_phase_slice_changed` was referenced in schema/documentation but
 * had zero producers and zero consumers in production code. It is a ghost event.
 * This test prevents reintroduction: if any production file in bin/, agents/, skills/,
 * or hooks/ mentions the literal string `active_phase_slice_changed`, this test fails.
 *
 * The test intentionally references the event name in its own source; that self-reference
 * is expected and does NOT cause a false-positive because tests/ is excluded from the scan.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GHOST_EVENT = 'active_phase_slice_changed';

// Production directories to scan — tests/ is explicitly excluded to avoid self-reference.
const SCAN_DIRS = ['bin', 'agents', 'skills', 'hooks'];

/**
 * Recursively collect all files under a directory.
 */
function collectFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    // Directory doesn't exist — nothing to scan.
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

test(`ghost event "${GHOST_EVENT}" must not appear in production files`, () => {
  const projectRoot = path.resolve(__dirname, '..');
  const matches = [];

  for (const dirName of SCAN_DIRS) {
    const dirPath = path.join(projectRoot, dirName);
    const files = collectFiles(dirPath);
    for (const filePath of files) {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (_e) {
        // Skip unreadable files (e.g., binaries).
        continue;
      }
      if (content.includes(GHOST_EVENT)) {
        matches.push(path.relative(projectRoot, filePath));
      }
    }
  }

  assert.deepStrictEqual(
    matches,
    [],
    `Ghost event "${GHOST_EVENT}" found in production file(s): ${matches.join(', ')}. ` +
    `This event has no producers or consumers (see RCA: .orchestray/kb/artifacts/v2220-ghost-event-rca.md). ` +
    `Remove any new references before merging.`
  );
});
