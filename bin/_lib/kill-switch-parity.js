'use strict';

/**
 * kill-switch-parity.js — documented-vs-implemented parity for ORCHESTRAY_* env
 * kill switches (v2.3.21).
 *
 * Agent-facing prose in `agents/**` documents ~117 `ORCHESTRAY_*` switches as the
 * escape hatch for hooks and gates. Several were documented but never read by any
 * code: an operator who set `ORCHESTRAY_NON_PM_AGENT_BLOCK_DISABLED=1` against a
 * hard-blocking gate saw nothing change and concluded the gate was broken.
 *
 * Naive greps cannot answer this. A switch is legitimately read in three forms:
 *   1. injected env param     — `env.ORCHESTRAY_HAIKU_ROUTING_DISABLED`
 *   2. constructed name       — `'ORCHESTRAY_T15_' + ROLE + '_HARD_DISABLED'`
 *                               or `` `ORCHESTRAY_T15_${ROLE}_HARD_DISABLED` ``
 *   3. constant indirection   — `const E = 'ORCHESTRAY_X'` then `process.env[E]`
 * All three are resolved here. Documentation likewise uses placeholder *families*
 * (`ORCHESTRAY_T15_<ROLE>_HARD_DISABLED`), which are matched against constructed
 * reads rather than compared as literal names.
 *
 * Consumed by bin/_lib/__tests__/kill-switch-parity.test.js.
 */

const fs   = require('node:fs');
const path = require('node:path');

// A switch name, optionally carrying `<PLACEHOLDER>` / `${expr}` segments.
const TOKEN_RE =
  /ORCHESTRAY_[A-Z0-9_]*(?:<[A-Za-z0-9_]+>|\$\{[^}\n]{1,60}\})[A-Z0-9_]*|ORCHESTRAY_[A-Z0-9_]+/g;

const DOC_ROOT     = 'agents';
// A read in `bin/` is a runtime implementation; `tests/` counts only for switches
// whose entire purpose is to gate a test (see ORCHESTRAY_RELEASE_SHAPE_TEST_ENABLED).
const RUNTIME_ROOTS = ['bin'];
const AUX_ROOTS     = ['tests'];
// Test files name switches in assertion strings. Counting those as reads lets a
// test that asserts a switch is missing mark it as present — so they never count.
const TEST_DIR_RE   = /(^|[\\/])__tests__([\\/]|$)/;

/**
 * Switches that are documented but intentionally have no code read. Every entry
 * needs a reason. The test asserts each exemption is still documented somewhere,
 * so a stale exemption fails rather than rotting silently.
 */
const EXEMPT = {
  ORCHESTRAY_BLOCK_B_END: {
    reason: 'Block marker in an HTML comment, not an env gate — agents/pm-reference/' +
      'block-a-contract.md states so explicitly.',
  },
  ORCHESTRAY_OX_FALLBACK: {
    reason: 'Operator annotation, not a gate: ox-protocol.md §6 asks the operator to set ' +
      'it to record that the node-path fallback is in use. Nothing branches on it. ' +
      'Recommend rewording that line to say so; ox-protocol.md is out of this task scope.',
  },

  // v2.2.15 P1-06/07/09/10 documented four gates — kill switch, exit code, event
  // shape and an "Emitted from: bin/validate-*.js" path each. None of those
  // scripts exist and nothing emits the events; only the allowlist entries in
  // validate-task-completion.js landed. A switch cannot escape a gate that never
  // fires, so these are held rather than implemented — and `unless_emitted`
  // expires the hold the moment the gate itself ships.
  ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED: {
    reason: 'Gate unimplemented: bin/validate-tester-runs-tests.js does not exist.',
    unless_emitted: 'tester_runs_tests_gate_blocked',
  },
  ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED: {
    reason: 'Gate unimplemented: bin/validate-pattern-application.js does not exist.',
    unless_emitted: 'pattern_application_gate_blocked',
  },
  ORCHESTRAY_RESEARCHER_CITATIONS_GATE_DISABLED: {
    reason: 'Gate unimplemented: bin/validate-researcher-citations.js does not exist.',
    unless_emitted: 'researcher_citations_gate_blocked',
  },
  ORCHESTRAY_PLATFORM_ORACLE_GROUNDING_GATE_DISABLED: {
    reason: 'Gate unimplemented: bin/validate-platform-oracle-grounding.js does not exist.',
    unless_emitted: 'platform_oracle_grounding_gate_blocked',
  },
};

