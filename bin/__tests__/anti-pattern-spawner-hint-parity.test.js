'use strict';

// Every agent definition that can spawn other agents MUST tell its agent to pass
// `context_size_hint` on the spawn. bin/validate-context-size-hint.js hard-blocks
// spawns without it once the ramp threshold is exceeded, so a spawner whose prompt
// never mentions the field produces an agent that cannot spawn at all.
//
// This shipped live: agents/curate-runner.md had zero mentions of context_size_hint,
// so `Agent(curator)` was blocked with context_size_hint_gate_blocked and the curator
// was unreachable through its only sanctioned entry point (the PM is locked out of
// Agent(curator) by directive D1). Prose alone did not hold — hence this parity gate.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.resolve(__dirname, '..', '..', 'agents');
const REQUIRED_TOKEN = 'context_size_hint';

// A definition is a spawner if its frontmatter `tools:` line grants Agent (bare
// `Agent`, `Agent(x)`, or `*`).
function isSpawner(src) {
  const m = src.match(/^tools:\s*(.+)$/m);
  if (!m) return false;
  const tools = m[1];
  return /(^|[\s,])Agent(\(|[\s,]|$)/.test(tools) || /(^|[\s,])\*([\s,]|$)/.test(tools);
}

function agentFiles() {
  return fs.readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(AGENTS_DIR, f));
}

describe('anti-pattern: spawner agents must require context_size_hint', () => {
  test('every spawn-capable agent definition mentions context_size_hint', () => {
    const offenders = [];
    for (const file of agentFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!isSpawner(src)) continue;
      if (!src.includes(REQUIRED_TOKEN)) offenders.push(path.basename(file));
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `spawn-capable agent definition(s) never mention ${REQUIRED_TOKEN}: ${offenders.join(', ')}. `
        + 'validate-context-size-hint.js hard-blocks their spawns once the ramp threshold is '
        + 'exceeded, making the spawned agent unreachable.',
    );
  });

  test('the detector actually finds spawners (guard against a vacuous pass)', () => {
    // If isSpawner ever stops matching, the test above passes trivially over an
    // empty set. Assert we found the known spawners.
    const found = agentFiles()
      .filter((f) => isSpawner(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f))
      .sort();
    assert.ok(
      found.includes('pm.md') && found.includes('curate-runner.md'),
      `expected pm.md and curate-runner.md to be detected as spawners, got: ${found.join(', ')}`,
    );
  });

  test('isSpawner distinguishes granted Agent from unrelated tool names', () => {
    assert.ok(isSpawner('tools: Read, Agent, Bash\n'), 'bare Agent grant');
    assert.ok(isSpawner('tools: Read, Agent(curator)\n'), 'scoped Agent grant');
    assert.ok(isSpawner('tools: *\n'), 'wildcard grant');
    assert.ok(!isSpawner('tools: Read, Glob, Grep\n'), 'no Agent grant');
    assert.ok(!isSpawner('tools: Read, AgentMemory\n'), 'substring must not match');
    assert.ok(!isSpawner('description: spawns an Agent\n'), 'prose must not match');
  });
});
