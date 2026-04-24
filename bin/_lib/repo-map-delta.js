'use strict';

/**
 * repo-map-delta.js — RepoMapDelta injection helper.
 *
 * First delegation in an orchestration gets the full filtered repo map and
 * the map is written to .orchestray/kb/facts/repo-map.md.
 * Subsequent delegations get a pointer block with hash + per-agent hint rows.
 *
 * Also exports injectProjectIntent() — a sibling that injects the
 * ## Project Intent block from .orchestray/kb/facts/project-intent.md into
 * delegation prompts when the file exists AND low_confidence is false (AC-06).
 *
 * State: .orchestray/state/repo-map-delta-state.jsonl
 * Row format: { orch_id, first_agent, file_hash, ts }
 *
 * Contract:
 *   - Never throws. All I/O wrapped in try/catch; errors cause fail-open
 *     (full repo map injected instead of pointer).
 *   - Config opt-out: repo_map_delta: false restores full injection every time.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { atomicAppendJsonl } = require('./atomic-append');
const { recordDegradation } = require('./degraded-journal');
const { readProjectIntent, isLowConfidence } = require('./project-intent');

const STATE_FILE = 'repo-map-delta-state.jsonl';
const REPO_MAP_KB_PATH = path.join('.orchestray', 'kb', 'facts', 'repo-map.md');
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Resolve state file path.
 * @param {string} [projectRoot]
 */
function _statePath(projectRoot) {
  return path.join(projectRoot || process.cwd(), '.orchestray', 'state', STATE_FILE);
}

/**
 * Resolve the KB repo-map file path.
 * @param {string} [projectRoot]
 */
function _repoMapPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), REPO_MAP_KB_PATH);
}

/**
 * Compute sha256 hex of file content.
 * @param {string} content
 * @returns {string}
 */
function _hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read all rows from the state file. Returns [] on any error.
 * @param {string} filePath
 */
function _readRows(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { rows.push(JSON.parse(trimmed)); } catch (_) {}
    }
    return rows;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[orchestray] repo-map-delta: state read error: ' + err.message + '\n');
    }
    return [];
  }
}

/**
 * Check if this orchestration has already emitted the first full repo map.
 * @param {string} orchId
 * @param {string} [projectRoot]
 * @returns {{ emitted: boolean, firstAgent: string|null, fileHash: string|null }}
 */
function _hasFirstEmission(orchId, projectRoot) {
  const rows = _readRows(_statePath(projectRoot));
  for (const row of rows) {
    if (row.orch_id === orchId) {
      return { emitted: true, firstAgent: row.first_agent || null, fileHash: row.file_hash || null };
    }
  }
  return { emitted: false, firstAgent: null, fileHash: null };
}

/**
 * Inject repo map content into a delegation prompt.
 *
 * @param {object} params
 * @param {string}   params.orchId          Current orchestration id.
 * @param {string}   params.agentType       Target agent type.
 * @param {string}   params.repoMapContent  Filtered repo map text.
 * @param {string[]} [params.hintRows]      3-5 most relevant rows for the agent.
 * @param {boolean}  [params.repoMapDelta]  Whether delta mode is enabled (default true).
 * @param {string}   [params.projectRoot]
 * @returns {string}  The formatted ## Repository Map section to inject.
 */
