#!/usr/bin/env node
'use strict';

/**
 * codemod-hook-stdin.js — migrate `bin/` hook scripts onto the shared entry
 * point `bin/_lib/hook-stdin.js` (v2.3.18 W0).
 *
 * 109 of 139 scripts in `bin/` read stdin, in three idioms:
 *   A. `process.stdin.setEncoding/on('data')/on('end')` accumulation  (105)
 *   B. `fs.readFileSync(0, 'utf8')`                                    (8)
 *   C. `fs.readFileSync('/dev/stdin', 'utf8')`                         (2)
 *
 * All three become `readHookInputRaw()`, which is where the D1 dual-install
 * dedup guard and the (dormant) BDG harvest seam now live.
 *
 * The transform is deliberately LEXICAL and conservative. Idiom A is rewritten
 * only when every `process.stdin` reference in the file fits the canonical
 * single-line shape; anything else (streaming reads, `for await`, multi-line
 * error handlers, readline interfaces) is reported as SKIPPED and left alone.
 * A codemod that silently half-transforms a hook is worse than one that
 * refuses to touch it.
 *
 * Usage:
 *   node bin/_tools/codemod-hook-stdin.js --report      # classify only
 *   node bin/_tools/codemod-hook-stdin.js --apply       # rewrite
 *   node bin/_tools/codemod-hook-stdin.js --apply f1 f2 # rewrite a subset
 */

const fs   = require('fs');
const path = require('path');

const BIN_DIR = path.resolve(__dirname, '..');

// --- line-shape matchers ---------------------------------------------------

