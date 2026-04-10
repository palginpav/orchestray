'use strict';

/**
 * `pattern_find` MCP tool.
 *
 * Retrieves the most relevant orchestration patterns for a task summary.
 * Per v2011b-architecture.md §3.2.1 and v2011c-stage2-plan.md §4/§6.
 *
 * Stateless per-call: reads every `.orchestray/patterns/*.md`, parses
 * frontmatter, and scores by keyword/role/file-glob overlap times
 * confidence.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');

const AGENT_ROLES = [
  'pm',
  'architect',
  'developer',
  'refactorer',
  'reviewer',
  'debugger',
  'tester',
  'documenter',
  'inventor',
  'security-engineer',
];

const CATEGORIES = [
  'decomposition',
  'routing',
  'specialization',
  'anti-pattern',
  'design-preference',
];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['task_summary'],
  properties: {
    task_summary: { type: 'string', minLength: 3, maxLength: 500 },
    agent_role: { type: 'string', enum: AGENT_ROLES },
    file_globs: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    categories: {
      type: 'array',
      items: { type: 'string', enum: CATEGORIES },
    },
    max_results: { type: 'integer', minimum: 1, maximum: 10 },
    min_confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const definition = deepFreeze({
  name: 'pattern_find',
  description:
    'Retrieve the most relevant patterns for a task. Call before decomposition; ' +
    'inject any returned URIs as @orchestray:pattern://<slug> references in ' +
    'delegation prompts.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_find: ' + validation.errors.join('; '));
  }

  const logger = (context && context.logger) || (() => {});

  // Resolve patterns directory. Tool context may inject projectRoot for
  // tests — prefer it when present (matches fixture strategy in §13).
  let patternsDir;
  try {
    if (context && context.projectRoot) {
      patternsDir = path.join(context.projectRoot, '.orchestray', 'patterns');
    } else {
      patternsDir = paths.getPatternsDir();
    }
  } catch (err) {
    // No project root — no patterns. Return empty match set, not an error.
    return toolSuccess({ matches: [], considered: 0, filtered_out: 0 });
  }

  let entries;
  try {
    entries = fs.readdirSync(patternsDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return toolSuccess({ matches: [], considered: 0, filtered_out: 0 });
    }
    return toolError('pattern_find: ' + (err && err.message ? err.message : String(err)));
  }

  const mdFiles = entries.filter((n) => n.endsWith('.md'));
  const index = [];
  for (const name of mdFiles) {
    const filepath = path.join(patternsDir, name);
    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (err) {
      try { process.stderr.write('[orchestray-mcp] pattern_find: read failed ' + filepath + '\n'); } catch (_e) {}
      continue;
    }
    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) {
      try { process.stderr.write('[orchestray-mcp] pattern_find.parse_error: ' + name + '\n'); } catch (_e) {}
      continue;
    }
    const slug = name.slice(0, -3); // strip .md
    index.push({
      slug,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }

  const considered = index.length;
  const taskSummary = input.task_summary;
  const agentRole = input.agent_role;
  const fileGlobs = Array.isArray(input.file_globs) ? input.file_globs : [];
  const categoryFilter = Array.isArray(input.categories) && input.categories.length > 0
    ? new Set(input.categories) : null;
  const minConfidence = typeof input.min_confidence === 'number' ? input.min_confidence : 0;
  const maxResults = typeof input.max_results === 'number' ? input.max_results : 5;

  const scored = [];
  let filteredOut = 0;

  for (const entry of index) {
    const fm = entry.frontmatter;
    const confidence = _numericConfidence(fm.confidence);
    const category = (typeof fm.category === 'string' && fm.category) ||
                     (typeof fm.type === 'string' && fm.type) || 'unknown';
    const timesApplied = _numericInt(fm.times_applied, 0);
    const description = typeof fm.description === 'string' ? fm.description : '';

    // Category filter
    if (categoryFilter && !categoryFilter.has(category)) {
      filteredOut++;
      continue;
    }

    // min_confidence filter
    if (confidence < minConfidence) {
      filteredOut++;
      continue;
    }

    const bodyHead = entry.body.slice(0, 200);
    const hay = (description + ' ' + bodyHead).toLowerCase();
    const taskTokens = _tokenize(taskSummary);
    const hayTokens = _tokenize(hay);
    const { ratio: overlapRatio, overlap: overlapTokens } = _jaccard(taskTokens, hayTokens);

    let roleBonus = 0;
    if (agentRole) {
      const roleNeedle = agentRole.toLowerCase();
      if (entry.slug.toLowerCase().includes(roleNeedle) ||
          entry.body.toLowerCase().includes(roleNeedle)) {
        roleBonus = 0.3;
      }
    }

    let fileBonus = 0;
    if (fileGlobs.length > 0) {
      const patternSegments = _segmentsOf(entry.body + ' ' + description);
      let overlapSeg = 0;
      for (const g of fileGlobs) {
        for (const seg of _segmentsOf(g)) {
          if (patternSegments.has(seg)) overlapSeg++;
        }
      }
      fileBonus = Math.min(0.4, 0.2 * overlapSeg);
    }

    const score = confidence * (overlapRatio + roleBonus + fileBonus);

    const matchReasons = [];
    if (roleBonus > 0) matchReasons.push('role=' + agentRole);
    for (const tok of Array.from(overlapTokens).slice(0, 3)) {
      matchReasons.push('keyword:' + tok);
    }
    if (fileBonus > 0) matchReasons.push('file-overlap');

    const oneLine = _firstLine(description || entry.body);

    scored.push({
      slug: entry.slug,
      uri: 'orchestray:pattern://' + entry.slug,
      confidence,
      times_applied: timesApplied,
      category,
      one_line: oneLine,
      match_reasons: matchReasons,
      _score: score,
    });
  }

  // Sort: score desc, tiebreak times_applied desc, confidence desc, slug asc.
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    if (b.times_applied !== a.times_applied) return b.times_applied - a.times_applied;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  const top = scored.slice(0, maxResults).map((m) => {
    const { _score, ...rest } = m;
    return rest;
  });

  return toolSuccess({
    matches: top,
    considered,
    filtered_out: filteredOut,
  });
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function _tokenize(text) {
  if (typeof text !== 'string') return new Set();
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return { ratio: 0, overlap: new Set() };
  const overlap = new Set();
  for (const x of a) if (b.has(x)) overlap.add(x);
  const union = new Set([...a, ...b]);
  return { ratio: overlap.size / union.size, overlap };
}

function _segmentsOf(s) {
  if (typeof s !== 'string') return new Set();
  const out = new Set();
  for (const part of s.split(/[\s,()'"[\]{}]+/)) {
    for (const seg of part.split(/[/\\]/)) {
      if (seg.length > 0) out.add(seg);
    }
  }
  return out;
}

function _numericConfidence(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const map = { low: 0.3, medium: 0.6, high: 0.9 };
    if (v in map) return map[v];
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0.5;
}

function _numericInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function _firstLine(s) {
  if (typeof s !== 'string') return '';
  const idx = s.indexOf('\n');
  const line = idx === -1 ? s : s.slice(0, idx);
  return line.trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Result shape helpers
// ---------------------------------------------------------------------------

function toolSuccess(structuredContent) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

module.exports = {
  definition,
  handle,
};
