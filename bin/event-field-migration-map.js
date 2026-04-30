'use strict';
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.

/**
 * Event-field migration map (R-EVENT-NAMING, v2.1.13).
 *
 * Historical drift: a handful of emitters in `bin/` wrote `event` + `ts` while
 * the canonical (hook-writer) shape has always been `type` + `timestamp`. The
 * result: `.orchestray/audit/events.jsonl` files from v2.1.12 and earlier mix
 * both conventions within the same file.
 *
 * v2.1.13 unifies emission on the canonical `snake_case` shape and documents
 * both names. This file is the single source of truth for back-compat reads.
 *
 * Rules for adding entries:
 *   - snake_case only.
 *   - ASCII only; no abbreviations for terms longer than 3 chars.
 *   - Add the OLD name even if no in-tree emitter writes it anymore — consumers
 *     still need to read v2.1.12-era `.jsonl` files.
 *   - Never remove entries once added; doing so breaks back-compat readers.
 *   - The NEW name must match the field used by canonical writers (e.g.
 *     `bin/_lib/audit-event-writer.js`, `bin/_lib/kill-switch-event.js`).
 *
 * Consumers should normalise every event through
 * `bin/read-event.js :: normalizeEvent(obj)` before dereferencing fields.
 */

/**
 * Legacy → canonical field name map. A consumer that receives an event with
 * any OLD_TO_NEW key should move the value under the NEW_TO_OLD key and drop
 * the legacy key.
 *
 * Scope (v2.1.13): events written to `.orchestray/audit/events.jsonl`. Files
 * with their own historical schemas (e.g. `.orchestray/state/routing.jsonl`
 * which uses `ts` as its documented convention) are INTENTIONALLY EXCLUDED.
 * See §3 of the R-EVENT-NAMING plan for rationale.
 *
 * @type {Readonly<Record<string, string>>}
 */
const OLD_TO_NEW = Object.freeze({
  // Event-type identifier field.
  // Drift: PM-manual emissions and a handful of hook scripts wrote `event:`.
  // Canonical: `type:` (used by `bin/_lib/audit-event-writer.js`,
  // `bin/_lib/kill-switch-event.js`, `ox events append`, etc.).
  event: 'type',

  // Event timestamp field.
  // Drift: same emitters as above wrote `ts:` (ISO 8601).
  // Canonical: `timestamp:` (ISO 8601).
  ts: 'timestamp',
});

/**
 * Canonical → legacy field name map. Primarily used by the lint check in
 * `tests/unit/event-field-migration.test.js` to reject emit sites that
 * introduce *new* legacy names: a rogue field that is not a key here and
 * not a known canonical key is a drift candidate.
 *
 * @type {Readonly<Record<string, string>>}
 */
const NEW_TO_OLD = Object.freeze(
  Object.fromEntries(
    Object.entries(OLD_TO_NEW).map(([oldName, newName]) => [newName, oldName])
  )
);

module.exports = {
  OLD_TO_NEW,
  NEW_TO_OLD,
};
