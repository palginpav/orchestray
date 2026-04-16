#!/usr/bin/env node
'use strict';

// 2018-W8-UX3
/**
 * Re-run a W-item in the currently active orchestration.
 *
 * Reads .orchestray/state/task-graph.md to compute the transitive closure of
 * downstream dependents (if --cascade). Prompts the user for a single y/N
 * confirmation (OQ-TA-2: batch-confirm, not interactive per-item). On y,
 * writes .orchestray/state/redo.pending and emits w_item_redo_requested
 * audit events. The PM reads redo.pending on its next tick and respawns listed
 * W-items in order.
 *
 * Usage:
 *   node bin/redo-wave-item.js <W-id> [--prompt=<file>] [--cascade] [--dry-run] [projectDir]
 *
 *   W-id       - e.g. W4, W12. Required first positional argument.
 *   projectDir - Absolute path to project root. Default: process.cwd().
 *                Must be the last positional argument or omitted.
 *   --prompt=<file>  - Path to file containing the prompt override text.
 *   --cascade        - Also re-run transitive downstream dependents.
 *   --dry-run        - Print what WOULD happen; write no files, emit no events.
 *
 * Exit codes:
 *   0 — success or user-declined
 *   1 — no active orchestration / unknown W-id
 *   2 — cascade depth limit exceeded (partial — exits after warning)
 *
 * Design contract: 2018-UX3 (W8). OQ-TA-2 locked: batch-confirm.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

let wId = null;
let promptFile = null;
let cascade = false;
let dryRun = false;
let projectDir = null;

for (const arg of rawArgs) {
  if (arg === '--cascade') {
    cascade = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg.startsWith('--prompt=')) {
    promptFile = arg.slice('--prompt='.length);
  } else if (!arg.startsWith('--')) {
    // Positional: first is W-id, last is projectDir
    if (wId === null) {
      wId = arg;
    } else {
      // Could be projectDir (last positional)
      projectDir = arg;
    }
  }
}

if (projectDir === null) projectDir = process.cwd();

// ---------------------------------------------------------------------------
// Load config (max_cascade_depth, commit_prefix)
// ---------------------------------------------------------------------------

let redoConfig;
try {
  const { loadRedoFlowConfig } = require('./_lib/config-schema');
  redoConfig = loadRedoFlowConfig(projectDir);
} catch (_) {
  redoConfig = { max_cascade_depth: 10, commit_prefix: 'redo' };
}

const MAX_CASCADE_DEPTH = redoConfig.max_cascade_depth;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const stateDir = path.join(projectDir, '.orchestray', 'state');
const taskGraphPath = path.join(stateDir, 'task-graph.md');
const tasksDir = path.join(stateDir, 'tasks');
const redoPendingPath = path.join(stateDir, 'redo.pending');
const auditEventsPath = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

if (!wId) {
  process.stderr.write('Usage: redo-wave-item.js <W-id> [--prompt=<file>] [--cascade] [--dry-run] [projectDir]\n');
  process.exit(1);
}

function noActiveOrchestration() {
  process.stderr.write(
    '/orchestray:redo only works on the currently active orchestration.\n' +
    'Completed orchestrations are immutable (archived in .orchestray/history/).\n'
  );
  process.exit(1);
}

// Check .orchestray/state/ exists
if (!fs.existsSync(stateDir)) {
  noActiveOrchestration();
}

// Check either task-graph or the specific task file exists
const taskFilePath = findTaskFile(tasksDir, wId);
const hasTaskGraph = fs.existsSync(taskGraphPath);

if (!hasTaskGraph && !taskFilePath) {
  noActiveOrchestration();
}

// ---------------------------------------------------------------------------
// Task-graph parsing
// ---------------------------------------------------------------------------

/**
 * Parse the task-graph.md file and extract dependency edges.
 *
 * Recognises lines of the form:
 *   - W5 depends on W4
 *   - T3 depends on T2
 * Returns a Map<string, string[]> where key is a W-id and value is its
 * list of direct dependents (i.e. reverse edges: who blocks whom).
 *
 * @param {string} graphText
 * @returns {{ dependents: Map<string, string[]>, allIds: Set<string> }}
 */
