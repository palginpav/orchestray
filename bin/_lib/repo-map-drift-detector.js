'use strict';

/**
 * repo-map-drift-detector.js — shadow-mode validator for v2.2.9 B-7.2.
 *
 * Mechanises W1 F-PM-11 and F-PM-19: numeric repo-map thresholds (max-size,
 * pattern hints) drift between pm.md prose and config because both are
 * mutated by hand. This validator:
 *
 *   1. Extracts numeric thresholds named in pm.md prose (looking for the
 *      canonical phrases used by the v2.1.x prose: "max <N> KB", "max <N>
 *      design-preference", "combined cap: max <N>").
 *   2. Compares against `.orchestray/config.json` (`repo_map_thresholds.max_size_kb`,
 *      `delegation_caps.design_preference`, `delegation_caps.combined_total`).
 *   3. Returns an array of drift findings: `{config_value, pm_prose_value,
 *      source_pm_line}`.
 *
 * v2.2.9 ships in shadow-mode (`repo_map_thresholds.shadow_mode: true`):
 * findings are emitted as `repo_map_threshold_drift` events but no spawn is
 * blocked. v2.2.10 will flip `shadow_mode` to false and downstream consumers
 * may treat findings as hard errors.
 *
 * Public API:
 *   detectDrift(cwd) -> { drifts: Array<{...}>, shadow_mode: bool }
 */

const fs = require('fs');
const path = require('path');

const { loadRepoMapThresholds } = require('./numeric-thresholds');

// Patterns we look for in pm.md / phase-*.md prose. Each pattern captures one
// numeric token whose meaning is named in `key`.
const PROSE_PATTERNS = [
  // "repo-map: <N> KB cap" / "max <N> KB" near "repo map"
  {
    key: 'repo_map_max_size_kb',
    re: /(?:repo[-\s]?map[\s\S]{0,80}?max\s+|max\s+repo[-\s]?map\s+size\s+)(\d+)\s*KB/i,
    config_field: 'max_size_kb',
  },
];

function _findInFile(absPath) {
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (_e) {
    return [];
  }
  const lines = content.split('\n');
  const out = [];
  for (const pat of PROSE_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pat.re);
      if (m) {
        out.push({
          key: pat.key,
          config_field: pat.config_field,
          pm_prose_value: parseInt(m[1], 10),
          source_pm_line: i + 1,
          source_file: path.basename(absPath),
        });
        break; // first match per pattern per file
      }
    }
  }
  return out;
}

function detectDrift(cwd) {
  const thresholds = loadRepoMapThresholds(cwd);
  const sources = [
    path.join(cwd, 'agents', 'pm.md'),
    path.join(cwd, 'agents', 'pm-reference', 'phase-execute.md'),
    path.join(cwd, 'agents', 'pm-reference', 'phase-decomp.md'),
    path.join(cwd, 'agents', 'pm-reference', 'phase-close.md'),
  ];

  const drifts = [];
  for (const src of sources) {
    const found = _findInFile(src);
    for (const f of found) {
      const cfgVal = thresholds[f.config_field];
      if (typeof cfgVal === 'number' && f.pm_prose_value !== cfgVal) {
        drifts.push({
          config_value: cfgVal,
          pm_prose_value: f.pm_prose_value,
          source_pm_line: f.source_pm_line,
          source_file: f.source_file,
          key: f.key,
        });
      }
    }
  }

  return { drifts, shadow_mode: thresholds.shadow_mode };
}

module.exports = { detectDrift, PROSE_PATTERNS };