function injectRepoMap(params) {
  try {
    const {
      orchId,
      agentType,
      repoMapContent = '',
      hintRows = [],
      repoMapDelta = true,
      projectRoot,
    } = params || {};

    // If delta mode disabled, return full map block directly.
    if (!repoMapDelta) {
      return '## Repository Map\n\n' + repoMapContent;
    }

    const { emitted, firstAgent, fileHash } = _hasFirstEmission(orchId, projectRoot);

    if (!emitted) {
      // First delegation: write full map to KB file and record state.
      return _emitFirstFull(orchId, agentType, repoMapContent, projectRoot);
    }

    // Subsequent delegation: pointer block only.
    // If the state row exists but first_agent is unknown (corrupt/racey read), emit degraded
    // entry and fall back to full injection so the downstream agent is not under-informed.
    if (!firstAgent) {
      try {
        recordDegradation({
          kind: 'repo_map_delta_first_agent_unknown',
          severity: 'warn',
          detail: {
            orchId,
            message: 'first_agent field missing from state row; falling back to full injection',
            dedup_key: 'rmd-fau-' + orchId,
          },
        });
      } catch (_degradationErr) { /* journal write failure must not block fallback */ }
      return '## Repository Map\n\n' + repoMapContent;
    }

    const mapPath = _repoMapPath(projectRoot);
    const hash8 = fileHash ? fileHash.slice(0, 8) : 'unknown';

    let block = [
      '## Repository Map (unchanged this orchestration)',
      '',
      `The repo map was injected fully into the first agent. It is at`,
      `\`${REPO_MAP_KB_PATH}\` (hash \`${hash8}\`, unchanged since orch start).`,
      'Read it only if you need structural knowledge beyond the per-agent hints below.',
    ];

    if (hintRows && hintRows.length > 0) {
      block.push('', '### Relevant rows for your task');
      for (const row of hintRows.slice(0, 5)) {
        block.push('- ' + row);
      }
    }

    return block.join('\n');
  } catch (err) {
    // Fail-open: any error falls back to full injection.
    try {
      recordDegradation({
        kind: 'repo_map_delta_first_emit_failed',
        severity: 'warn',
        detail: { message: err.message, dedup_key: 'rmd-err-' + (params && params.orchId) },
      });
    } catch (_degradationErr) { /* journal write failure must not block fallback */ }
    return '## Repository Map\n\n' + ((params && params.repoMapContent) || '');
  }
}

/**
 * Write the full repo map to the KB file and record the first-emission state.
 * @param {string} orchId
 * @param {string} agentType
 * @param {string} content
 * @param {string} [projectRoot]
 * @returns {string}
 */
function _emitFirstFull(orchId, agentType, content, projectRoot) {
  try {
    const mapPath = _repoMapPath(projectRoot);
    // Ensure directory exists.
    try { fs.mkdirSync(path.dirname(mapPath), { recursive: true }); } catch (_) {}

    fs.writeFileSync(mapPath, content, 'utf8');
    const fileHash = _hashContent(content);

    const statePath = _statePath(projectRoot);
    try { fs.mkdirSync(path.dirname(statePath), { recursive: true }); } catch (_) {}

    const row = {
      orch_id:     orchId,
      first_agent: agentType,
      file_hash:   fileHash,
      ts:          new Date().toISOString(),
    };
    atomicAppendJsonl(statePath, row);

    return '## Repository Map\n\n' + content;
  } catch (err) {
    recordDegradation({
      kind: 'repo_map_delta_first_emit_failed',
      severity: 'warn',
      detail: { message: err.message, orchId, dedup_key: 'rmd-first-' + orchId },
    });
    // Fail-open: return full map even if state write failed.
    return '## Repository Map\n\n' + content;
  }
}

/**
 * Inject the Project Intent block into a delegation prompt.
 *
 * Reads .orchestray/kb/facts/project-intent.md and, if the file exists AND
 * low_confidence is false, returns a formatted ## Project Intent block ready
 * to prepend to the delegation prompt (AC-06).
 *
 * Returns '' (empty string) when:
 *   - File does not exist
 *   - File has low_confidence: true
 *   - Any read error
 *
 * @param {object} [params]
 * @param {string} [params.projectRoot]
 * @returns {string}  The formatted ## Project Intent section, or ''.
 */
function injectProjectIntent(params) {
  try {
    const { projectRoot } = params || {};
    const content = readProjectIntent(projectRoot);
    if (!content) return '';
    if (isLowConfidence(content)) return '';
    // Return the content as a delegation prompt block.
    // Strip the raw markdown header line (# Project Intent) and the HTML comment,
    // then wrap cleanly so downstream agents see a stable section heading.
    const lines = content.split('\n');
    // Keep lines after stripping the first title line (we re-add it as ## heading)
    const bodyLines = lines.filter(l => !l.startsWith('# Project Intent') && !l.startsWith('<!-- generated:'));
    // Remove leading blank lines from body
    while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
    // Remove trailing blank lines from body
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
    if (bodyLines.length === 0) return '';
    return '## Project Intent\n\n' + bodyLines.join('\n');
  } catch (err) {
    // Fail-open: intent block is additive, so missing it is not fatal.
    return '';
  }
}

module.exports = { injectRepoMap, injectProjectIntent };