function parseTaskGraph(graphText) {
  // dependents[A] = [B, C] means B and C depend on A (A blocks B and C)
  const dependents = new Map();
  const allIds = new Set();

  const depLineRe = /^[-*]\s+(\w+)\s+depends\s+on\s+(\w+)/i;

  for (const line of graphText.split('\n')) {
    const m = line.match(depLineRe);
    if (m) {
      const child = m[1];  // the item that depends on parent
      const parent = m[2]; // the item being depended on

      allIds.add(child);
      allIds.add(parent);

      if (!dependents.has(parent)) dependents.set(parent, []);
      dependents.get(parent).push(child);
    }

    // Also collect W-ids from task headings like "### W4 — ..." or "| W4 |"
    const wIdRe = /\b(W\d+)\b/g;
    let match;
    while ((match = wIdRe.exec(line)) !== null) {
      allIds.add(match[1]);
    }
  }

  return { dependents, allIds };
}

/**
 * Compute the transitive closure of all W-items reachable from startId
 * following dependent edges (i.e. items that depend on startId, directly
 * or indirectly). Returns items in topological order (BFS level order),
 * starting with startId itself.
 *
 * @param {string} startId
 * @param {Map<string, string[]>} dependents
 * @param {number} maxDepth
 * @returns {{ closure: string[], truncated: boolean }}
 */
function computeClosure(startId, dependents, maxDepth) {
  const visited = new Set([startId]);
  const queue = [[startId, 0]];
  const order = [startId];
  let truncated = false;

  while (queue.length > 0) {
    const [current, depth] = queue.shift();
    if (depth >= maxDepth) {
      truncated = true;
      continue;
    }
    const children = dependents.get(current) || [];
    for (const child of children) {
      if (!visited.has(child)) {
        visited.add(child);
        order.push(child);
        queue.push([child, depth + 1]);
      }
    }
  }

  return { closure: order, truncated };
}

// ---------------------------------------------------------------------------
// Task file lookup
// ---------------------------------------------------------------------------

/**
 * Find a task file for a given W-id. Checks .orchestray/state/tasks/ for files
 * matching the pattern `*<wId>*` or `<wId>.md`. Returns the path or null.
 * @param {string} dir
 * @param {string} id
 * @returns {string|null}
 */