/**
 * True when some non-test file under bin/ emits `eventType`, which retires an
 * `unless_emitted` exemption: the gate now exists, so its switch must too.
 */
function gateIsLive(root, eventType) {
  const needle = "'" + eventType + "'";
  for (const file of walk(path.join(root, 'bin'), '.js')) {
    const rel = path.relative(root, file);
    if (TEST_DIR_RE.test(rel)) continue;
    const src = stripCommentLines(fs.readFileSync(file, 'utf8'));
    // The allowlist in validate-task-completion.js names these types without
    // emitting them; only a `type:` field assignment counts as an emit.
    if (new RegExp('type:\\s*' + needle).test(src)) return true;
  }
  return false;
}

/** Escape a literal for embedding in a RegExp. */
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** True when a name carries a `<X>` or `${x}` placeholder segment. */
function isFamily(name) { return /<[A-Za-z0-9_]+>|\$\{/.test(name); }

/**
 * Split a placeholder-bearing name into its literal prefix and suffix.
 * `ORCHESTRAY_T15_<ROLE>_HARD_DISABLED` → {prefix: 'ORCHESTRAY_T15_', suffix: '_HARD_DISABLED'}
 * @returns {{prefix: string, suffix: string}|null}
 */
function splitFamily(name) {
  const m = name.match(/^(.*?)(?:<[A-Za-z0-9_]+>|\$\{[^}]*\})(.*)$/);
  if (!m) return null;
  // Collapse any further placeholders in the tail — only the outer shape matters.
  const suffix = m[2].replace(/<[A-Za-z0-9_]+>|\$\{[^}]*\}/g, '');
  return { prefix: m[1], suffix };
}

/** Recursively collect files under `dir` matching `ext`. */
function walk(dir, ext, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, ext, out);
    } else if (e.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract switches documented in `agents/**`.
 *
 * A token counts only in env-usage form — `NAME=…`, `env.NAME`, or a line that
 * calls itself a kill switch. A bare prose mention is not a documented switch.
 *
 * @param {string} root - project root
 * @returns {Map<string, Array<{file: string, line: number}>>}
 */
function extractDocumentedSwitches(root) {
  const found = new Map();
  for (const file of walk(path.join(root, DOC_ROOT), '.md')) {
    const rel   = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const tokens = line.match(TOKEN_RE);
      if (!tokens) return;
      for (const token of new Set(tokens)) {
        const t = esc(token);
        // Prose describing a switch that was removed does not document a live
        // one — see the v2.2.14 G-04 retirement narrative in event-schemas.md.
        if (/retired|deprecated|no longer|were deleted|removed/i.test(line)) continue;
        const usage =
          new RegExp(t + '\\s*=').test(line) ||
          new RegExp('env\\s*[.\\[][\'"`]?' + t).test(line) ||
          (/kill\s*switch/i.test(line) && new RegExp('`' + t).test(line));
        if (!usage) continue;
        if (!found.has(token)) found.set(token, []);
        found.get(token).push({ file: rel, line: i + 1 });
      }
    });
  }
  return found;
}

