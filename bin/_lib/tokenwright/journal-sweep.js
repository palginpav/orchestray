'use strict';

/**
 * journal-sweep.js — Pending journal TTL + size cap sweep (W4 §B4 / event 7).
 *
 * Pure function — no I/O. Caller reads the journal, calls sweepJournal(), then
 * writes the result back (and emits the truncationEvent if non-null).
 *
 * Sweep policy (applied in order):
 *   1. Drop entries with expires_at < Date.now()  (TTL sweep)
 *   2. If count > maxEntries, keep the most-recent maxEntries (count cap)
 *   3. If serialized bytes > maxBytes, keep tail entries that fit (size cap)
 *
 * The truncationEvent `trigger` field reports the "most severe" trigger that
 * fired: size_cap_10kb > count_cap_100 > ttl_sweep.
 */

/** Default TTL in hours (24 h). */
const DEFAULT_TTL_HOURS   = 24;
/** Default max journal bytes (10 KB). */
const DEFAULT_MAX_BYTES   = 10 * 1024;
/** Default max journal entries by count. */
const DEFAULT_MAX_ENTRIES = 100;

/**
 * Serialize a list of entries to the JSONL byte string that would be written
 * to disk, and return its byte length.
 *
 * @param {object[]} entries
 * @returns {number}
 */
function serializedBytes(entries) {
  return Buffer.byteLength(
    entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''),
    'utf8'
  );
}

/**
 * Sweep the pending journal.
 *
 * @param {object} params
 * @param {object[]}  params.entries     — parsed journal entries (array of objects)
 * @param {number}    [params.ttlHours]  — TTL in hours (default 24)
 * @param {number}    [params.maxBytes]  — max serialized bytes (default 10240)
 * @param {number}    [params.maxEntries] — max entry count (default 100)
 * @returns {{
 *   kept:            object[],
 *   truncationEvent: object|null
 * }}
 */
function sweepJournal({ entries, ttlHours, maxBytes, maxEntries }) {
  try {
    const effectiveTtlHours   = (typeof ttlHours   === 'number' && ttlHours   > 0) ? ttlHours   : DEFAULT_TTL_HOURS;
    const effectiveMaxBytes   = (typeof maxBytes    === 'number' && maxBytes   > 0) ? maxBytes   : DEFAULT_MAX_BYTES;
    const effectiveMaxEntries = (typeof maxEntries  === 'number' && maxEntries > 0) ? maxEntries : DEFAULT_MAX_ENTRIES;

    const inputEntries = Array.isArray(entries) ? entries : [];
    const entriesBefore = inputEntries.length;
    const bytesBefore   = serializedBytes(inputEntries);

    const nowMs   = Date.now();
    const ttlMs   = effectiveTtlHours * 3600 * 1000;

    // Track which truncation triggers fired
    let ttlFired   = false;
    let countFired = false;
    let sizeFired  = false;

    // Step 1: TTL sweep — drop entries with expires_at < now
    // Entries missing expires_at are treated as non-expired (backward compat —
    // W4 migration plan §7 states old entries default to now + 24h on first read).
    let kept = inputEntries.filter(e => {
      if (typeof e.expires_at !== 'number') return true; // backward compat: keep
      return e.expires_at >= nowMs;
    });
    if (kept.length < entriesBefore) ttlFired = true;

    // Step 2: Count cap — keep only the most-recent maxEntries
    if (kept.length > effectiveMaxEntries) {
      // Sort by timestamp descending (most recent first), keep head
      const sorted = kept.slice().sort((a, b) => {
        const ta = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : (a.ts_ms || 0);
        const tb = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : (b.ts_ms || 0);
        return tb - ta; // descending
      });
      kept = sorted.slice(0, effectiveMaxEntries);
      countFired = true;
    }

    // Step 3: Size cap — drop oldest entries until serialized bytes fit
    if (serializedBytes(kept) > effectiveMaxBytes) {
      // Kept is already sorted most-recent first from step 2 (or still in original order).
      // Ensure sort by timestamp descending so we keep the newest.
      const sorted = kept.slice().sort((a, b) => {
        const ta = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : (a.ts_ms || 0);
        const tb = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : (b.ts_ms || 0);
        return tb - ta; // descending
      });
      // Walk from most-recent and accumulate until we exceed maxBytes
      const fitting = [];
      for (const entry of sorted) {
        fitting.push(entry);
        if (serializedBytes(fitting) > effectiveMaxBytes) {
          fitting.pop();
          break;
        }
      }
      kept = fitting;
      sizeFired = true;
    }

    const entriesAfter = kept.length;
    const bytesAfter   = serializedBytes(kept);

    // Build truncation event only when something was actually removed
    let truncationEvent = null;
    if (entriesAfter < entriesBefore) {
      // Determine most-severe trigger (priority: size > count > ttl)
      let trigger;
      if (sizeFired)       trigger = 'size_cap_10kb';
      else if (countFired) trigger = 'count_cap_100';
      else                 trigger = 'ttl_sweep';

      truncationEvent = {
        type:             'tokenwright_journal_truncated',
        event_type:       'tokenwright_journal_truncated',
        schema_version:   1,
        version:          1,
        timestamp:        new Date(nowMs).toISOString(),
        entries_before:   entriesBefore,
        entries_after:    entriesAfter,
        bytes_before:     bytesBefore,
        bytes_after:      bytesAfter,
        trigger,
      };
    }

    return { kept, truncationEvent };
  } catch (_e) {
    // Fail-safe: return all entries unmodified on error
    return { kept: Array.isArray(entries) ? entries : [], truncationEvent: null };
  }
}

module.exports = {
  sweepJournal,
  DEFAULT_TTL_HOURS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
};
