#!/usr/bin/env node
// NOT_A_HOOK: CLI-only diagnostic. Never wired into hooks.json or the test
// suite as a gate — report-only, cannot block a build or a spawn.
'use strict';

/**
 * bin/audit-inert-features.js (v2.3.30 W8)
 *
 * Mechanically detects the "documented but structurally unable to run" defect
 * class: six instances found across v2.2.9-v2.3.29 (see
 * .orchestray/kb/decisions/v2330-scope-locked.md §W8). Two sub-checks:
 *
 *   A. Tool-grant vs instruction parity — an agent's prompt (and its
 *      *-stages/*-dimensions companion files) must not instruct an action its
 *      granted `tools:` frontmatter cannot perform.
 *   B. Reachability — an exported function in bin/_lib/ described as a gate,
 *      guard, validator, sanitizer, or promotion pipeline, whose only callers
 *      repo-wide are test files, is a finding. Includes a narrower B2 pass:
 *      a documented text-transformation claim (e.g. "the Evidence section is
 *      stripped") that names an implementation file but has no corresponding
 *      strip/replace/regex operation in that file.
 *
 * Deliberately NOT detected (see "Known gaps" below): type-mismatch guards
 * (e.g. `typeof x === 'number'` where every real caller passes a string),
 * install-vs-worktree drift, runtime field-shape mismatches, and
 * narrow-condition guards that structurally cannot recur. These require
 * type-flow analysis, deployment-state inspection, or semantic understanding
 * of when a runtime condition occurs — out of scope for a text/AST-light
 * mechanical scanner. Flagging them here would require modeling program
 * semantics this script does not attempt, and a wrong guess would be a false
 * positive of exactly the kind this tool exists to avoid.
 *
 * Usage:
 *   node bin/audit-inert-features.js [--json] [--project-root <dir>]
 *
 * Exit code is always 0 (diagnostic only — see file-level NOT_A_HOOK note).
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
let projectRoot = process.cwd();
const rootIdx = args.indexOf('--project-root');
if (rootIdx !== -1 && args[rootIdx + 1]) projectRoot = path.resolve(args[rootIdx + 1]);

const { parseFrontmatter } = require('./_lib/frontmatter-parse');

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Paragraph indexing — capability phrases in markdown often wrap across
// lines, so line-by-line regex misses them (e.g. "run the\nsanitization
// pipeline via `bin/_lib/shared-promote.js`"). We join each blank-line-
// delimited paragraph into one string for regex matching, while keeping a
// per-line offset table so a match can be mapped back to a real line number.
// ---------------------------------------------------------------------------
function buildParagraphs(content) {
  const lines = content.split('\n');
  const paragraphs = [];
  let cur = null;
  lines.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    if (lineText.trim() === '') {
      if (cur) { paragraphs.push(cur); cur = null; }
      return;
    }
    if (!cur) cur = { startLine: lineNo, lines: [], offsets: [] };
    cur.offsets.push({ line: lineNo, joinedStart: cur.lines.reduce((a, l) => a + l.length + 1, 0) });
    cur.lines.push(lineText);
  });
  if (cur) paragraphs.push(cur);
  return paragraphs.map((p) => ({
    startLine: p.startLine,
    joined: p.lines.join(' '),
    offsets: p.offsets,
  }));
}

function lineForOffset(paragraph, charIndex) {
  let best = paragraph.offsets[0];
  for (const o of paragraph.offsets) {
    if (o.joinedStart <= charIndex) best = o;
    else break;
  }
  return best ? best.line : paragraph.startLine;
}

// ---------------------------------------------------------------------------
// Check A — tool-grant vs instruction parity
// ---------------------------------------------------------------------------

// Verb ... "via/using/through/by running" ... backtick script-path, OR verb
// immediately adjacent to a backtick script-path ("Run `bin/x.js`"). Requires
// an explicit connective, not mere proximity — "run commands. ... enforcement
// at `bin/x.js`" (a *description* of external enforcement, not an
// instruction to execute) must NOT match. That false positive is why the
// connective requirement exists — see "Known gaps".
const BASH_INSTRUCTION_RE =
  /\b(run|execute|invoke|call)\b(?:[^`\n]{0,60}?\b(?:via|using|through|by running|by invoking)\b[^`\n]{0,40}?|\s*)`([^`\n]+\.(?:js|mjs|ts|sh|py))`/gi;
// Reverse order: path mentioned first, verb/compulsion after — e.g.
// "Sanitization gate (`bin/_lib/shared-promote.js`) MUST run before any
// promote." Kept as a separate, narrower pattern (requires "must" or a
// passive run/invoke form) rather than loosening the primary pattern, to
// avoid re-introducing the "run commands ... `bin/x.js`" false positive.
const PATH_THEN_VERB_RE =
  /`([^`\n]+\.(?:js|mjs|ts|sh|py))`[^.\n]{0,60}?\b(must run|must execute|must be (?:run|invoked|executed)|is (?:run|invoked|executed))\b/gi;
// Requires an explicit usage verb near the backtick tool name — a bare
// mention of an mcp tool (e.g. documentation describing what ANOTHER agent
// calls) must not match. See "Known gaps" re: event-schemas.md exclusion.
const MCP_MENTION_RE = /\b(call|use|invoke)\b[^`\n]{0,60}?`(mcp__orchestray__[a-zA-Z0-9_]+)`/gi;

function agentAssociatedFiles(agentsDir, baseName) {
  // Convention observed in this repo: agents/<base>-stages/, agents/<base>-dimensions/,
  // and the pm/pm-reference pairing. Any sibling directory whose name starts
  // with "<base>-" is treated as the agent's companion file set.
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === `${baseName}-stages` || e.name === `${baseName}-dimensions` ||
        (baseName === 'pm' && e.name === 'pm-reference')) {
      const dirPath = path.join(agentsDir, e.name);
      let files = [];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        // event-schemas.md is an omnibus cross-agent reference (documents
        // events emitted by every agent/tool, not per-agent instructions) —
        // deliberately excluded. Attributing its prose to "pm's instructions"
        // produced false positives (e.g. a line describing curate-runner's
        // own tool call, misread as an instruction to pm). See "Known gaps".
        if (f === 'event-schemas.md') continue;
        out.push(path.join(dirPath, f));
      }
    }
  }
  return out;
}

function checkToolGrantParity(projectRoot) {
  const agentsDir = path.join(projectRoot, 'agents');
  const findings = [];
  let files = [];
  try { files = fs.readdirSync(agentsDir); } catch { return findings; }

  for (const f of files) {
    if (!f.endsWith('.md') || f.endsWith('.legacy.md')) continue;
    if (f === 'curator.md.legacy') continue;
    const fullPath = path.join(agentsDir, f);
    if (!fs.statSync(fullPath).isFile()) continue;
    const content = readSafe(fullPath);
    if (!content) continue;
    const parsed = parseFrontmatter(content);
    if (!parsed || !parsed.frontmatter || !parsed.frontmatter.tools) continue;

    const baseName = f.replace(/\.md$/, '');
    const toolsRaw = parsed.frontmatter.tools;
    const toolsStr = Array.isArray(toolsRaw) ? toolsRaw.join(', ') : String(toolsRaw);
    const grantedTools = toolsStr
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const hasBash = grantedTools.some((t) => t === 'Bash');
    const hasWrite = grantedTools.some((t) => t === 'Write');
    const hasEdit = grantedTools.some((t) => t === 'Edit');
    const mcpGrants = new Set(grantedTools.filter((t) => t.startsWith('mcp__orchestray__')));

    const filesToScan = [{ path: fullPath, isPrimary: true }]
      .concat(agentAssociatedFiles(agentsDir, baseName).map((p) => ({ path: p, isPrimary: false })));

    for (const target of filesToScan) {
      const body = readSafe(target.path);
      if (!body) continue;
      const paragraphs = buildParagraphs(body);

      for (const para of paragraphs) {
        // Bash-implying instructions.
        let m;
        BASH_INSTRUCTION_RE.lastIndex = 0;
        while ((m = BASH_INSTRUCTION_RE.exec(para.joined))) {
          const scriptPath = m[2];
          if (!hasBash) {
            findings.push({
              check: 'tool-grant-parity',
              agent: baseName,
              file: path.relative(projectRoot, target.path),
              line: lineForOffset(para, m.index),
              detail: `instructs "${m[0].slice(0, 80).replace(/\s+/g, ' ')}..." (runs/invokes ${scriptPath}) ` +
                `but ${baseName} is not granted Bash — cannot execute a script or binary.`,
            });
          }
        }

        PATH_THEN_VERB_RE.lastIndex = 0;
        while ((m = PATH_THEN_VERB_RE.exec(para.joined))) {
          const scriptPath = m[1];
          if (!hasBash) {
            findings.push({
              check: 'tool-grant-parity',
              agent: baseName,
              file: path.relative(projectRoot, target.path),
              line: lineForOffset(para, m.index),
              detail: `instructs "${m[0].slice(0, 80).replace(/\s+/g, ' ')}..." (${scriptPath} ${m[2]}) ` +
                `but ${baseName} is not granted Bash — cannot execute a script or binary.`,
            });
          }
        }

        // mcp tool mentions not in this agent's own grant list.
        MCP_MENTION_RE.lastIndex = 0;
        while ((m = MCP_MENTION_RE.exec(para.joined))) {
          const toolName = m[2];
          if (!mcpGrants.has(toolName)) {
            findings.push({
              check: 'tool-grant-parity',
              agent: baseName,
              file: path.relative(projectRoot, target.path),
              line: lineForOffset(para, m.index),
              detail: `references \`${toolName}\` but ${baseName}'s tools: frontmatter does not grant it.`,
            });
          }
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check B — reachability of documented guards
// ---------------------------------------------------------------------------

const GUARD_NAME_RE = /gate|guard|sanitiz|valid|promot/i;
const GUARD_DOC_RE = /gate|guard|sanitiz|valid|pipeline|promot/i;
// Matches the "<file>.js — <one-line summary>" convention used throughout
// bin/_lib/*.js headers (verified: 100% of sampled files follow it).
const HEADLINE_RE = /\*\s*[a-zA-Z0-9_.-]+\.js\s*[—-]\s*(.+)/;

// Finds the real declaration line for an identifier — start-of-line anchored
// `function name(` or `async function name(`, so a JSDoc comment that
// happens to mention "async function promotePattern" (a real example from
// shared-promote.js's header) doesn't get reported instead of the actual
// definition further down the file.
function declarationLine(fileContent, identifier) {
  const lines = fileContent.split('\n');
  const declRe = new RegExp(`^\\s*(?:async\\s+)?function\\s+${identifier}\\s*\\(`);
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) return i + 1;
  }
  const idx = fileContent.indexOf(identifier);
  return (fileContent.slice(0, idx).match(/\n/g) || []).length + 1;
}

function findExportedIdentifiers(fileContent) {
  const m = fileContent.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].trim())
    .filter((s) => /^[A-Za-z0-9_$]+$/.test(s));
}

// A candidate must satisfy BOTH: (1) the identifier's own name reads as a
// gate/guard/sanitizer/validator/promoter, AND (2) the file's self-declared
// one-line purpose (not just "gate/valid appears somewhere in 2000 chars of
// prose") says the same thing. Requiring both, instead of either, is what
// keeps this precise — name-only matching flagged ~150 ordinary exports
// (registryPath(), tally(), etc.) in files that merely *mention* "validate"
// somewhere in a paragraph unrelated to the export itself. See "Known gaps".
function isGuardCandidate(fileContent, identifier) {
  if (!GUARD_NAME_RE.test(identifier)) return false;
  const headComment = fileContent.slice(0, 400);
  const headline = headComment.match(HEADLINE_RE);
  return Boolean(headline && GUARD_DOC_RE.test(headline[1]));
}

function listNonTestCallers(projectRoot, identifier, definitionFile) {
  // Grep for `identifier(` — a real call, not just a require destructure —
  // scoped to the directories that can actually invoke bin/_lib code
  // (production surface), excluding test directories/files and the
  // defining file. --binary-files=without-match avoids spurious "binary
  // file matches" noise from unrelated non-UTF8 fixture files under bin/.
  const { execFileSync } = require('node:child_process');
  const scanDirs = ['bin', 'hooks', 'skills', 'agents']
    .map((d) => path.join(projectRoot, d))
    .filter((d) => fs.existsSync(d));
  let out = '';
  try {
    out = execFileSync('grep', [
      '-rn', '-E', '--binary-files=without-match',
      '--exclude-dir=__tests__', '--exclude-dir=node_modules',
      `\\b${identifier}\\s*\\(`,
      '--include=*.js',
      ...scanDirs,
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
  } catch (err) {
    // grep exits 1 when there are no matches; anything else is a real error.
    if (err.status === 1) out = '';
    else out = err.stdout || '';
  }
  const lines = out.split('\n').filter(Boolean);
  const nonTest = lines.filter((l) => {
    const [filePart] = l.split(':');
    if (!filePart) return false;
    if (filePart.includes('__tests__') || filePart.includes('/tests/') || /\.test\.js$/.test(filePart)) return false;
    if (path.resolve(filePart) === path.resolve(definitionFile)) return false; // definition site itself
    if (filePart.includes('node_modules')) return false;
    return true;
  });
  return { total: lines.length, nonTest };
}

function checkReachability(projectRoot) {
  const findings = [];
  const libDir = path.join(projectRoot, 'bin', '_lib');
  let files = [];
  try { files = fs.readdirSync(libDir); } catch { return findings; }

  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const fullPath = path.join(libDir, f);
    if (!fs.statSync(fullPath).isFile()) continue;
    const content = readSafe(fullPath);
    if (!content) continue;
    const exported = findExportedIdentifiers(content);
    for (const identifier of exported) {
      if (identifier.startsWith('_')) continue; // private helpers, not the documented surface
      if (!isGuardCandidate(content, identifier)) continue;
      const { total, nonTest } = listNonTestCallers(projectRoot, identifier, fullPath);
      if (total > 0 && nonTest.length === 0) {
        findings.push({
          check: 'reachability',
          file: path.relative(projectRoot, fullPath),
          line: declarationLine(content, identifier),
          detail: `exported ${identifier}() is described as a gate/guard/sanitizer/promotion pipeline ` +
            `but has zero production callers — only test files (${total} call site(s), all under __tests__/*.test.js) invoke it.`,
        });
      }
    }
  }

  // B2 — documented text-transformation claim absent from the implementation
  // it names. Narrower than B1: looks for "<verb> the <Thing> section" claims
  // in docs/skills that cite a specific bin/_lib/*.js file, then checks
  // whether that file performs an actual strip/replace/regex operation on
  // the named thing (not just a string literal repeating the claim).
  // Verb-first ("strip the Evidence section") and noun-first ("the Evidence
  // section ... is stripped") orders both occur in this codebase's prose —
  // both must be matched or the noun-first form (the actual W7 phrasing)
  // is silently missed. See "Known gaps" for what neither form catches.
  const STRIP_CLAIM_RE = /\b(strip|remove|redact)(?:s|ped|ping)?\b[^.\n]{0,40}?\b([A-Z][a-zA-Z]+)\s+section\b/g;
  const REVERSE_STRIP_CLAIM_RE = /\b([A-Z][a-zA-Z]+)\s+section\b[^.\n]{0,40}?\bis\s+(strip|remov|redact)(?:ped|ed)?\b/gi;
  const docRoots = ['agents', 'skills'].map((d) => path.join(projectRoot, d));
  const timeoutMs = 30000;
  const start = Date.now();
  for (const root of docRoots) {
    if (Date.now() - start > timeoutMs) break;
    walkMd(root, (mdPath, mdBody) => {
      const paragraphs = buildParagraphs(mdBody);
      for (const para of paragraphs) {
        STRIP_CLAIM_RE.lastIndex = 0;
        REVERSE_STRIP_CLAIM_RE.lastIndex = 0;
        let m;
        const matches = [];
        while ((m = STRIP_CLAIM_RE.exec(para.joined))) matches.push({ index: m.index, verb: m[1], thing: m[2] });
        while ((m = REVERSE_STRIP_CLAIM_RE.exec(para.joined))) matches.push({ index: m.index, verb: m[2], thing: m[1] });
        for (const match of matches) {
          const thing = match.thing;
          const pathMatch = para.joined.match(/`(bin\/_lib\/[a-zA-Z0-9_-]+\.js)`/);
          if (!pathMatch) continue;
          const implRelPath = pathMatch[1];
          const implFullPath = path.join(projectRoot, implRelPath);
          const implContent = readSafe(implFullPath);
          if (!implContent) continue;
          const thingRe = new RegExp(thing, 'i');
          const hasCodeOperation = implContent
            .split('\n')
            .some((line) => thingRe.test(line) && /\.replace\(|\.match\(|new RegExp|RegExp\(/.test(line));
          const mentionsThingAtAll = thingRe.test(implContent);
          // v2.3.30: a named function that performs the operation and is actually
          // invoked is equally valid evidence. The original check accepted only
          // .replace()/regex, so a line-filter state machine (how _stripEvidenceSection
          // is really implemented) read as absent — a measured false positive.
          // Require BOTH defined and called: a defined-but-unreachable helper is the
          // very defect this tool exists to find, so it must not count as evidence.
          const opFnRe = new RegExp('\\b(_?(?:strip|remove|redact)\\w*' + thing + '\\w*)\\b', 'i');
          const fnNameMatch = implContent.match(opFnRe);
          let hasNamedOperation = false;
          if (fnNameMatch) {
            const fnName = fnNameMatch[1];
            const defined = new RegExp('function\\s+' + fnName + '\\b|' + fnName + '\\s*[:=]\\s*(?:function|\\()').test(implContent);
            const called  = new RegExp('(?<!function\\s)\\b' + fnName + '\\s*\\(').test(
              implContent.replace(new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)', 'g'), '')
            );
            hasNamedOperation = defined && called;
          }
          if (!hasCodeOperation && !hasNamedOperation) {
            findings.push({
              check: 'reachability-doc-claim',
              file: path.relative(projectRoot, mdPath),
              line: lineForOffset(para, match.index),
              detail: `claims "${thing} section is ${match.verb}ped" via \`${implRelPath}\`, but that file has ` +
                (mentionsThingAtAll
                  ? `no \`.replace()\`/regex operation on "${thing}" — the word only appears in a string literal or comment, not a transformation.`
                  : `no reference to "${thing}" at all — the claimed stage does not exist in the file.`),
            });
          }
        }
      }
    });
  }

  return findings;
}

function walkMd(dir, cb) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkMd(full, cb);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const body = readSafe(full);
      if (body) cb(full, body);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Report-only diagnostic: an internal error here must never propagate as a
  // nonzero exit (would look like a build/spawn failure to a caller that
  // doesn't read the output). Print what ran and exit 0 either way.
  let parityFindings = [];
  let reachabilityFindings = [];
  let internalError = null;
  try {
    parityFindings = checkToolGrantParity(projectRoot);
  } catch (err) {
    internalError = `checkToolGrantParity failed: ${err.message}`;
  }
  try {
    reachabilityFindings = checkReachability(projectRoot);
  } catch (err) {
    internalError = (internalError ? internalError + '; ' : '') + `checkReachability failed: ${err.message}`;
  }
  const all = parityFindings.concat(reachabilityFindings);

  if (asJson) {
    process.stdout.write(JSON.stringify({ findings: all, count: all.length, internalError }, null, 2) + '\n');
    process.exit(0);
  }

  console.log(`audit-inert-features: ${all.length} finding(s)`);
  if (internalError) console.log(`(partial run — internal error: ${internalError})`);
  console.log('');
  for (const f of all) {
    console.log(`[${f.check}] ${f.file}:${f.line}`);
    console.log(`  ${f.detail}`);
    console.log('');
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { checkToolGrantParity, checkReachability, buildParagraphs };
