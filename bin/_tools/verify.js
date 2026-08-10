#!/usr/bin/env node
'use strict';

/**
 * verify.js — correct-by-construction probes for the questions this codebase
 * keeps asking, so nobody re-derives a fragile ad-hoc grep (v2.3.25).
 *
 * ## Packaging: this file is deliberately NOT published to npm
 *
 * `package.json` excludes `bin/_tools/` and re-includes exactly one file,
 * `behavior-diff.js`. That exemption is not arbitrary — behavior-diff has
 * runtime callers (`bin/dark-event-banner.js`, `bin/install.js`), so the
 * package would break without it.
 *
 * The rule, stated so the next tool added here does not have to guess:
 * **`bin/_tools/` ships only when runtime code requires the file.** verify.js
 * has zero runtime callers and answers source-tree questions ("is this env
 * switch read?", "does this agent grant this tool?") that only someone working
 * on Orchestray asks. Those people clone from git, where this file already is.
 * Publishing it would add weight for an audience that cannot use it.
 *
 * ## Why this exists
 *
 * Over one long PM session, ~30 false findings ("X is dead", "Y is missing",
 * "Z is broken") were traced to a single root cause: an ad-hoc grep whose
 * pattern was too narrow for a legitimate form the codebase actually uses.
 * The catalogue (all real, all observed in this session):
 *
 *   1. `const env = process.env; env.NAME` (alias)               — see envSwitchIsRead
 *   2. `tools: [a, b]` YAML flow form                            — see agentGrantsTool
 *   3. digits in a var name (`ORCHESTRAY_T15_ACK_...`)           — see envSwitchIsRead
 *   4. `cold_init_async` (config) vs `opts.coldInitAsync` (code) — see configKeyIsReferenced
 *   5. `"event":` vs `"type":` in JSONL rows                     — see jsonlRowsWhere
 *   6. a docstring mention matching a call-site regex            — see callSitesMissingArg
 *   7. `getChunk(event_type, opts)` called with an object        — see callSitesMissingArg
 *   8. `head -1` on a file list (wrong file entirely)            — every walker below scans
 *                                                                    ALL matching files, never one
 *   9. `require('./relative/path')` resolved from the wrong cwd  — every function below takes an
 *                                                                    explicit `root` and never
 *                                                                    resolves against process.cwd()
 *                                                                    or `__dirname` implicitly
 *  10. set-size subtraction instead of membership                — see undeclaredEventTypes
 *
 * ## Design
 *
 * Every function returns EVIDENCE (file, line, matched form), not just a
 * boolean — a caller must be able to see *why*. Where a question cannot be
 * answered reliably by static analysis (an unparseable call site, a spread
 * argument, a truncated file), the function says so via `confident: false`
 * rather than guessing.
 *
 * Node stdlib only. Usable as a library (`require('./verify')`) or from the
 * CLI:
 *
 *   node bin/_tools/verify.js env <NAME> [--root DIR]
 *   node bin/_tools/verify.js tool <agentFile> <toolName>
 *   node bin/_tools/verify.js event <event_type> [--root DIR]
 *   node bin/_tools/verify.js undeclared <type1,type2,...> [--root DIR]
 *   node bin/_tools/verify.js callsites <fnName> <argName> [--root DIR]
 *   node bin/_tools/verify.js config <snake_case_key> [--root DIR]
 *   node bin/_tools/verify.js jsonl <file> <key> <value>
 *
 * Every subcommand prints JSON and exits 0. Exit 2 on a usage error.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', '.orchestray', '.claude'];

/**
 * Does `segments` (already split on '/') contain `fragSegments` as a
 * contiguous run, at any offset? Helper for isPathExcluded.
 *
 * @param {string[]} segments
 * @param {string[]} fragSegments
 * @returns {boolean}
 */
