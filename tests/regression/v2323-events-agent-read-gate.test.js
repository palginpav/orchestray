#!/usr/bin/env node
'use strict';

/**
 * v2.3.23 R-EVT-ROTATE regression test.
 *
 * .orchestray/audit/events.jsonl (the live audit log) is off-limits to agents
 * for query/aggregation via the Read/Glob tools -- mcp__orchestray__history_query_events
 * exists specifically to replace that pattern (bounded by limit/offset regardless
 * of file size). See .orchestray/kb/decisions/v2323-events-rotation-read-ceiling.md.
 *
 * Write-side references (e.g. "Log a `foo` event to `.orchestray/audit/events.jsonl`")
 * are legitimate and explicitly out of scope -- this only flags lines that pair the
 * live log path with a Read/Glob verb and are NOT a "do not" instruction. A naive
 * "the file must never mention the path" check produces false positives on the
 * write-side prose these agents still legitimately contain (verified against the
 * checked-in content, not assumed).
 *
 * Asserts:
 *   1. Neither watched agent prompt has a Read/Glob instruction targeting the live
 *      log path.
 *   2. Both watched agent prompts use history_query_events for the op that used
 *      to instruct a raw Read.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

// Scans EVERY agent prompt, not just the two fixed in v2.3.23. A guard limited to
// known violators only catches the case least likely to recur — the next violation
// lands in a new prompt. Discovered by mutation: injecting a raw read into an
// unwatched agent file passed the gate.
function discoverAgentPrompts(dir = 'agents', acc = []) {
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) discoverAgentPrompts(rel, acc);
    else if (entry.name.endsWith('.md') || entry.name.endsWith('.md.legacy')) acc.push(rel);
  }
  return acc;
}

const WATCHED_FILES = discoverAgentPrompts();
const LIVE_LOG_PATH = '.orchestray/audit/events.jsonl';

// A line is a violation if it references the live log path AND pairs it with a
// Read/Glob verb AND is not itself the negative ("do NOT Read/Glob ...") instruction.
function readOrGlobViolations(content) {
  return content.split('\n').filter((line) => {
    if (!line.includes(LIVE_LOG_PATH)) return false;
    if (!/\b(Read|Glob)\b/.test(line)) return false;
    if (/\bNOT\b/.test(line)) return false; // "Do NOT `Read`/`Glob` ... directly."
    return true;
  });
}

describe('R-EVT-ROTATE: agents never Read/Glob the live events log directly', () => {
  for (const f of WATCHED_FILES) {
    test(f + ' has no Read/Glob instruction targeting the live events.jsonl path', () => {
      const violations = readOrGlobViolations(readFile(f));
      assert.deepEqual(
        violations, [],
        f + ' must not instruct Read/Glob on the live audit log path; use ' +
        'history_query_events instead (see v2323-events-rotation-read-ceiling.md). ' +
        'Offending line(s): ' + JSON.stringify(violations)
      );
    });
  }

  // A bare `content.includes('history_query_events')` passes on any mention —
  // a comment, a changelog line, even a "do NOT use" warning. These assert the
  // call sits in the section that previously held the raw read.
  function sectionAround(content, anchor, span = 12) {
    const lines = content.split('\n');
    const i = lines.findIndex((l) => l.includes(anchor));
    return i < 0 ? null : lines.slice(i, i + span).join('\n');
  }

  test('agents/pm.md cost budget check calls history_query_events at the call site', () => {
    const section = sectionAround(readFile('agents/pm.md'), 'Cost budget check');
    assert.ok(section, 'cost budget check section not found in pm.md');
    assert.match(
      section, /mcp__orchestray__history_query_events/,
      'the cost-budget step must call history_query_events, not merely mention it'
    );
    assert.ok(
      readOrGlobViolations(section).length === 0,
      'the cost-budget step must not instruct a raw read of the live log'
    );
  });

  test('agents/orchestray-housekeeper.md rollup recompute calls history_query_events at the call site', () => {
    const section = sectionAround(readFile('agents/orchestray-housekeeper.md'), 'rollup');
    assert.ok(section, 'rollup section not found in orchestray-housekeeper.md');
    assert.match(
      section, /mcp__orchestray__history_query_events/,
      'the rollup step must call history_query_events, not merely mention it'
    );
    assert.ok(
      readOrGlobViolations(section).length === 0,
      'the rollup step must not instruct a raw read of the live log'
    );
  });

  test('agents/orchestray-housekeeper.md grants history_query_events in its tools frontmatter', () => {
    const content = readFile('agents/orchestray-housekeeper.md');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, 'orchestray-housekeeper.md must have YAML frontmatter');
    const toolsLine = fm[1].match(/^tools:\s*(.+)$/m);
    assert.ok(toolsLine, 'orchestray-housekeeper.md frontmatter must declare tools:');
    // Tolerates both `tools: a, b` and `tools: [a, b]` forms.
    const granted = toolsLine[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim());
    assert.ok(
      granted.includes('mcp__orchestray__history_query_events'),
      'tools: frontmatter must GRANT history_query_events (found: ' + granted.join(', ') +
      ') — instructing a call the agent cannot make is the defect this gate exists to prevent'
    );
  });
});
