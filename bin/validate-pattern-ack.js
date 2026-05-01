#!/usr/bin/env node
'use strict';

/**
 * validate-pattern-ack.js — PostToolUse:Agent hook (v2.2.11 W2-6).
 *
 * Pattern-acknowledgement check for architect spawns. After an architect agent
 * completes, verifies that its structured result references at least one of the
 * high-confidence patterns that were offered in the <mcp-grounding> block
 * injected by bin/prefetch-mcp-grounding.js.
 *
 * Behaviour:
 *   1. Triggers only when subagent_type === "architect".
 *   2. Extracts pattern_find results from the <mcp-grounding> block in the
 *      spawn prompt (tool_input.prompt).
 *   3. Filters patterns to those with confidence >= 0.7 (configurable via
 *      .orchestray/config.json key `pattern_ack_confidence_threshold`).
 *   4. If ≥1 high-confidence pattern was offered AND the architect's structured
 *      result summary + files_changed description text references zero slugs,
 *      emits an `architect_pattern_ack_missing` audit event.
 *
 * Fail-open contract:
 *   - Missing grounding → no check → no event (safe).
 *   - Any internal error → exit 0 (never blocks a spawn).
 *   - Kill switch: ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → exit 0.
 *
 * Default-on per feedback_default_on_shipping.md.
 *
 * Hook wiring (for G3b to add to hooks.json):
 *   event:   PostToolUse:Agent
 *   matcher: Agent
 *   script:  bin/validate-pattern-ack.js
 *
 * Input:  Claude Code PostToolUse:Agent JSON payload on stdin
 * Output: { continue: true } on stdout always; exit 0 always
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const SCHEMA_VERSION               = 1;

// ---------------------------------------------------------------------------
// Config loader — reads pattern_ack_confidence_threshold from .orchestray/config.json
// ---------------------------------------------------------------------------

function loadConfidenceThreshold(cwd) {
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    if (!fs.existsSync(configPath)) return DEFAULT_CONFIDENCE_THRESHOLD;
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    const val = cfg && cfg.pattern_ack_confidence_threshold;
    if (typeof val === 'number' && val > 0 && val <= 1) return val;
  } catch (_) { /* fail-open */ }
  return DEFAULT_CONFIDENCE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Grounding parser — extracts pattern_find results from <mcp-grounding> block
// ---------------------------------------------------------------------------

/**
 * Locate the <mcp-grounding> fence in the spawn prompt and return the text
 * of the "## pattern_find results" section within it.
 *
 * @param {string} promptText
 * @returns {string|null}
 */
function extractGroundingBlock(promptText) {
  if (typeof promptText !== 'string' || !promptText) return null;
  const start = promptText.indexOf('<mcp-grounding');
  if (start === -1) return null;
  const end = promptText.indexOf('</mcp-grounding>', start);
  if (end === -1) return null;
  return promptText.slice(start, end + '</mcp-grounding>'.length);
}

/**
 * Extract pattern_find result items from the grounding block text.
 * The grounding block contains a section "## pattern_find results" followed
 * by JSON (from prefetch-mcp-grounding.js line 209: JSON.stringify(structuredContent)).
 *
 * Returns an array of objects with at least { slug, confidence } or [].
 *
 * @param {string} groundingBlock
 * @returns {Array<{slug: string, confidence: number, [k: string]: unknown}>}
 */
function parsePatternFindResults(groundingBlock) {
  if (!groundingBlock) return [];

  // Locate the pattern_find section header.
  const sectionRe = /##\s*pattern_find\s+results\s*\n([\s\S]*?)(?=\n##\s|\n<\/mcp-grounding>|$)/i;
  const match = groundingBlock.match(sectionRe);
  if (!match) return [];

  const sectionBody = match[1].trim();
  if (!sectionBody) return [];

  // Try to parse as JSON. prefetch-mcp-grounding.js writes the structuredContent
  // directly as JSON.stringify'd text. It may be an array or an object with a
  // matches/items/results key.
  let parsed;
  try {
    parsed = JSON.parse(sectionBody);
  } catch (_) {
    return [];
  }

  // Normalise to an array of pattern objects.
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    // Common shapes: { matches: [...] }, { items: [...] }, { results: [...] }
    for (const key of ['matches', 'items', 'results', 'patterns']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }
  return [];
}

/**
 * Filter to high-confidence patterns (confidence >= threshold).
 *
 * @param {Array<object>} patterns
 * @param {number} threshold
 * @returns {string[]} Array of slug strings
 */
