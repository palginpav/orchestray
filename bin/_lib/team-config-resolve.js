'use strict';

/**
 * team-config-resolve.js — Resolve teammate / unknown agent_type to a model tier.
 *
 * Used by `bin/collect-agent-metrics.js` AFTER the primary `routing_outcome`
 * lookup misses. Reads the `model:` frontmatter field of `agents/<name>.md`
 * to recover the tier, with a forward-look for not-yet-shipped agents.
 *
 * Resolution order (per W1 P1.1 design §M0.2):
 *   1. Forward-look: 'haiku-scout' / 'pm-router' → 'haiku' (cost-pipeline
 *      labeling for not-yet-on-disk agents). v2.2.3 P4 W2 stripped
 *      'orchestray-housekeeper' (zero invocations) and added 'pm-router'.
 *   2. Exact agents/<name>.md frontmatter `model:` field — cached on first scan.
 *   3. 'unknown_team_member' fallback. Treated as Sonnet by `getPricing` but
 *      LABELED so the dashboard can flag rows for follow-up. The caller flips
 *      `cost_confidence` to 'estimated' when this label is returned.
 *
 * Cache scope: per-process (Map). Each hook invocation is a fresh process,
 * so the cache is essentially per-call — safe from staleness across edits.
 *
 * Fail-open contract: never throws. Returns 'unknown_team_member' on any read
 * error.
 */

const fs   = require('fs');
const path = require('path');

const FORWARD_LOOK_HAIKU = ['haiku-scout', 'pm-router'];

const _cache = new Map();
let _agentsDirScanned = false;
let _scannedCwd = null;

/**
 * Walk `<cwd>/agents/*.md` once and populate the model-tier cache from each
 * file's YAML frontmatter `model:` field. Silently no-ops on read errors.
 *
 * @param {string} cwd - Absolute project root.
 */
function _scanAgentsDir(cwd) {
  if (_agentsDirScanned && _scannedCwd === cwd) return;
  _cache.clear();
  _agentsDirScanned = true;
  _scannedCwd = cwd;

  const agentsDir = path.join(cwd, 'agents');
  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch (_e) {
    return; // No agents/ dir — caller will fall through to 'unknown_team_member'.
  }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const slug = file.slice(0, -3);
    let body;
    try {
      body = fs.readFileSync(path.join(agentsDir, file), 'utf8');
    } catch (_e) { continue; }
    // Read only YAML frontmatter (between leading --- and next ---).
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const modelMatch = fm[1].match(/^model:\s*(\S+)\s*$/m);
    if (modelMatch) _cache.set(slug, modelMatch[1].trim());
  }
}

/**
 * Resolve an agent_type to a tier label.
 *
 * @param {string|null} agentType - The agent_type from the SubagentStop /
 *                                  TaskCompleted event.
 * @param {string}      cwd       - Absolute project root.
 * @returns {string} One of: 'opus', 'sonnet', 'haiku', or 'unknown_team_member'.
 *                   `getPricing` in collect-agent-metrics.js prices
 *                   'unknown_team_member' as Sonnet (because the lowercased
 *                    label contains none of opus/haiku/sonnet substrings),
 *                    but the row is labeled for downstream filtering.
 */
function resolveTeammateModel(agentType, cwd) {
  if (!agentType) return 'unknown_team_member';

  // (1) Forward-look — independent of disk scan. Exact match only:
  // substring matching would let a crafted agent_type like
  // `evil-haiku-scout-suffix` resolve to the cheaper Haiku tier (W6 S-003).
  for (const fl of FORWARD_LOOK_HAIKU) {
    if (agentType === fl) return 'haiku';
  }

  // (2) Frontmatter cache.
  _scanAgentsDir(cwd);
  if (_cache.has(agentType)) {
    const m = (_cache.get(agentType) || '').toLowerCase();
    if (m.includes('opus'))   return 'opus';
    if (m.includes('haiku'))  return 'haiku';
    if (m.includes('sonnet')) return 'sonnet';
    // 'inherit' or any other token → unknown (parent session's model is
    // invisible to a hook process; do not pretend to know it).
    return 'unknown_team_member';
  }

  // (3) No match.
  return 'unknown_team_member';
}

module.exports = { resolveTeammateModel };

// Test seam: clear per-process cache between tests.
module.exports._resetForTest = () => {
  _cache.clear();
  _agentsDirScanned = false;
  _scannedCwd = null;
};
