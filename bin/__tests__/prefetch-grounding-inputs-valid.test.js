'use strict';

// Every DEFAULT_TOOL_INPUTS entry in bin/prefetch-mcp-grounding.js must validate against
// its tool's inputSchema. MCP tool schemas set additionalProperties:false, so an unknown
// key is rejected at call time — and the prefetch hook swallows that into the grounding
// text rather than failing loudly.
//
// This shipped live: routing_lookup was called with {limit:10}, a property it does not
// have. Every architect spawn's grounding block carried
// "routing_lookup: limit: unknown property (additionalProperties: false)" instead of
// routing history, and nothing surfaced it. Only visible by reading a grounding block
// closely — hence this gate.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PREFETCH = path.join(REPO_ROOT, 'bin', 'prefetch-mcp-grounding.js');
const TOOLS_DIR = path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools');

// Extract DEFAULT_TOOL_INPUTS without executing the hook (it has side effects on load).
function parseDefaults() {
  const src = fs.readFileSync(PREFETCH, 'utf8');
  const m = src.match(/const DEFAULT_TOOL_INPUTS = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'could not locate DEFAULT_TOOL_INPUTS in bin/prefetch-mcp-grounding.js');
  const out = {};
  // One entry per line: `  tool_name: { ...literal... },` — comment lines are skipped.
  for (const line of m[1].split('\n')) {
    const e = line.match(/^\s*([a-z_]+):\s*(\{.*\}),?\s*$/);
    if (!e) continue;
    // eslint-disable-next-line no-eval
    out[e[1]] = eval('(' + e[2] + ')');
  }
  return out;
}

function schemaFor(tool) {
  const file = path.join(TOOLS_DIR, tool + '.js');
  if (!fs.existsSync(file)) return null;
  const mod = require(file);
  return mod.inputSchema || mod.schema || (mod.definition && mod.definition.inputSchema) || null;
}

describe('prefetch grounding: default tool inputs match tool schemas', () => {
  test('parser finds the defaults (guard against a vacuous pass)', () => {
    const defaults = parseDefaults();
    assert.ok(
      Object.keys(defaults).length >= 4,
      `expected >=4 DEFAULT_TOOL_INPUTS entries, parsed ${Object.keys(defaults).length}. `
        + 'If the literal shape changed, update parseDefaults() — do not delete this test.',
    );
  });

  test('no default passes a property its tool schema does not declare', () => {
    const defaults = parseDefaults();
    const offenders = [];
    for (const [tool, input] of Object.entries(defaults)) {
      const schema = schemaFor(tool);
      if (!schema || !schema.properties) continue; // tool resolved elsewhere; not our gate
      const allowed = Object.keys(schema.properties);
      for (const key of Object.keys(input)) {
        if (!allowed.includes(key)) {
          offenders.push(`${tool}.${key} (allowed: ${allowed.join(', ')})`);
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'prefetch default(s) pass properties the tool schema rejects; grounding for these '
        + `tools silently degrades to an error string: ${offenders.join('; ')}`,
    );
  });

  test('required properties are supplied where the schema demands them', () => {
    const defaults = parseDefaults();
    const missing = [];
    for (const [tool, input] of Object.entries(defaults)) {
      const schema = schemaFor(tool);
      if (!schema || !Array.isArray(schema.required)) continue;
      for (const req of schema.required) {
        if (!(req in input)) missing.push(`${tool}.${req}`);
      }
    }
    assert.deepStrictEqual(missing, [], `prefetch default(s) omit required properties: ${missing.join(', ')}`);
  });
});