function highConfidenceSlugs(patterns, threshold) {
  const slugs = [];
  for (const p of patterns) {
    if (!p || typeof p !== 'object') continue;
    const confidence = typeof p.confidence === 'number' ? p.confidence : -1;
    if (confidence >= threshold) {
      const slug = typeof p.slug === 'string' ? p.slug.trim() : null;
      if (slug) slugs.push(slug);
    }
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Structured result extractor — reused from validate-task-completion pattern
// ---------------------------------------------------------------------------

/**
 * Extract the architect's Structured Result from the PostToolUse hook payload.
 *
 * PostToolUse:Agent payload fields (as observed in sibling validators):
 *   event.tool_response  — the agent's raw text output
 *   event.output         — alternative key (some CC versions)
 *   event.result         — alternative key
 *
 * @param {object} event
 * @returns {{ summary: string, filesChangedText: string }}
 */
function extractResultText(event) {
  const raw = [
    event.tool_response,
    event.output,
    event.result,
    event.agent_output,
  ].find(v => typeof v === 'string' && v.length > 0) || '';

  if (!raw) return { summary: '', filesChangedText: '' };

  // Locate ## Structured Result block.
  const tail = raw.slice(-65536);
  const srMatch = tail.match(/##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (srMatch) {
    try {
      const sr = JSON.parse(srMatch[1]);
      const summary = typeof sr.summary === 'string' ? sr.summary : '';
      // Collect description text from files_changed entries.
      let filesChangedText = '';
      if (Array.isArray(sr.files_changed)) {
        for (const fc of sr.files_changed) {
          if (typeof fc === 'string') {
            filesChangedText += ' ' + fc;
          } else if (fc && typeof fc === 'object') {
            filesChangedText += ' ' + (fc.description || fc.path || '');
          }
        }
      }
      return { summary, filesChangedText: filesChangedText.trim() };
    } catch (_) { /* fall through */ }
  }

  // Fallback: raw text (slug grep will still work).
  return { summary: raw.slice(-8192), filesChangedText: '' };
}

// ---------------------------------------------------------------------------
// Acknowledgement check
// ---------------------------------------------------------------------------

/**
 * Return true if ANY of the offered slugs appears (case-insensitive) in the
 * haystack text.
 *
 * @param {string[]} slugs
 * @param {string}   haystack
 * @returns {boolean}
 */
function anySlugAcknowledged(slugs, haystack) {
  const lower = haystack.toLowerCase();
  return slugs.some(slug => lower.includes(slug.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Trigger guard
// ---------------------------------------------------------------------------

function isArchitectSpawn(event) {
  if (!event) return false;
  const toolName = event.tool_name || '';
  if (toolName !== 'Agent') return false;
  const subtype = (event.tool_input && event.tool_input.subagent_type) || '';
  return subtype === 'architect';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    // Always emit continue — this hook never blocks.
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');

    // Kill switch.
    if (process.env.ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED === '1') return;

    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      return;
    }

    // Only runs for architect spawns.
    if (!isArchitectSpawn(event)) return;

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    try {
      run(event, cwd);
    } catch (_) {
      // Fail-open — never propagate to crash.
    }
  });
}

function run(event, cwd) {
  const threshold = loadConfidenceThreshold(cwd);

  // Extract the spawn prompt (contains injected <mcp-grounding>).
  const promptText = (event.tool_input && typeof event.tool_input.prompt === 'string')
    ? event.tool_input.prompt
    : '';

  const groundingBlock = extractGroundingBlock(promptText);
  // No grounding → no check (safe-on-missing contract).
  if (!groundingBlock) return;

  const patterns = parsePatternFindResults(groundingBlock);
  const offered  = highConfidenceSlugs(patterns, threshold);
  // No high-confidence patterns offered → no check.
  if (offered.length === 0) return;

  // Extract what the architect actually said.
  const { summary, filesChangedText } = extractResultText(event);
  const haystack = [summary, filesChangedText].join(' ');

  // If at least one slug is mentioned, the architect acknowledged — no event.
  if (anySlugAcknowledged(offered, haystack)) return;

  // Emit architect_pattern_ack_missing.
  const spawnId = (event.tool_input && event.tool_input.agent_id)
    || (event.tool_input && event.tool_input.spawn_id)
    || null;

  writeEvent({
    version:               SCHEMA_VERSION,
    type:                  'architect_pattern_ack_missing',
    spawn_id:              spawnId,
    pattern_slugs_offered: offered,
    schema_version:        SCHEMA_VERSION,
  }, { cwd });

  process.stderr.write(
    '[orchestray] validate-pattern-ack: WARN — architect spawn ' + (spawnId || '(unknown)') +
    ' did not acknowledge ' + offered.length + ' offered pattern(s): ' + offered.join(', ') + '. ' +
    'Kill switch: ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1\n'
  );
}

main();