function containsSegmentRun(segments, fragSegments) {
  for (let start = 0; start <= segments.length - fragSegments.length; start++) {
    let ok = true;
    for (let i = 0; i < fragSegments.length; i++) {
      if (segments[start + i] !== fragSegments[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Does `relPath` (posix-separated, relative to the walk root) match any
 * entry in `exclude`?
 *
 * Found via dogfooding this tool: the original implementation matched
 * `exclude` entries against a directory's exact basename only (a `Set` of
 * `e.name`), so `exclude: ['tests/']` matched NOTHING — no directory is
 * literally named `"tests/"` — while `'__tests__'` happened to work only
 * because it has no trailing slash and no nested path.
 *
 * Chosen semantics: each fragment is split into path segments (leading/
 * trailing slashes stripped) and matched as a CONTIGUOUS RUN of segments
 * anywhere in `relPath`'s own segments — not a raw substring test. That
 * makes `'tests/'`, `'__tests__'`, and `'bin/_tools/'` all match regardless
 * of depth or position, while a bare `'tests'` fragment does NOT also match
 * an unrelated segment like `'contested'` or `'latest'` the way plain
 * substring matching on the joined path string would.
 *
 * @param {string} relPath
 * @param {string[]} exclude — raw fragments as supplied by the caller
 * @returns {boolean}
 */
function isPathExcluded(relPath, exclude) {
  if (!exclude || exclude.length === 0) return false;
  const segments = relPath.split('/').filter(Boolean);
  return exclude.some((raw) => {
    const fragSegments = String(raw).split('/').filter(Boolean);
    if (fragSegments.length === 0) return false;
    return containsSegmentRun(segments, fragSegments);
  });
}

/**
 * Recursively list files under `root` matching `exts` (extension allowlist,
 * e.g. `['.js']`), skipping anything whose root-relative path matches an
 * entry in `exclude` (see isPathExcluded for matching semantics). Matched
 * directories are pruned before descending, so an excluded subtree (e.g.
 * `node_modules`) is never walked.
 * Failure #8 defense: this walks the WHOLE subtree — every caller in this
 * file gets every matching file, never just the first one a naive `find |
 * head -1` would have picked.
 *
 * @param {string} root
 * @param {{exts?: string[], exclude?: string[]}} [opts]
 * @returns {string[]} absolute paths
 */
function walkFiles(root, opts) {
  const o = opts || {};
  const exts = o.exts || ['.js'];
  const exclude = DEFAULT_EXCLUDE_DIRS.concat(o.exclude || []);
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (isPathExcluded(rel, exclude)) continue;
      if (e.isDirectory()) walk(p);
      else if (exts.some((ext) => e.name.endsWith(ext))) out.push(p);
    }
  })(root);
  return out.sort();
}

/**
 * Blank out `//` line comments and `/* *\/` block comments (including JSDoc)
 * while preserving string/template literals and every newline (so line
 * numbers computed on the result still match the source). This is what
 * lets callSitesMissingArg and envSwitchIsRead ignore a docstring mention
 * (failure #6) without also eating a legitimate `'//not-a-comment'` string.
 *
 * Deliberately NOT a full JS parser — template-literal `${...}` interpolation
 * is treated as opaque string content, not re-entered code. That is a known,
 * documented scope limit, not a silent gap: nothing in this file claims to
 * handle code embedded in a template interpolation.
 *
 * @param {string} text
 * @returns {string} same length/line-count as `text`, comments blanked
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 'code'; // code | line-comment | block-comment | sq | dq | tpl
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line-comment'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block-comment'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line-comment') {
      if (c === '\n') { state = 'code'; out += c; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
      if (c === quote) { state = 'code'; out += c; i++; continue; }
      out += c; i++; continue;
    }
  }
  return out;
}

/**
 * Does `root` point to a real, readable directory? Guards every
 * walkFiles-based function against a silent fail-soft-*looking* bug:
 * walkFiles' own readdir try/catch swallows an unreadable root and just
 * returns `[]`, which the caller would otherwise report as a confident
 * "genuinely scanned, found nothing" — a fabricated negative indistinguishable
 * from a real one. Callers must check this BEFORE invoking walkFiles.
 *
 * @param {*} root
 * @returns {{ok: boolean, reason?: string}}
 */
function checkRootIsDir(root) {
  if (typeof root !== 'string' || !root) return { ok: false, reason: 'invalid_root' };
  let st;
  try { st = fs.statSync(root); } catch (_e) { return { ok: false, reason: 'root_unreadable' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'root_not_a_directory' };
  return { ok: true };
}

/** 1-based line number of a char offset. */
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const OPEN_TO_CLOSE = { '(': ')', '{': '}', '[': ']' };
const CLOSE_SET = new Set([')', '}', ']']);

/**
 * Given `text[openIdx]` is an opening bracket, find the index of its
 * matching close, tracking nested brackets of ALL kinds and skipping over
 * string/template literal contents (so a `)` or `,` inside a string never
 * confuses the balance count).
 *
 * @param {string} text
 * @param {number} openIdx
 * @returns {number} index of the matching close bracket, or -1 if unbalanced
 */
function findMatchingBracket(text, openIdx) {
  const stack = [text[openIdx]];
  let i = openIdx + 1;
  let strState = null; // "'" | '"' | '`' | null
  while (i < text.length) {
    const c = text[i];
    if (strState) {
      if (c === '\\') { i += 2; continue; }
      if (c === strState) strState = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { strState = c; i++; continue; }
    if (OPEN_TO_CLOSE[c]) { stack.push(c); i++; continue; }
    if (CLOSE_SET.has(c)) {
      const expected = OPEN_TO_CLOSE[stack[stack.length - 1]];
      if (c !== expected) return -1; // mismatched nesting
      stack.pop();
      if (stack.length === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Split `text` on top-level `,` only — commas nested inside `(...)`, `{...}`,
 * `[...]`, or a string/template literal do not split. Empty/whitespace-only
 * entries are dropped (trailing-comma safe).
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let strState = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (strState) {
      if (c === '\\') { i++; continue; }
      if (c === strState) strState = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { strState = c; continue; }
    if (OPEN_TO_CLOSE[c]) { depth++; continue; }
    if (CLOSE_SET.has(c)) { depth--; continue; }
    if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// 1. envSwitchIsRead — failure modes #1 (alias), #3 (digits), #6 (docstring)
// ---------------------------------------------------------------------------

/**
 * Is `process.env.<name>` actually consulted anywhere under `root`? Handles:
 *   - direct dot access:    process.env.NAME
 *   - direct bracket:       process.env['NAME'] / process.env["NAME"]
 *   - alias:                const env = process.env; ... env.NAME
 *   - constant indirection: const N = 'NAME'; ... process.env[N]
 * Comment-stripped first (stripComments), so a docstring mention of the
 * exact same text is never counted as a read (failure #6's shape).
 *
 * Regexes below match `name` as a literal (escaped), never reconstruct it
 * from a character class — that is what defeats failure #3 (names
 * containing digits, e.g. `ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED`,
 * silently dropped by discovery regexes built on `[A-Z_]+`).
 *
 * @param {string} name — exact env var name, e.g. 'ORCHESTRAY_FOO_DISABLED'
 * @param {{root?: string, exclude?: string[]}} [opts]
 * @returns {{name: string, read: boolean, confident: boolean, evidence: object[], checkedForms: string[]}}
 */
function envSwitchIsRead(name, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();
  if (typeof name !== 'string' || !name) {
    return { name: String(name || ''), read: false, confident: false, evidence: [], checkedForms: [], reason: 'invalid_name' };
  }
  const rootCheck = checkRootIsDir(root);
  if (!rootCheck.ok) {
    return { name, read: false, confident: false, evidence: [], checkedForms: [], reason: rootCheck.reason };
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directDot = new RegExp('process\\.env\\.' + escaped + '(?![A-Za-z0-9_$])', 'g');
  const directBracket = new RegExp('process\\.env\\[\\s*[\'"]' + escaped + '[\'"]\\s*\\]', 'g');
  const aliasDeclRe = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*process\.env\s*(?:;|,|\))/g;
  const indirectionDeclRe = new RegExp(
    "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*['\"]" + escaped + "['\"]", 'g'
  );

  const evidence = [];
  const files = walkFiles(root, o);
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { continue; }
    const text = stripComments(raw);
    const rel = path.relative(root, file);

    for (const m of text.matchAll(directDot)) {
      evidence.push({ file: rel, line: lineOf(text, m.index), form: 'direct-dot', snippet: m[0] });
    }
    for (const m of text.matchAll(directBracket)) {
      evidence.push({ file: rel, line: lineOf(text, m.index), form: 'direct-bracket', snippet: m[0] });
    }

    // Alias: `const X = process.env;` anywhere in the file, then `X.NAME` / X['NAME'] anywhere after.
    aliasDeclRe.lastIndex = 0;
    let am;
    while ((am = aliasDeclRe.exec(text)) !== null) {
      const alias = am[1];
      const aliasEsc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const useDot = new RegExp('\\b' + aliasEsc + '\\.' + escaped + '(?![A-Za-z0-9_$])', 'g');
      const useBracket = new RegExp('\\b' + aliasEsc + '\\[\\s*[\'"]' + escaped + '[\'"]\\s*\\]', 'g');
      for (const m of text.matchAll(useDot)) {
        evidence.push({ file: rel, line: lineOf(text, m.index), form: 'alias', snippet: alias + ' = process.env; ... ' + m[0] });
      }
      for (const m of text.matchAll(useBracket)) {
        evidence.push({ file: rel, line: lineOf(text, m.index), form: 'alias-bracket', snippet: alias + ' = process.env; ... ' + m[0] });
      }
    }

    // Constant indirection: `const N = 'NAME';` then `process.env[N]`.
    indirectionDeclRe.lastIndex = 0;
    let im;
    while ((im = indirectionDeclRe.exec(text)) !== null) {
      const constName = im[1];
      const constEsc = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const useRe = new RegExp('process\\.env\\[\\s*' + constEsc + '\\s*\\]', 'g');
      for (const m of text.matchAll(useRe)) {
        evidence.push({ file: rel, line: lineOf(text, m.index), form: 'indirection', snippet: constName + " = '" + name + "'; ... " + m[0] });
      }
    }
  }

  return {
    name,
    read: evidence.length > 0,
    confident: true,
    evidence,
    checkedForms: ['direct-dot', 'direct-bracket', 'alias', 'indirection'],
  };
}

// ---------------------------------------------------------------------------
// 2. agentGrantsTool — failure mode #2 (YAML flow form)
// ---------------------------------------------------------------------------

/**
 * Parse an agent definition's `tools:` frontmatter line, tolerant of both
 * the flat comma form (`tools: a, b`) and the YAML flow-sequence form
 * (`tools: [a, b]`, including the empty `tools: []`). A parser that splits
 * on commas without first stripping `[`/`]` mis-parses the flow form's first
 * and last entries (`[Read` / `Grep]`) and reports the agent as lacking a
 * tool it actually has — failure #2.
 *
 * @param {string} agentFile — absolute or relative path to an agents/*.md file
 * @param {string} toolName
 * @returns {{agentFile: string, toolName: string, granted: boolean,
 *            grantedList: string[], form: string|null, confident: boolean, reason?: string}}
 */
function agentGrantsTool(agentFile, toolName) {
  let raw;
  try { raw = fs.readFileSync(agentFile, 'utf8'); } catch (e) {
    return { agentFile, toolName, granted: false, grantedList: [], form: null, confident: false, reason: 'file_unreadable: ' + e.message };
  }
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    return { agentFile, toolName, granted: false, grantedList: [], form: null, confident: false, reason: 'no_frontmatter' };
  }
  const m = fm[1].match(/^tools:\s*(.*)$/m);
  if (!m) {
    return { agentFile, toolName, granted: false, grantedList: [], form: null, confident: false, reason: 'no_tools_line' };
  }
  const rawValue = m[1].trim();
  const isFlow = rawValue.startsWith('[');
  const grantedList = rawValue
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    agentFile,
    toolName,
    granted: grantedList.includes(toolName),
    grantedList,
    form: isFlow ? 'flow' : 'flat',
    confident: true,
  };
}

// ---------------------------------------------------------------------------
// 3. eventTypeIsDeclared — cross-checks event-schemas.md + both sidecars
// ---------------------------------------------------------------------------

const SCHEMA_MD_REL     = path.join('agents', 'pm-reference', 'event-schemas.md');
const SCHEMA_SHADOW_REL = path.join('agents', 'pm-reference', 'event-schemas.shadow.json');
const SCHEMA_TIER2_REL  = path.join('agents', 'pm-reference', 'event-schemas.tier2-index.json');

/**
 * Is `type` a declared event type? Checks all three sources of truth and
 * reports which ones agree — partial declaration (present in the .md source
 * but a stale/unregenerated sidecar) is a real, previously-invisible failure
 * mode here, not something a single-source check would ever surface.
 *
 * @param {string} type
 * @param {{root?: string}} [opts]
 * @returns {{type: string, declaredIn: {md: boolean, shadow: boolean, tier2: boolean},
 *            allAgree: boolean, confident: boolean, evidence: object, reason?: string}}
 */
function eventTypeIsDeclared(type, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();

  // A malformed `type` must never resolve to declaredIn:{false,false,false} —
  // that is byte-identical to a genuine "declared nowhere" result, which is
  // exactly the false-negative shape this tool exists to eliminate. `null`
  // fields (not `false`) mark "not checked", distinct from "checked, absent".
  if (typeof type !== 'string' || !type) {
    return {
      type: type === undefined ? null : type,
      declaredIn: { md: null, shadow: null, tier2: null },
      allAgree: false,
      confident: false,
      evidence: {},
      reason: 'invalid_type',
    };
  }

  let mdSlugs = null;
  try {
    // Lazy require: avoids a hard dependency on the parser module existing
    // in every environment this tool might be vendored into.
    const parser = require('../_lib/event-schemas-parser');
    const content = fs.readFileSync(path.join(root, SCHEMA_MD_REL), 'utf8');
    mdSlugs = new Set(parser.parseEventSchemas(content).map((e) => e.slug));
  } catch (_e) { mdSlugs = null; }

  let shadowSlugs = null;
  try {
    const shadow = JSON.parse(fs.readFileSync(path.join(root, SCHEMA_SHADOW_REL), 'utf8'));
    shadowSlugs = new Set(Object.keys(shadow).filter((k) => k !== '_meta'));
  } catch (_e) { shadowSlugs = null; }

  let tier2Slugs = null;
  try {
    const tier2 = JSON.parse(fs.readFileSync(path.join(root, SCHEMA_TIER2_REL), 'utf8'));
    tier2Slugs = new Set(Object.keys(tier2.events || {}));
  } catch (_e) { tier2Slugs = null; }

  if (mdSlugs === null && shadowSlugs === null && tier2Slugs === null) {
    return {
      type, declaredIn: { md: false, shadow: false, tier2: false }, allAgree: false,
      confident: false, evidence: {}, reason: 'none_of_the_three_sources_readable',
    };
  }

  const declaredIn = {
    md: mdSlugs !== null ? mdSlugs.has(type) : null,
    shadow: shadowSlugs !== null ? shadowSlugs.has(type) : null,
    tier2: tier2Slugs !== null ? tier2Slugs.has(type) : null,
  };
  const readable = Object.values(declaredIn).filter((v) => v !== null);
  const allAgree = readable.every((v) => v === readable[0]);

  return {
    type,
    declaredIn,
    allAgree,
    confident: true,
    evidence: {
      md_readable: mdSlugs !== null,
      shadow_readable: shadowSlugs !== null,
      tier2_readable: tier2Slugs !== null,
    },
  };
}

/**
 * Failure #10 defense: which of `types` are truly undeclared, by MEMBERSHIP
 * against event-schemas.md (not by comparing set SIZES, which was the actual
 * bug — `discoveredSet.size - declaredSet.size` reported 108 when the real
 * membership diff was 132; overlapping-but-different sets make size
 * subtraction meaningless).
 *
 * @param {string[]} types
 * @param {{root?: string}} [opts]
 * @returns {{undeclared: string[], declared: string[], confident: boolean, reason?: string}}
 */
function undeclaredEventTypes(types, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();
  // A non-array `types` either throws (`for...of` on a plain object) or —
  // worse — silently succeeds on anything else iterable: a bare string is
  // iterable by character, so `undeclaredEventTypes('abc', ...)` would
  // fabricate `undeclared: ['a','b','c']` instead of rejecting the call.
  if (!Array.isArray(types) || !types.every((t) => typeof t === 'string' && t)) {
    return { undeclared: [], declared: [], confident: false, reason: 'invalid_types' };
  }
  let mdSlugs;
  try {
    const parser = require('../_lib/event-schemas-parser');
    const content = fs.readFileSync(path.join(root, SCHEMA_MD_REL), 'utf8');
    mdSlugs = new Set(parser.parseEventSchemas(content).map((e) => e.slug));
  } catch (e) {
    return { undeclared: [], declared: [], confident: false, reason: 'event_schemas_md_unreadable: ' + e.message };
  }
  const undeclared = [];
  const declared = [];
  for (const t of types) (mdSlugs.has(t) ? declared : undeclared).push(t);
  return { undeclared, declared, confident: true };
}

// ---------------------------------------------------------------------------
// 4. configKeyIsReferenced — failure mode #4 (snake_case config vs camelCase code)
// ---------------------------------------------------------------------------

/** `cold_init_async` -> `coldInitAsync`. */
function toCamelCase(snake) {
  return snake.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/**
 * Is a snake_case config key ever actually read in code — under EITHER its
 * literal snake_case spelling (`config.cold_init_async`) OR its camelCase
 * call-site spelling (`opts.coldInitAsync`)? A grep for only the literal
 * snake_case string misses the camelCase call site entirely and reports a
 * live config key as unreferenced — failure #4.
 *
 * Checks, for each spelling: `.key`, `['key']`/`["key"]`, and destructured
 * `{ key }` / `{ key: renamed }`.
 *
 * @param {string} key — snake_case config key, e.g. 'cold_init_async'
 * @param {{root?: string, exclude?: string[]}} [opts]
 * @returns {{key: string, camelCase: string, referenced: boolean, confident: boolean, evidence: object[]}}
 */
function configKeyIsReferenced(key, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();
  if (typeof key !== 'string' || !key) {
    return { key: String(key == null ? '' : key), camelCase: '', referenced: false, confident: false, evidence: [], reason: 'invalid_key' };
  }
  const rootCheck = checkRootIsDir(root);
  if (!rootCheck.ok) {
    return { key, camelCase: toCamelCase(key), referenced: false, confident: false, evidence: [], reason: rootCheck.reason };
  }
  const camel = toCamelCase(key);
  const spellings = key === camel ? [key] : [key, camel];

  const evidence = [];
  const files = walkFiles(root, o);
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { continue; }
    const text = stripComments(raw);
    const rel = path.relative(root, file);

    for (const spelling of spellings) {
      const esc = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const forms = [
        { re: new RegExp('\\.' + esc + '(?![A-Za-z0-9_$])', 'g'), form: 'dot' },
        { re: new RegExp('\\[\\s*[\'"]' + esc + '[\'"]\\s*\\]', 'g'), form: 'bracket' },
        // destructuring / object-literal key: `{ key` at a property boundary (start-of-object or after comma)
        { re: new RegExp('[{,]\\s*' + esc + '\\s*[,:}]', 'g'), form: 'destructure-or-literal' },
      ];
      for (const { re, form } of forms) {
        for (const m of text.matchAll(re)) {
          evidence.push({
            file: rel, line: lineOf(text, m.index), spelling,
            convention: spelling === key ? 'snake_case' : 'camelCase',
            form, snippet: m[0].trim(),
          });
        }
      }
    }
  }

  return { key, camelCase: camel, referenced: evidence.length > 0, confident: true, evidence };
}

// ---------------------------------------------------------------------------
// 5. callSitesMissingArg — failure modes #6 (docstring), #7 (shorthand), #8 (all files)
// ---------------------------------------------------------------------------

/**
 * Given a top-level call argument's raw text, decide whether it satisfies
 * `argName` — as a bare positional identifier, or as a property (keyed OR
 * ES6 shorthand) of an object-literal argument. Failure #7's exact shape:
 * `getChunk(eventType, { cwd })` — `cwd` is a SHORTHAND property, not
 * `cwd: cwd`; a regex requiring `argName\\s*:` never matches it.
 *
 * @param {string} argText
 * @param {string} argName
 * @returns {{match: boolean, form: string|null, ambiguous: boolean}}
 */
function _argSatisfies(argText, argName) {
  const trimmed = argText.trim();
  if (trimmed === argName) return { match: true, form: 'bare', ambiguous: false };
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1);
    let ambiguous = false;
    for (const prop of splitTopLevel(inner)) {
      if (prop.startsWith('...')) { ambiguous = true; continue; } // spread — can't know what it carries
      if (prop.startsWith('[')) { ambiguous = true; continue; }   // computed key
      const colonIdx = prop.indexOf(':');
      const keyPart = (colonIdx === -1 ? prop : prop.slice(0, colonIdx)).trim();
      // Shorthand may carry a default: `{ cwd = defaultVal }`.
      const key = keyPart.split('=')[0].trim();
      if (key === argName) {
        return { match: true, form: colonIdx === -1 ? 'shorthand' : 'keyed', ambiguous: false };
      }
    }
    return { match: false, form: null, ambiguous };
  }
  return { match: false, form: null, ambiguous: false };
}

// Directory segments and filename suffixes that mark a file as a test file.
// Kept separate from the isPathExcluded/`exclude` fragment matcher above
// because a suffix like `.test.js` is a filename SUFFIX, not a full path
// segment — segment-run matching would never match it.
const TEST_DIR_SEGMENTS = new Set(['tests', '__tests__']);
const TEST_FILE_SUFFIX_RE = /\.(test|spec)\.[jt]sx?$/i;

/**
 * Is `relPath` (posix-separated, relative to walk root) a test file — either
 * by directory (`tests/`, `__tests__/`, at any depth) or by filename suffix
 * (`*.test.js`, `*.spec.ts`, ...)?
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isTestPath(relPath) {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.some((s) => TEST_DIR_SEGMENTS.has(s))) return true;
  return TEST_FILE_SUFFIX_RE.test(segments[segments.length - 1] || '');
}

/**
 * Enumerate real call sites of `fnName` under `root` and report which ones
 * lack `argName`. Comment-stripped first (stripComments), so a docstring
 * that merely mentions `fnName(...)` (failure #6) is never counted as a
 * call site. Every matching file is scanned (failure #8 — no `head -1`
 * shortcut anywhere in this file).
 *
 * Test files (see isTestPath) are EXCLUDED FROM `callSites`/`missing` BY
 * DEFAULT: the question this function answers is almost always "which
 * *production* call sites are missing this arg" — test fixtures routinely
 * construct calls without every argument on purpose (that shape produced 9
 * phantom hits from a single test file in the session that motivated this
 * tool). The exclusion is never silent — every excluded call site is still
 * returned, in `excludedTestCallSites`, so a caller sees what was filtered
 * rather than guessing. Pass `{ includeTests: true }` to fold them back in.
 *
 * @param {string} fnName
 * @param {string} argName
 * @param {{root?: string, exclude?: string[], includeTests?: boolean}} [opts]
 * @returns {{fnName: string, argName: string, callSites: object[], missing: object[],
 *            excludedTestCallSites: object[], includeTests: boolean, confident: boolean}}
 */
function callSitesMissingArg(fnName, argName, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();
  const includeTests = o.includeTests === true;
  if (typeof fnName !== 'string' || !fnName) {
    return {
      fnName: String(fnName == null ? '' : fnName), argName, callSites: [], missing: [],
      excludedTestCallSites: [], includeTests, confident: false, reason: 'invalid_fn_name',
    };
  }
  // Note: an invalid argName does not throw downstream, but it silently makes
  // _argSatisfies() return false for every call site — every real call site
  // then reads as "confidently missing the arg", a fabricated always-missing
  // report rather than a rejected question.
  if (typeof argName !== 'string' || !argName) {
    return {
      fnName, argName: String(argName == null ? '' : argName), callSites: [], missing: [],
      excludedTestCallSites: [], includeTests, confident: false, reason: 'invalid_arg_name',
    };
  }
  const rootCheck = checkRootIsDir(root);
  if (!rootCheck.ok) {
    return {
      fnName, argName, callSites: [], missing: [], excludedTestCallSites: [],
      includeTests, confident: false, reason: rootCheck.reason,
    };
  }
  const fnEsc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `fnName(` optionally preceded by a dotted receiver chain
  // (`a.b.c.fnName(`) — require a non-identifier, non-dot char (or start)
  // immediately before the chain, so `myFnName(` is never mistaken for a
  // call to `fnName`.
  const callRe = new RegExp('(?:^|[^A-Za-z0-9_$.])(?:[A-Za-z_$][A-Za-z0-9_$]*\\.)*' + fnEsc + '\\s*\\(', 'g');

  const allCallSites = [];
  const files = walkFiles(root, o);
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_e) { continue; }
    const text = stripComments(raw);
    const rel = path.relative(root, file);
    const isTest = isTestPath(rel.split(path.sep).join('/'));

    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(text)) !== null) {
      // A `function fnName(` (or `async function fnName(`) declaration is not
      // a call site — exclude it so the function's own definition line never
      // shows up as a phantom "call missing the arg". ES6 method-shorthand
      // declarations (`fnName(a, b) { ... }` inside an object/class with no
      // `function` keyword) are a known, undetected edge case — syntactically
      // indistinguishable from a call without a real parser.
      const fnStart = m.index + m[0].lastIndexOf(fnName);
      const declLookback = text.slice(Math.max(0, fnStart - 20), fnStart);
      if (/\bfunction\s+$/.test(declLookback)) continue;

      const openParenIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingBracket(text, openParenIdx);
      if (closeIdx === -1) {
        allCallSites.push({
          file: rel, line: lineOf(text, m.index), snippet: m[0].trim(),
          hasArg: false, form: null, confident: false, reason: 'unbalanced_parens', isTest,
        });
        continue;
      }
      const argsText = text.slice(openParenIdx + 1, closeIdx);
      const args = splitTopLevel(argsText);
      let hasArg = false, form = null, ambiguous = false;
      for (const a of args) {
        const r = _argSatisfies(a, argName);
        if (r.ambiguous) ambiguous = true;
        if (r.match) { hasArg = true; form = r.form; break; }
      }
      allCallSites.push({
        file: rel, line: lineOf(text, m.index),
        snippet: text.slice(m.index, Math.min(closeIdx + 1, m.index + 160)).replace(/\s+/g, ' ').trim(),
        hasArg, form,
        confident: !ambiguous || hasArg,
        reason: ambiguous && !hasArg ? 'spread_or_computed_key_present_cannot_rule_out' : undefined,
        isTest,
      });
    }
  }

  const callSites = includeTests ? allCallSites : allCallSites.filter((c) => !c.isTest);
  const excludedTestCallSites = includeTests ? [] : allCallSites.filter((c) => c.isTest);

  // "missing" is deliberately confident-only: a site with a spread/computed
  // key that we can't rule out (confident: false) is surfaced in callSites
  // for the caller to eyeball, but never asserted as definitively missing.
  const missing = callSites.filter((c) => !c.hasArg && c.confident !== false);

  return {
    fnName, argName, callSites, missing, excludedTestCallSites, includeTests,
    confident: callSites.every((c) => c.confident !== false),
  };
}