function findTaskFile(dir, id) {
  if (!fs.existsSync(dir)) return null;
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      // Match by W-id in the filename (e.g. "W4.md", "01-W4-something.md")
      if (f.toLowerCase().includes(id.toLowerCase())) {
        return path.join(dir, f);
      }
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Audit event helper
// ---------------------------------------------------------------------------

/**
 * Append a w_item_redo_requested event to events.jsonl.
 * Best-effort; fail-open.
 * @param {string} itemId
 * @param {string|null} overridePromptFile
 */
function emitRedoEvent(itemId, overridePromptFile) {
  const event = {
    type: 'w_item_redo_requested',
    timestamp: new Date().toISOString(),
    w_id: itemId,
    prompt_override_file: overridePromptFile || null,
    cascade,
    dry_run: dryRun,
  };
  try {
    fs.mkdirSync(path.dirname(auditEventsPath), { recursive: true });
    fs.appendFileSync(auditEventsPath, JSON.stringify(event) + '\n');
  } catch (_e) {
    // Fail-open: audit write errors must not block the redo
  }
}

// ---------------------------------------------------------------------------
// Confirmation prompt helper
// ---------------------------------------------------------------------------

/**
 * Ask the user a yes/no question on stdin/stdout.
 * Returns a Promise<boolean> resolving to true for 'y'/'Y'.
 * On non-tty (tests), reads one line and resolves.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    process.stdout.write(question);
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line.trim().toLowerCase() === 'y');
    });
    rl.once('close', () => {
      if (!answered) resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load task graph
  let graphText = '';
  if (hasTaskGraph) {
    graphText = fs.readFileSync(taskGraphPath, 'utf8');
  }

  const { dependents, allIds } = parseTaskGraph(graphText);

  // Validate W-id is known (either in graph or has a task file)
  const taskFile = taskFilePath || findTaskFile(tasksDir, wId);
  if (!allIds.has(wId) && !taskFile) {
    process.stderr.write(
      'Unknown W-id "' + wId + '". Not found in task-graph.md or tasks/ directory.\n' +
      '/orchestray:redo only works on the currently active orchestration.\n' +
      'Completed orchestrations are immutable (archived in .orchestray/history/).\n'
    );
    process.exit(1);
  }

  // Compute closure
  let closure;
  let truncated = false;

  if (cascade) {
    const result = computeClosure(wId, dependents, MAX_CASCADE_DEPTH);
    closure = result.closure;
    truncated = result.truncated;
  } else {
    closure = [wId];
  }

  // Build display list (excluding the head item for the "and N dependent(s)" label)
  const dependentList = closure.slice(1);

  // --dry-run: just print and exit
  if (dryRun) {
    if (cascade && dependentList.length > 0) {
      process.stdout.write(
        'DRY RUN: Would redo ' + wId + ' and re-run ' + dependentList.length +
        ' dependent(s) [' + dependentList.join(', ') + '] in dependency order.\n'
      );
      if (truncated) {
        process.stdout.write(
          'Warning: cascade depth capped at ' + MAX_CASCADE_DEPTH +
          '. Some downstream dependents may not be included.\n'
        );
      }
    } else {
      process.stdout.write('DRY RUN: Would redo ' + wId + ' only.\n');
    }
    if (promptFile) {
      process.stdout.write('DRY RUN: Would use prompt override from: ' + promptFile + '\n');
    }
    process.stdout.write('DRY RUN: No files written, no events emitted.\n');
    process.exit(0);
  }

  // Show cascade warning if truncated
  if (truncated) {
    process.stdout.write(
      'Warning: cascade depth capped at ' + MAX_CASCADE_DEPTH +
      '. Some downstream dependents are not included in the redo list.\n'
    );
  }

  // Prompt for confirmation (OQ-TA-2: batch-confirm once)
  let question;
  if (cascade && dependentList.length > 0) {
    question =
      'Redo ' + wId + ' and re-run ' + dependentList.length +
      ' dependent(s) [' + dependentList.join(', ') + ']? [y/N] ';
  } else {
    question = 'Redo ' + wId + ' only? [y/N] ';
  }

  const confirmed = await confirm(question);

  if (!confirmed) {
    process.stdout.write('Redo aborted.\n');
    process.exit(0);
  }

  // Build redo.pending payload
  const redoPending = {
    created_at: new Date().toISOString(),
    w_ids: closure,
    prompt_override_file: promptFile || null,
    cascade,
    commit_prefix: redoConfig.commit_prefix,
  };

  // Write redo.pending (atomic: write to tmp, rename)
  const tmpPath = redoPendingPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(redoPending, null, 2) + '\n');
    fs.renameSync(tmpPath, redoPendingPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    process.stderr.write('Failed to write redo.pending: ' + err.message + '\n');
    process.exit(1);
  }

  // Emit one audit event per W-id in the closure
  for (const id of closure) {
    emitRedoEvent(id, promptFile || null);
  }

  // Report
  if (cascade && dependentList.length > 0) {
    process.stdout.write(
      'Queued for redo: ' + closure.join(' → ') + '\n' +
      'The PM will respawn each W-item in dependency order.\n' +
      'Each re-run will produce a new commit prefixed "' + redoConfig.commit_prefix + '(<W-id>):".\n'
    );
  } else {
    process.stdout.write(
      'Queued for redo: ' + wId + '\n' +
      'The PM will respawn this W-item.\n' +
      'The re-run will produce a new commit prefixed "' + redoConfig.commit_prefix + '(' + wId + '):".\n'
    );
  }
}

main().catch((err) => {
  process.stderr.write('redo-wave-item: fatal error: ' + err.message + '\n');
  process.exit(1);
});