const RE_SET_ENCODING = /^\s*process\.stdin\.setEncoding\(['"]utf-?8['"]\);\s*$/;
// `process.stdin.on('data', (chunk) => { acc += chunk; });` and single-arg variants.
const RE_DATA = /^\s*process\.stdin\.on\(\s*['"]data['"]\s*,\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{\s*(\w+)\s*\+=\s*\1\s*;?\s*\}\s*\);\s*$/;
// `process.stdin.on('end', () => {`  /  `... async () => {` — block opener.
const RE_END_OPEN = /^(\s*)process\.stdin\.on\(\s*['"]end['"]\s*,\s*(async\s+)?\(\s*\)\s*=>\s*\{\s*$/;
// `process.stdin.on('end', finish);` / `... () => { run(); });` — single line.
const RE_END_INLINE = /^(\s*)process\.stdin\.on\(\s*['"]end['"]\s*,\s*(.+)\);\s*$/;
// Any single-line error listener — dropped; readHookInputRaw already fails open.
const RE_ERROR_INLINE = /^\s*process\.stdin\.on\(\s*['"]error['"]\s*,.*\);\s*$/;
// Benign references that need no rewrite.
const RE_BENIGN = /process\.stdin\.isTTY/;

const RE_READ_FD0 = /(?:fs|require\(['"]fs['"]\))\.readFileSync\(\s*0\s*,\s*['"]utf-?8['"]\s*\)/g;
const RE_READ_DEV_STDIN = /(?:fs|require\(['"]fs['"]\))\.readFileSync\(\s*['"]\/dev\/stdin['"]\s*,\s*['"]utf-?8['"]\s*\)/g;

// Multi-line block openers.
const RE_DATA_OPEN  = /^(\s*)process\.stdin\.on\(\s*['"]data['"]\s*,\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{\s*$/;
const RE_ERROR_OPEN = /^(\s*)process\.stdin\.on\(\s*['"]error['"]\s*,\s*(?:async\s+)?\(?\s*\w*\s*\)?\s*=>\s*\{\s*$/;

/** A line that only ever mentions process.stdin inside a comment. */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Find the last line index of the statement opening at `start`, by balancing
 * parens and braces. String literals and line comments are skipped so a `{`
 * inside a message cannot throw the count off. Returns -1 if unbalanced.
 */
function findStatementEnd(lines, start) {
  let paren = 0;
  let brace = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let quote = null;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote) {
        if (ch === '\\') { c++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '/' && line[c + 1] === '/') break;
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '{') brace++;
      else if (ch === '}') brace--;
    }
    if (i > start || paren !== 0 || brace !== 0) {
      if (paren === 0 && brace === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse a multi-line `data` handler.
 *
 * The canonical shape is an accumulation followed (usually) by the v2.3.14
 * oversized-input guard:
 *
 *   process.stdin.on('data', (chunk) => {
 *     input += chunk;
 *     if (input.length > MAX_INPUT_BYTES) { …bail with a continue response… }
 *   });
 *
 * The guard is preserved verbatim and hoisted to just after the synchronous
 * read, so the same stderr/stdout/exit behaviour applies to the same inputs —
 * only the moment of detection moves (after the full read rather than mid-
 * stream). Any handler whose tail still references the chunk parameter is
 * genuinely streaming and is refused.
 *
 * @returns {{acc: string, rest: string[]}|null}
 */
function parseDataHandler(lines, start, end, openIndent) {
  const raw = lines.slice(start + 1, end);
  let firstIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    firstIdx = i;
    break;
  }
  if (firstIdx === -1) return null;

  const m = raw[firstIdx].trim().match(/^(\w+)\s*\+=\s*(\w+)\s*;?$/);
  if (!m) return null;
  const [, acc, param] = m;

  const tail = raw.slice(firstIdx + 1);
  const paramRe = new RegExp('\\b' + param + '\\b');
  if (tail.some((l) => paramRe.test(l))) return null;   // genuinely streaming

  const bodyIndent = raw[firstIdx].match(/^\s*/)[0];
  const dedent = Math.max(0, bodyIndent.length - openIndent.length);
  const rest = tail.map((l) => (l.startsWith(' '.repeat(dedent)) ? l.slice(dedent) : l));
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  return { acc, rest };
}

/** All candidate hook scripts under bin/ (excluding _lib, _tools, tests). */
function listScripts() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(BIN_DIR, full);
      if (rel.startsWith('__tests__') || rel.includes(`${path.sep}__tests__`)) continue;
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (name.endsWith('.js')) out.push(full);
    }
  };
  walk(BIN_DIR);
  // The shared entry itself and the dev tools are not hook scripts.
  const EXCLUDE = new Set([path.join('_lib', 'hook-stdin.js')]);
  return out.filter((f) => {
    const rel = path.relative(BIN_DIR, f);
    return !rel.startsWith('_tools' + path.sep) && !EXCLUDE.has(rel);
  });
}

/** Relative require specifier from `file` to bin/_lib/hook-stdin.js. */
function requireSpecifier(file) {
  let rel = path.relative(path.dirname(file), path.join(BIN_DIR, '_lib', 'hook-stdin.js'));
  rel = rel.replace(/\\/g, '/').replace(/\.js$/, '');
  return rel.startsWith('.') ? rel : './' + rel;
}

/**
 * Insert the require after the last top-level `const … = require(…)` line,
 * falling back to just after `'use strict';`.
 */
function insertRequire(lines, spec) {
  if (lines.some((l) => l.includes("require('" + spec + "')") || l.includes('hook-stdin'))) return lines;
  const decl = `const { readHookInputRaw } = require('${spec}');`;
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^const .*=\s*require\(/.test(lines[i])) anchor = i;
  }
  if (anchor === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^['"]use strict['"];\s*$/.test(lines[i])) { anchor = i; break; }
    }
  }
  if (anchor === -1) return [decl, ...lines];
  return [...lines.slice(0, anchor + 1), decl, ...lines.slice(anchor + 1)];
}

/**
 * Classify and (optionally) rewrite one file.
 *
 * @returns {{status: 'converted'|'skipped'|'not-stdin', idiom?: string, reason?: string, text?: string}}
 */
function transform(file, src) {
  const spec = requireSpecifier(file);
  let text = src;
  let idiom = null;

  // --- idioms B and C: pure expression substitution, no control-flow change.
  if (RE_READ_FD0.test(text) || RE_READ_DEV_STDIN.test(text)) {
    RE_READ_FD0.lastIndex = 0;
    RE_READ_DEV_STDIN.lastIndex = 0;
    text = text.replace(RE_READ_FD0, 'readHookInputRaw()')
               .replace(RE_READ_DEV_STDIN, 'readHookInputRaw()');
    idiom = RE_READ_DEV_STDIN.test(src) ? 'dev-stdin' : 'readFileSync-0';
    RE_READ_DEV_STDIN.lastIndex = 0;
  }

  // --- idiom A: event-driven accumulation.
  if (/process\.stdin\.on\(/.test(text)) {
    const lines = text.split('\n');
    const refs = [];
    lines.forEach((l, i) => { if (/process\.stdin/.test(l)) refs.push(i); });

    let accumulator = null;
    const drop = new Set();
    const rewrite = new Map();

    for (const i of refs) {
      if (drop.has(i) || rewrite.has(i)) continue;   // already consumed by a block
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (RE_SET_ENCODING.test(line)) { drop.add(i); continue; }

      const dataMatch = line.match(RE_DATA);
      if (dataMatch) {
        if (accumulator) return { status: 'skipped', reason: 'multiple data handlers' };
        accumulator = dataMatch[2];
        rewrite.set(i, line.replace(/process\.stdin\.on\([\s\S]*$/,
          `${accumulator} = readHookInputRaw();`));
        continue;
      }

      const dataOpen = line.match(RE_DATA_OPEN);
      if (dataOpen) {
        if (accumulator) return { status: 'skipped', reason: 'multiple data handlers' };
        const end = findStatementEnd(lines, i);
        if (end === -1) return { status: 'skipped', reason: 'unbalanced data handler' };
        const parsed = parseDataHandler(lines, i, end, dataOpen[1]);
        if (!parsed) return { status: 'skipped', reason: 'streaming data handler' };
        accumulator = parsed.acc;
        rewrite.set(i, [`${dataOpen[1]}${parsed.acc} = readHookInputRaw();`, ...parsed.rest].join('\n'));
        for (let k = i + 1; k <= end; k++) drop.add(k);
        continue;
      }

      const endOpen = line.match(RE_END_OPEN);
      if (endOpen) {
        rewrite.set(i, `${endOpen[1]}setImmediate(${endOpen[2] || ''}() => {`);
        continue;
      }

      if (RE_ERROR_INLINE.test(line)) { drop.add(i); continue; }
      if (RE_ERROR_OPEN.test(line)) {
        const end = findStatementEnd(lines, i);
        if (end === -1) return { status: 'skipped', reason: 'unbalanced error handler' };
        for (let k = i; k <= end; k++) drop.add(k);
        continue;
      }

      const endInline = line.match(RE_END_INLINE);
      if (endInline) { rewrite.set(i, `${endInline[1]}setImmediate(${endInline[2]});`); continue; }
      if (RE_BENIGN.test(line)) continue;
      return { status: 'skipped', reason: 'unrecognised process.stdin shape: ' + line.trim().slice(0, 70) };
    }

    if (!accumulator) return { status: 'skipped', reason: 'no canonical data accumulator' };
    // The accumulator must be reassignable.
    if (new RegExp(`^\\s*const\\s+${accumulator}\\b`, 'm').test(text)) {
      return { status: 'skipped', reason: 'accumulator declared const' };
    }

    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (drop.has(i)) continue;
      out.push(rewrite.has(i) ? rewrite.get(i) : lines[i]);
    }
    text = out.join('\n');
    idiom = 'stdin-events';
  }

  if (!idiom) {
    // Still a stdin reader (async iteration, readline, isTTY probe) — report it
    // rather than letting it vanish into the "no stdin" bucket.
    const meaningful = src.split('\n').filter((l) => /process\.stdin/.test(l) && !isCommentLine(l));
    if (meaningful.length) {
      return { status: 'skipped', reason: 'non-canonical reader: ' + meaningful[0].trim().slice(0, 60) };
    }
    return { status: 'not-stdin' };
  }
  if (text === src) return { status: 'skipped', reason: 'no change produced' };

  text = insertRequire(text.split('\n'), spec).join('\n');
  return { status: 'converted', idiom, text };
}

// --- CLI -------------------------------------------------------------------

function main(argv) {
  const apply = argv.includes('--apply');
  const explicit = argv.filter((a) => !a.startsWith('--'));
  const files = explicit.length ? explicit.map((f) => path.resolve(f)) : listScripts();

  const tally = { converted: [], skipped: [], notStdin: 0 };
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const result = transform(file, src);
    const rel = path.relative(path.dirname(BIN_DIR), file);
    if (result.status === 'not-stdin') { tally.notStdin++; continue; }
    if (result.status === 'skipped') { tally.skipped.push(`${rel} — ${result.reason}`); continue; }
    tally.converted.push(`${rel} [${result.idiom}]`);
    if (apply) fs.writeFileSync(file, result.text, 'utf8');
  }

  console.log(`converted: ${tally.converted.length}`);
  for (const l of tally.converted) console.log('  + ' + l);
  console.log(`skipped:   ${tally.skipped.length}`);
  for (const l of tally.skipped) console.log('  - ' + l);
  console.log(`no stdin:  ${tally.notStdin}`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { transform, requireSpecifier, listScripts };
