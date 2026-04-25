---
section: Tier 2 — Block A Zone Contract
audience: pm, developer, architect
always_load: false
owner: architect
version: 1
---

# Block A Zone Contract (R-PIN, v2.1.14)

Defines the three-zone composition discipline for Block A — the stable PM
session-context bundle — and the rules that govern which content lives in
which zone.

---

## 1. Zone Map

Block A is composed by `bin/compose-block-a.js` (UserPromptSubmit hook) in this
strict order:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ZONE 1 — Frozen (1h TTL, cache_control breakpoint at tail)         │
│  • CLAUDE.md (user instructions + project intent)                   │
│  • agents/pm-reference/handoff-contract.md                          │
│  • Static skills list (from .orchestray/config.json skills)          │
│  • Event-schema shadow (from R-SHDW, if present)                    │
│                                                                      │
│  Invariant: byte-identical for the entire session unless an explicit │
│  invalidation is issued via bin/invalidate-block-a-zone1.js.        │
├─────────────────────────────────────────────────────────────────────┤
│  ZONE 2 — Per-orchestration pinned (1h TTL, cache_control at tail)  │
│  • Orchestration header (id, goal, constraints, orch_created_at)    │
│  • Decomposition summary (keyed by orchestration_id)                │
│                                                                      │
│  Invariant: byte-identical within one orchestration; resets when a  │
│  new orchestration starts.                                           │
├─────────────────────────────────────────────────────────────────────┤
│  ZONE 3 — Mutable (no cache_control — normal billing every turn)    │
│  • Recent agent output summaries                                     │
│  • Session banners (feature-quarantine notices, upgrade reminders)  │
│  • Phase indicators and turn-scoped handoff deltas                  │
│                                                                      │
│  Changes every turn; intentionally not cached.                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Breakpoint Budget

Anthropic supports at most **4 `cache_control` breakpoints** per request.
R-PIN reserves **3** for Zone 1, Zone 2, and the tools array tail. One slot
is reserved for future use.

| Slot | Assignment | TTL |
|------|-----------|-----|
| 1 | Zone 1 tail | 1h |
| 2 | Zone 2 tail | 1h |
| 3 | Tools array tail (existing) | 1h |
| 4 | **RESERVED** — future feature | — |

**Rule:** any Tier-2 addition that wants a new breakpoint must displace an
existing slot or consume the reserved slot, with architect sign-off. Adding
a 5th breakpoint silently causes Anthropic to drop the oldest, invalidating
the intended cache structure.

---

## 3. Zone Assignment Decision Tree

When deciding where new content belongs:

```
Is the content identical across all turns in all orchestrations
for this project?
  YES → Zone 1 (frozen). Never put timestamps, UUIDs, or per-turn
         values here. If the content mutates, Zone 1 is WRONG.
  NO  → Is it stable within a single orchestration (same goal/id)?
          YES → Zone 2 (per-orch-pinned). Use the orchestration_id
                as the implicit cache key. Decomposition summaries
                go here; don't put turn counts or mutable state.
          NO  → Zone 3 (mutable). Always goes here: agent outputs,
                banners, current phase, handoff deltas.
```

**Disqualifiers for Zone 1:** any value that can change mid-session
(user edits CLAUDE.md, config changes, plugin updates). When a Zone 1
source changes, call `bin/invalidate-block-a-zone1.js` to mint a new
breakpoint cleanly.

---

## 4. Zone 1 Content Rules

Zone 1 must be **byte-stable** to get cache hits. These rules are
enforced by the cache-invariant validator:

1. No timestamps inside Zone 1 content.
2. No orchestration IDs, turn numbers, or agent counts.
3. No dynamic feature-gate states.
4. CLAUDE.md is included verbatim (not summarized).
5. handoff-contract.md is included verbatim.
6. Schema shadow is included verbatim from the shadow JSON file.
   If the shadow file is absent or stale, Zone 1 is emitted without it
   (graceful degradation).

---

## 5. Zone 2 Content Rules

Zone 2 is keyed by orchestration_id:

1. Orchestration header: `orchestration_id`, `goal`, `constraints` — set
   at decomposition, never modified after that.
2. Decomposition summary: written once, frozen for the orch lifetime.
3. No per-turn agent outputs (those belong in Zone 3).

---

## 6. `cache_control` Marker Mechanism

Claude Code's `UserPromptSubmit` hook output uses `additionalContext` (a
plain text string injected before the user's message). The hook payload
does not directly support per-block `cache_control` objects — that is a
Claude API / Messages API concept, not a hooks API concept.

**R-PIN implementation approach:** the zones are emitted as clearly
delimited text sections in `additionalContext` with XML-style boundary
markers:

```
<block-a-zone-1 cache_hint="stable-1h">
... content ...
</block-a-zone-1>

<block-a-zone-2 cache_hint="per-orch-1h">
... content ...
</block-a-zone-2>

<block-a-zone-3 cache_hint="mutable">
... content ...
</block-a-zone-3>
```

The markers signal to the PM the zone boundary and caching intent, even
though Claude Code does not directly honor `cache_control` inside hook
`additionalContext`. This establishes the zone discipline on the PM
prompt-assembly side and allows the validator to monitor Zone 1 byte
stability. When Claude Code exposes per-block `cache_control` in
`additionalContext`, this contract will be updated and the markers will
carry the actual breakpoints.

---

## 7. Kill Switch

Disable zone caching without removing the hook:

```json
// .orchestray/config.json
{
  "block_a_zone_caching": {
    "enabled": false
  }
}
```

Or set env var `ORCHESTRAY_DISABLE_BLOCK_A_ZONES=1`.

When disabled, `compose-block-a.js` emits the context without zone markers
(falls back to passive 1h caching behavior from v2.1.10).

Auto-disable threshold: `invariant_violation_threshold_24h` (default 5).
If `cache_invariant_broken` fires 5+ times in 24 hours, the sentinel
`.orchestray/state/.block-a-zone-caching-disabled` is written and the
compose hook treats it as `enabled: false` until manual re-enable.

---

## 8. Invariant Validator

`bin/validate-cache-invariant.js` (PreToolUse hook) computes a SHA-256
hash of Zone 1 source files on every tool call and compares against
`.orchestray/state/block-a-zones.json`. A mismatch emits
`cache_invariant_broken` and logs the specific source file and hash delta.

The validator is **advisory only** (exits 0). It does NOT block tool calls.
It exists to surface accidental Zone 1 mutations early so they can be
corrected before accumulating session cost from stale cache reads.

---

## 9. Adding Future Tier-2 Features

When adding a new Tier-2 feature that introduces PM context content:

1. Apply the decision tree (§3) to determine the zone.
2. If Zone 1: add to the `ZONE1_SOURCES` array in `compose-block-a.js`
   and confirm the content is byte-stable. Run the validator in a test.
3. If Zone 2: add to the `buildZone2()` function.
4. If Zone 3: add to the `buildZone3()` function.
5. Document the addition in this file under the zone map (§1).
6. If a new cache breakpoint is required, consult §2 on budget.
