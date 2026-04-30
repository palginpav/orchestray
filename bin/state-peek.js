#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * bin/state-peek.js — read-only snapshot of Orchestray runtime state.
 *
 * Invoked by skills/orchestray:state/SKILL.md (peek subcommand).
 * Accepts an optional first argument: the project root (defaults to cwd).
 *
 * Output: human-readable markdown report on stdout.
 * Exit: 0 always (fail-open).
 *
 * No file writes. No git operations. No network calls.
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const ORCH_DIR = path.join(BASE, '.orchestray');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function statSafe(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}

/**
 * Parse a YAML-ish frontmatter block (lines between --- markers).
 * Returns a flat object of key: value pairs (string values only).
 * Only used for simple single-line values; does not handle multiline or arrays.
 */
function parseFrontmatter(text) {
  const result = {};
  if (!text) return result;
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return result;
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Parse events.jsonl and return all parsed event objects.
 */
function readEvents(eventsPath) {
  const content = readFileSafe(eventsPath);
  if (!content) return [];
  return content
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

/**
 * Determine if a history directory is a "leaked" orchestration.
 * Leaked = has no orchestration_complete event AND was created more than 24h ago.
 */
function isLeaked(histDir) {
  const eventsPath = path.join(histDir, 'events.jsonl');
  const events = readEvents(eventsPath);

  const hasComplete = events.some(e => e.type === 'orchestration_complete');
  if (hasComplete) return false;

  // Check age: use the directory's mtime as a proxy for creation time.
  // If the directory itself is less than 24h old, it may still be active.
  const st = statSafe(histDir);
  if (!st) return false;
  const ageMs = Date.now() - st.mtimeMs;
  const twentyFourHours = 24 * 60 * 60 * 1000;
  return ageMs > twentyFourHours;
}

// ---------------------------------------------------------------------------
// Main report
// ---------------------------------------------------------------------------

function main() {
  const lines = [];

  lines.push('## Orchestray State — `peek`');
  lines.push('');

  if (!exists(ORCH_DIR)) {
    lines.push('`.orchestray/` directory not found. Orchestray has not been used in this project.');
    lines.push('');
    lines.push('Use `/orchestray:run [task]` to start your first orchestration.');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  // -------------------------------------------------------------------------
  // Section 1: Active orchestration (orchestration.md)
  // -------------------------------------------------------------------------
  lines.push('### Active Orchestration');
  lines.push('');

  const orchMdPath = path.join(ORCH_DIR, 'state', 'orchestration.md');
  const orchMdContent = readFileSafe(orchMdPath);
  if (orchMdContent) {
    const fm = parseFrontmatter(orchMdContent);
    const id = fm.id || fm.orchestration_id || '(unknown)';
    const task = fm.task || '(no task)';
    const started = fm.started_at || fm.created_at || '(unknown)';
    const status = fm.status || '(unknown)';

    lines.push(`**Orchestration ID:** \`${id}\``);
    lines.push(`**Task:** ${task}`);
    lines.push(`**Started:** ${started}`);
    lines.push(`**Status:** ${status}`);
    lines.push('');

    // Include the W-item status table verbatim (everything after the frontmatter)
    const afterFrontmatter = orchMdContent.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    if (afterFrontmatter) {
      lines.push('**Detail:**');
      lines.push('');
      lines.push(afterFrontmatter);
      lines.push('');
    }
  } else {
    lines.push('No active `state/orchestration.md` found.');
    lines.push('');
  }

  // -------------------------------------------------------------------------
  // Section 2: Current orchestration audit record
  // -------------------------------------------------------------------------
  const currentOrchPath = path.join(ORCH_DIR, 'audit', 'current-orchestration.json');
  const currentOrchContent = readFileSafe(currentOrchPath);
  if (currentOrchContent) {
    lines.push('### Audit Record (`audit/current-orchestration.json`)');
    lines.push('');
    try {
      const obj = JSON.parse(currentOrchContent);
      lines.push(`**Orchestration ID:** \`${obj.orchestration_id || '(unknown)'}\``);
      if (obj.started_at) lines.push(`**Started:** ${obj.started_at}`);
    } catch (_) {
      lines.push('(Could not parse `current-orchestration.json`)');
    }
    lines.push('');
  }

  // -------------------------------------------------------------------------
  // Section 3: Task files
  // -------------------------------------------------------------------------
  const tasksDir = path.join(ORCH_DIR, 'state', 'tasks');
  if (exists(tasksDir)) {
    lines.push('### Tasks (`state/tasks/`)');
    lines.push('');
    let taskFiles = [];
    try {
      taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
    } catch (_) {}
    if (taskFiles.length === 0) {
      lines.push('No task files found.');
    } else {
      lines.push(`${taskFiles.length} task file(s):`);
      lines.push('');
      for (const tf of taskFiles.sort()) {
        lines.push(`- \`${tf}\``);
      }
    }
    lines.push('');
  }

  // -------------------------------------------------------------------------
  // Section 4: History — leaked orchestrations
  // -------------------------------------------------------------------------
  lines.push('### History — Leaked Orchestrations');
  lines.push('');

  const histDir = path.join(ORCH_DIR, 'history');
  let leaked = [];
  let nonLeaked = [];

  if (exists(histDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(histDir).filter(e => {
        const full = path.join(histDir, e);
        try { return fs.statSync(full).isDirectory(); } catch (_) { return false; }
      });
    } catch (_) {}

    for (const entry of entries.sort()) {
      // Only consider directories that look like orchestration directories
      if (!entry.startsWith('orch-')) continue;
      const full = path.join(histDir, entry);
      if (isLeaked(full)) {
        leaked.push(entry);
      } else {
        nonLeaked.push(entry);
      }
    }
  }

  if (leaked.length === 0 && nonLeaked.length === 0) {
    lines.push('No history entries found.');
  } else {
    if (leaked.length > 0) {
      lines.push(`**${leaked.length} leaked** (no \`orchestration_complete\` event, older than 24h — candidates for \`state gc\`):`);
      lines.push('');
      for (const e of leaked) {
        lines.push(`- \`${e}\` ⚠ leaked`);
      }
      lines.push('');
    }
    if (nonLeaked.length > 0) {
      lines.push(`**${nonLeaked.length} clean** (completed or recent):`);
      lines.push('');
      for (const e of nonLeaked) {
        lines.push(`- \`${e}\``);
      }
      lines.push('');
    }
  }

  // -------------------------------------------------------------------------
  // Legend
  // -------------------------------------------------------------------------
  lines.push('---');
  lines.push('');
  lines.push('Use `/orchestray:state gc` to archive or discard leaked state (coming in v2.0.18 W5).');
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
}

main();
