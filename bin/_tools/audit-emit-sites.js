#!/usr/bin/env node
'use strict';

/**
 * audit-emit-sites.js — R-SHDW-EMIT migration completeness gate (v2.1.15).
 *
 * Walks `bin/` and `hooks/` and asserts that every `atomicAppendJsonl(...)` or
 * `atomicAppendJsonlIfAbsent(...)` call whose target path-string contains
 * `events.jsonl` originates from a file that imports `audit-event-writer.js`,
 * OR is one of the documented exceptions below.
 *
 * Exit code 0: all events.jsonl writes route through the gateway (or are a
 *              documented exception).
 * Exit code 1: at least one bypass site found. Prints a list.
 *
 * Run from the repo root:
 *   node bin/_tools/audit-emit-sites.js
 *
 * Designed to run in well under 5 seconds. Node stdlib only.
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Files allowed to call `atomicAppendJsonl[IfAbsent]` directly with an
// events.jsonl target path. Each entry must include the reason.
const EXCEPTIONS = {
  // The gateway IS the central writer. By contract it calls atomicAppendJsonl.
  'bin/_lib/audit-event-writer.js':
    'gateway implementation (calls atomicAppendJsonl on events.jsonl by design)',

  // Idempotent advisory writes with matchFn (records pattern_record_skipped
  // only if no prior event with same orchestration_id exists). The gateway
  // does not yet expose an `IfAbsent` variant; the idempotency guarantee is
  // load-bearing for skip-reason recording. v2.1.15 keeps this site as a
  // documented exception; see W3 completion brief.
  'bin/record-pattern-skip.js':
    'idempotent advisory event (writeEventIfAbsent variant pending; see W3 brief)',
};

const SCAN_DIRS = ['bin', 'hooks'];

function listJsFiles(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        out.push(p);
      }
    }
  }
  walk(dir);
  return out;
}

function fileImportsGateway(text) {
  // Either `require('./audit-event-writer')`, `require('../_lib/audit-event-writer')`, etc.
  return /require\(['"][^'"]*audit-event-writer['"]\)/.test(text);
}

function findEventsJsonlEmitSites(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/atomicAppendJsonl(?:IfAbsent)?\s*\(/.test(line)) continue;
    // Look at this line and the next 4 lines (for multi-line calls) to find
    // an events.jsonl reference.
    const window = lines.slice(i, i + 5).join(' ');
    if (/events\.jsonl/.test(window)) {
      hits.push({ line: i + 1, snippet: line.trim() });
    }
  }
  return hits;
}

function main() {
  const bypasses = [];
  let scanned = 0;

  for (const subdir of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, subdir);
    if (!fs.existsSync(abs)) continue;
    for (const file of listJsFiles(abs)) {
      scanned++;
      const rel  = path.relative(REPO_ROOT, file);
      const text = fs.readFileSync(file, 'utf8');
      const hits = findEventsJsonlEmitSites(text);
      if (hits.length === 0) continue;

      // File has at least one events.jsonl emit site. It must either import
      // the gateway, or be on the documented exception list.
      if (rel in EXCEPTIONS) continue;
      if (fileImportsGateway(text)) continue;

      // Bypass: a direct emit site that does not route through the gateway.
      for (const h of hits) {
        bypasses.push({ file: rel, line: h.line, snippet: h.snippet });
      }
    }
  }

  if (bypasses.length === 0) {
    process.stdout.write(
      '✓ All events.jsonl emit sites route through audit-event-writer (' +
      Object.keys(EXCEPTIONS).length + ' documented exceptions; ' +
      scanned + ' files scanned)\n',
    );
    process.exit(0);
  }

  process.stderr.write(
    '✗ R-SHDW-EMIT bypass sites found (' + bypasses.length + '):\n',
  );
  for (const b of bypasses) {
    process.stderr.write('  - ' + b.file + ':' + b.line + '  ' + b.snippet + '\n');
  }
  process.stderr.write(
    '\nFix: import `audit-event-writer.js` and call writeEvent(...) instead\n' +
    'of atomicAppendJsonl directly. If the site is a documented exception, add\n' +
    'it to EXCEPTIONS in bin/_tools/audit-emit-sites.js with a clear reason.\n',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = { main, EXCEPTIONS };