/** Drop comment-only lines so a prose mention inside JSDoc is not read as an implementation. */
function stripCommentLines(src) {
  return src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/**
 * Scan code for switch reads, resolving all three read forms.
 *
 * @param {string} root  - project root
 * @param {string[]} dirs - directories to scan, relative to root
 * @param {{strict?: boolean}} [opts] - strict counts only `env.NAME` accesses, not
 *   bare string literals; used for test-scoped switches, where a quoted name is
 *   far more likely to be assertion copy than a read.
 * @returns {{literals: Map<string, string[]>, pairs: Array<{prefix: string, suffix: string, file: string}>}}
 */
function extractCodeReads(root, dirs, opts = {}) {
  const literals = new Map();   // concrete name -> files
  const pairs    = [];          // constructed-name prefix/suffix shapes

  const addLiteral = (name, rel) => {
    if (!literals.has(name)) literals.set(name, []);
    if (!literals.get(name).includes(rel)) literals.get(name).push(rel);
  };

  const readRe = opts.strict
    ? /env\s*[.[]\s*['"`]?(ORCHESTRAY_[A-Z0-9_]+)/g
    : /(?:env\s*\.\s*(ORCHESTRAY_[A-Z0-9_]+))|(?:['"`](ORCHESTRAY_[A-Z0-9_]+)['"`])/g;

  for (const dir of dirs) {
    for (const file of walk(path.join(root, dir), '.js')) {
      const rel = path.relative(root, file);
      if (TEST_DIR_RE.test(rel)) continue;
      const src = stripCommentLines(fs.readFileSync(file, 'utf8'));

      // Form 1 + 3: `env.NAME`, `env['NAME']`, or any quoted 'NAME' literal
      // (which is how constant indirection stores the name).
      for (const m of src.matchAll(readRe)) {
        addLiteral(m[1] || m[2], rel);
      }

      // Form 2a: template literal — `ORCHESTRAY_T15_${role}_HARD_DISABLED`
      for (const m of src.matchAll(/`(ORCHESTRAY_[A-Z0-9_]*)\$\{[^}]*\}([A-Z0-9_]*)`/g)) {
        pairs.push({ prefix: m[1], suffix: m[2], file: rel });
      }

      // Form 2b: concatenation — 'ORCHESTRAY_T15_' + expr + '_HARD_DISABLED'.
      // The suffix is the last quoted _UPPER literal on the statement, so the
      // interior `'_'` of a .replace(/-/g, '_') call is not mistaken for it.
      for (const line of src.split('\n')) {
        const head = line.match(/['"`](ORCHESTRAY_[A-Z0-9_]*)['"`]\s*\+/);
        if (!head) continue;
        const tail = [...line.matchAll(/['"`](_[A-Z0-9_]{2,})['"`]/g)].pop();
        if (tail) pairs.push({ prefix: head[1], suffix: tail[1], file: rel });
      }
    }
  }
  return { literals, pairs };
}

/**
 * Decide whether a documented switch has a code read.
 * @returns {{implemented: boolean, via: string|null, files: string[]}}
 */
function resolveSwitch(name, reads) {
  if (isFamily(name)) {
    const fam = splitFamily(name);
    if (!fam) return { implemented: false, via: null, files: [] };
    const hit = reads.pairs.find((p) => p.prefix === fam.prefix && p.suffix === fam.suffix);
    if (hit) return { implemented: true, via: 'constructed', files: [hit.file] };
    // A family is also satisfied by concrete literals matching its shape.
    const re  = new RegExp('^' + esc(fam.prefix) + '[A-Z0-9_]+' + esc(fam.suffix) + '$');
    const lit = [...reads.literals.keys()].filter((k) => re.test(k));
    if (lit.length) return { implemented: true, via: 'literal-family', files: reads.literals.get(lit[0]) };
    return { implemented: false, via: null, files: [] };
  }

  if (reads.literals.has(name)) {
    return { implemented: true, via: 'literal', files: reads.literals.get(name) };
  }
  const hit = reads.pairs.find(
    (p) => name.startsWith(p.prefix) && name.endsWith(p.suffix) &&
           name.length > p.prefix.length + p.suffix.length
  );
  if (hit) return { implemented: true, via: 'constructed', files: [hit.file] };
  return { implemented: false, via: null, files: [] };
}

/**
 * Run the full parity check.
 *
 * @param {string} [root] - project root (defaults to the repo containing this file)
 * @returns {{documented: object[], unimplemented: object[], exempt: object[]}}
 */
function checkParity(root = path.resolve(__dirname, '..', '..')) {
  const documented   = extractDocumentedSwitches(root);
  const runtime      = extractCodeReads(root, RUNTIME_ROOTS);
  const aux          = extractCodeReads(root, AUX_ROOTS, { strict: true });

  const rows = [];
  for (const [name, sites] of [...documented.entries()].sort()) {
    const r = resolveSwitch(name, runtime);
    const a = r.implemented ? null : resolveSwitch(name, aux);
    const ex = Object.hasOwn(EXEMPT, name) ? EXEMPT[name] : null;
    // A conditional exemption lapses once its gate starts emitting.
    const exemptReason =
      ex && (!ex.unless_emitted || !gateIsLive(root, ex.unless_emitted)) ? ex.reason : null;
    rows.push({
      name,
      documented_at: sites,
      implemented: r.implemented || Boolean(a && a.implemented),
      scope: r.implemented ? 'runtime' : (a && a.implemented ? 'aux' : null),
      via: r.via || (a && a.via) || null,
      read_in: r.implemented ? r.files : (a && a.implemented ? a.files : []),
      exempt: exemptReason,
    });
  }

  return {
    documented: rows,
    unimplemented: rows.filter((r) => !r.implemented && !r.exempt),
    exempt: rows.filter((r) => Boolean(r.exempt)),
  };
}

module.exports = {
  EXEMPT,
  checkParity,
  extractDocumentedSwitches,
  extractCodeReads,
  resolveSwitch,
  splitFamily,
  isFamily,
};