// ---------------------------------------------------------------------------
// 6. jsonlRowsWhere — failure mode #5 ("event" vs "type" key)
// ---------------------------------------------------------------------------

/**
 * Stream `file` as JSONL, JSON.parse each row, and apply `predicate(row,
 * lineNumber)`. Never greps raw text for a specific key name — that is
 * exactly what let `"event":` rows hide from a `"type":`-only grep for
 * months (failure #5). Malformed lines are recorded, not silently dropped
 * or thrown.
 *
 * @param {string} file
 * @param {(row: object, lineNumber: number) => boolean} predicate
 * @returns {{file: string, matches: object[], malformed: object[], totalRows: number, confident: boolean, reason?: string}}
 */
function jsonlRowsWhere(file, predicate) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { file, matches: [], malformed: [], totalRows: 0, confident: false, reason: 'file_unreadable: ' + e.message };
  }
  const lines = raw.split('\n');
  const matches = [];
  const malformed = [];
  let totalRows = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.trim() === '') continue;
    totalRows++;
    let row;
    try { row = JSON.parse(lineText); } catch (e) {
      malformed.push({ line: i + 1, error: e.message });
      continue;
    }
    let hit;
    try { hit = predicate(row, i + 1); } catch (e) {
      malformed.push({ line: i + 1, error: 'predicate_threw: ' + e.message });
      continue;
    }
    if (hit) matches.push({ line: i + 1, row });
  }
  return { file, matches, malformed, totalRows, confident: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseRootFlag(argv) {
  const idx = argv.indexOf('--root');
  if (idx === -1) return { root: process.cwd(), rest: argv };
  const rest = argv.slice();
  const root = rest[idx + 1];
  rest.splice(idx, 2);
  return { root: root || process.cwd(), rest };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const cmd = args[0];
  const { root, rest } = parseRootFlag(args.slice(1));

  let result;
  switch (cmd) {
    case 'env':
      result = envSwitchIsRead(rest[0], { root });
      break;
    case 'tool':
      result = agentGrantsTool(rest[0], rest[1]);
      break;
    case 'event':
      result = eventTypeIsDeclared(rest[0], { root });
      break;
    case 'undeclared':
      result = undeclaredEventTypes((rest[0] || '').split(',').map((s) => s.trim()).filter(Boolean), { root });
      break;
    case 'config':
      result = configKeyIsReferenced(rest[0], { root });
      break;
    case 'callsites':
      result = callSitesMissingArg(rest[0], rest[1], { root });
      break;
    case 'jsonl': {
      const [file, key, value] = rest;
      result = jsonlRowsWhere(file, (row) => String(row[key]) === value);
      break;
    }
    default:
      process.stderr.write(
        'usage: verify.js <env|tool|event|undeclared|config|callsites|jsonl> ... [--root DIR]\n'
      );
      return 2;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  envSwitchIsRead,
  agentGrantsTool,
  eventTypeIsDeclared,
  undeclaredEventTypes,
  configKeyIsReferenced,
  callSitesMissingArg,
  jsonlRowsWhere,
  // Exported for testing / reuse:
  walkFiles,
  isPathExcluded,
  isTestPath,
  stripComments,
  findMatchingBracket,
  splitTopLevel,
  toCamelCase,
  checkRootIsDir,
  main,
};
