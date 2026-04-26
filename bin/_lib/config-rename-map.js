'use strict';

/**
 * bin/_lib/config-rename-map.js — known historical key renames for
 * `.orchestray/config.json` top-level fields.
 *
 * v2.1.13 R-CONFIG-DRIFT (W9). Whenever a config key is renamed between
 * Orchestray releases, add an entry here. The drift detector
 * (`bin/_lib/config-drift.js`) consumes this map to emit a targeted
 * "<old> is renamed to <new>" warning on boot, so users with a
 * lingering old-named key do not silently fall back to defaults.
 *
 * Format:
 *   { "<old_key>": { to: "<new_key>", since: "<release>", note?: "<why>" } }
 *
 * Rules:
 *   - Only TOP-LEVEL keys live here. Nested-section renames are out of scope
 *     for W9 (would require schema-walking; deferred).
 *   - Entries are permanent. Removing an entry silently breaks the "did you
 *     mean" suggestion for users still on the old config.
 *   - Keep entries alphabetical by old key for easy audit.
 *
 * Seed entries below are intentionally conservative. If no real rename has
 * occurred yet, leave the map empty (or with documented-but-unused entries
 * that illustrate the format, guarded by the `example: true` flag).
 */

// Format example (for future maintainers):
//   '<old_key>': { to: '<new_key>', since: '<release>', note?: '<why>' }
const RENAME_MAP = Object.freeze({
  // R-AT-FLAG (v2.1.16): the top-level `enable_agent_teams` boolean is
  // superseded by the namespaced `agent_teams.enabled` block. Both keys are
  // honored for one release; the legacy key emits a one-time stderr
  // deprecation warning when present (config-drift.js handles surfacing).
  'enable_agent_teams': {
    to: 'agent_teams.enabled',
    since: '2.1.16',
    note: 'Renamed for namespace consistency with v2.1.14 R-GATE patterns; the legacy boolean is honored as a fallback for one release.',
  },
});

module.exports = { RENAME_MAP };
