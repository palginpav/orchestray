<!-- PM Reference: Loaded when v2017_experiments.prompt_caching === "on" AND about to spawn subagents -->

# Prompt Caching Protocol

Defines the Block A / B / C prefix-stability discipline for `agents/pm.md`, the
`cache-prefix-lock.js` drift detector, and operator responses to `prefix_drift` events.

---

## 1. When This File Is Loaded

Load this file when ALL of the following are true:

- `v2017_experiments.prompt_caching` equals `"on"` in `.orchestray/config.json`
- You are about to spawn one or more subagents this turn

Do NOT load this file on every turn. It is relevant only when spawning subagents while
the experiment flag is active.

---

## 2. Cache geometry (v2.2.0 — engineered breakpoints)

`agents/pm.md` and the assembled `additionalContext` payload form a layered
prefix. Claude Code's automatic prompt caching rewards a stable prefix — if the
prefix is identical across turns, the cached version is reused. If it changes,
the cache miss covers the entire prefix.

v2.2.0 (P2.1) introduces a 4-slot manifest geometry built on top of the
existing zone discipline:

```
┌──────────────────────────────────────────────────────────┐
│  BLOCK-Z — Tier-0 immutable (Slot 1, TTL 1h)             │
│  pm.md + CLAUDE.md + handoff-contract.md + phase-contract│
│  Byte-stable across sessions. Changes only on releases.  │
├──────────────────────────────────────────────────────────┤
│  ZONE 1 — Frozen Tier-0 sidecar                          │
│  schema-shadow + (already-counted contract files)        │
├──────────────────────────────────────────────────────────┤
│  ZONE 2 — Per-orch (Slot 2, TTL 1h)                      │
│  orchestration-header + decomposition-summary            │
├──────────────────────────────────────────────────────────┤
│  ZONE 3 head — Per-turn boundary (Slot 3, TTL 5m)        │
│  Marker anchors before per-turn delta                    │
├──────────────────────────────────────────────────────────┤
│  ZONE 3 — Mutable (Slot 4 candidate region, TTL 5m)      │
│  Per-turn artifacts ≥ 1 KB (P3.2 / P3.1 fillers)         │
└──────────────────────────────────────────────────────────┘
```

**Key property:** Claude Code controls where it places `cache_control` breakpoints
internally. Orchestray cannot inject explicit `cache_control` markers through
frontmatter fields or CLAUDE.md directives (see §6 below). The 4-slot manifest
is therefore a *byte-discipline* mechanism — it persists `marker_byte_offset`s
that Anthropic's automatic placement WILL land near, AND those offsets are
asserted monotonic by the validator. An unchanged Block-Z means automatic
caching can reuse it; a mutated one is a full cache miss regardless of intent.

## 2.5 TTL auto-downgrade for short orchestrations

Slot 1 and Slot 2 default to `1h` TTL. The 1h cache write costs 2× the base
input rate (W1 §Q4); the 5m write costs 1.25×. Break-even on the 1h vs 5m
write is at roughly 6.6 reads — meaning a short orchestration (<25 minutes,
typically ~3–5 PM turns) NEVER amortises the 1h penalty.

`bin/_lib/cache-breakpoint-manifest.js` reads
`pm_protocol.estimated_orch_duration_minutes` from the current orchestration
JSON and downgrades Slot 1 and Slot 2 to TTL `5m` when duration < 25 minutes.
Long orchestrations (default behaviour) keep `1h` TTL. The downgrade emits
`cache_breakpoint_emit { ttl: '5m', slot: 1, ttl_downgrade_applied: true }` so
it is observable in `events.jsonl`.

This protects against W7-dossier P2.1 Risk #2 (1h writes net-lose money on
short orchestrations).

### Legacy Block A / B / C model (pre-v2.2.0)

Pre-v2.2.0 documentation framed the prefix as three regions (Block A
immutable / Block B per-orch / Block C variable). The 4-slot manifest
supersedes this framing — Block A maps onto Block-Z + Zone 1, Block B onto
Zone 2, and Block C onto Zone 3. The legacy `<!-- ORCHESTRAY_BLOCK_A_END -->`
sentinel and `cache-prefix-lock.js` drift detector remain in place as a
parallel guard.

---

## 3. What You Must NOT Do (PM Discipline Rules)

These rules prevent Block A drift during an orchestration:

- **Do not re-read `agents/pm.md` between turns.** Reading the file mid-session does
  not reload the loaded prompt, but it signals an intent to reference potentially
  changed content. This is a no-op at best and confusing at worst.

- **Do not inject Tier-2 file content into Block A.** Tier-2 files are loaded into
  your working context; they must never be spliced into the pm.md body mid-session.
  The loaded pm.md body is fixed at session start.

- **Do not mutate Block A by editing content above the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel mid-orchestration.**
  If a release or refactor requires those lines to change, it must happen between
  orchestrations, not during one.

- **Do not add dynamic content (timestamps, orch IDs, agent counts) to sections
  0–11.** Dynamic values belong in Block B (task context) or Block C (turn history).

- **Block B may be appended but not modified.** Task decomposition is written once.
  Do not revise the decomposition section after agents have started executing.

- **The Block A boundary is SENTINEL-based.** `cache-prefix-lock.js` and
  `tests/pm-md-prefix-stability.test.js` both hash everything from start-of-file
  through (and including) the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel. The Block A boundary is checked by the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel (currently near pm.md line 1328 — verify with `grep -n ORCHESTRAY_BLOCK_A_END agents/pm.md`). Keep the sentinel close to the end of the stable Tier-0 core so the cache prefix stays small; do not move it without re-pinning the hash in the same commit.

---

## 4. Drift Detection: How `cache-prefix-lock.js` Works

`bin/cache-prefix-lock.js` is a `UserPromptSubmit` hook. On each user turn:

1. Reads `agents/pm.md` from start-of-file up to and including the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel.
2. Computes a SHA-256 hash of that content.
3. Compares against the persisted hash in `.orchestray/state/.block-a-hash`.
4. **Happy path** (no drift): exits 0, emits empty `{}` — no `additionalContext`.
5. **Drift detected**: exits 2, emits a `prefix_drift` audit event to
   `.orchestray/audit/events.jsonl`, emits empty `{}` (never injects context —
   this is critical; the hook must not itself mutate the prefix it guards).

The hook is fail-open: any exception (file missing, hash read error) exits 0
silently rather than blocking the user prompt.

The hook no-ops immediately when `v2017_experiments.prompt_caching` is not `"on"`,
matching the behavior specified in §5.4 of the Phase 2 design.

**Timing budget:** ≤ 3 ms per invocation. Hook timeout in `hooks/hooks.json`: 5 s.

---

## 5. Interpreting `prefix_drift` in Analytics

`/orchestray:analytics` (v2, shipped in Phase 1 / S5) surfaces `prefix_drift` events
under the **Cache Performance** section. What counts:

- **`prefix_drift` event count = 0 over a 14-day window** — healthy; Block A is
  stable as intended.
- **One or more `prefix_drift` events** — investigate. See §6.

The `prefix_drift` event schema (see `agents/pm-reference/event-schemas.md`):

```json
{
  "type": "prefix_drift",
  "ts": "<ISO-8601>",
  "old_hash": "<sha256-hex>",
  "new_hash": "<sha256-hex>",
  "orch_id": "<string or null>"
}
```

---

## 6. Honest Framing: What This Protocol Actually Does

Read this before drawing conclusions from cache metrics:

- **Baseline subagent cache-hit ratio: 0.94** (measured; see
  `.orchestray/kb/artifacts/v2017-baseline-measured.md`). There is almost no
  headroom to improve. S1 / this protocol is *defensive hygiene*, not a
  cost-reduction mechanism.

- **Caller-side `cache_control` markers are not API-injectable from a UserPromptSubmit
  hook.** Claude Code's `additionalContext` output is plain text; the Messages API
  `cache_control` JSON blocks cannot be embedded by a hook. This was verified at
  v2.0.17 (`.orchestray/kb/artifacts/v2017-oq1-probe.md`). The
  `<!-- cache_breakpoint -->` sentinel in `agents/pm.md` is a discipline landmark
  for human reviewers, not a mechanical API breakpoint.

- **What v2.2.0 adds is BYTE-DISCIPLINE, not marker injection.** The
  `bin/_lib/cache-breakpoint-manifest.js` module computes a 4-slot manifest of
  byte offsets where Anthropic's automatic placement WILL land near, and
  `bin/validate-cache-invariant.js --manifest` enforces that those offsets stay
  monotonically-stable across turns. The XML wrapper tags
  (`<block-z>`, `<block-a-zone-1>`, etc.) emitted by `bin/compose-block-a.js`
  are landmarks for that byte discipline, not API breakpoints.

- **Env kill switches.** Two new env vars short-circuit P2.1 in-session:
  `ORCHESTRAY_DISABLE_BLOCK_Z=1` (compose-block-a falls through to today's
  3-zone payload) and `ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS=1` (manifest
  computation is skipped; the new UserPromptSubmit invariant becomes a no-op).
  Persistent disable: flip `caching.block_z.enabled` /
  `caching.engineered_breakpoints.enabled` to `false` in `.orchestray/config.json`.

- **Claude Code manages caching automatically.** It places its own `cache_control`
  breakpoints internally. A stable Block A prefix is rewarded by this automatic
  mechanism; an unstable one is penalized. That indirect relationship is the only
  lever available to Orchestray.

- **PM cache-hit ratio is observational only.** The PM-turn capture path shipped in
  Phase 1. No GA threshold has been set for PM cache-hit; the real baseline will
  not exist until v2.0.18 accumulates 7+ days of PM-turn data.

---

## 7. Operator Actions on Drift

If `prefix_drift` events appear in analytics:

### 7.1 Identify the cause

```
# Compare the hashes in the event to git history
git log --oneline agents/pm.md
# Compute the Block A hash exactly the way the hook and the test both compute it.
# Preferred: run the stability test — it asserts pinned == computed:
node --test tests/pm-md-prefix-stability.test.js

# Ad-hoc hash-only invocation (matches the hook's `indexOf+slice` byte-for-byte):
node -e "const fs=require('fs'),crypto=require('crypto');const c=fs.readFileSync('agents/pm.md','utf8');const s='<!-- ORCHESTRAY_BLOCK_A_END -->';const i=c.indexOf(s);console.log(crypto.createHash('sha256').update(c.slice(0,i+s.length),'utf8').digest('hex').slice(0,16));"
```

Common causes:
- A `release:` commit changed Block A content (expected, requires hash reset).
- A refactor touched sections 0–11 without updating the hash (legitimate change,
  requires hash reset).
- An unintended edit snuck into Block A (investigate and revert if needed).

### 7.2 Reset the hash after legitimate changes

After a confirmed legitimate Block A change (e.g., a release commit), reset the
persisted hash so future turns use the new baseline:

```bash
rm .orchestray/state/.block-a-hash
```

The hook will recompute and persist a new hash on the next `UserPromptSubmit` turn.

### 7.3 Pre-commit guard (opt-in)

`bin/install-pre-commit-guard.sh` installs a `.git/hooks/pre-commit` that rejects
commits that change pm.md Block A (everything before `<!-- ORCHESTRAY_BLOCK_A_END -->`)
without a `BLOCK-A: approved` line in the commit message. Install via:

```bash
node bin/install.js --pre-commit-guard
```

This guard never overwrites a user-managed pre-commit hook. It is optional but
recommended for teams actively developing Orchestray.

### 7.4 Pre-commit Block A hash assertion

Before shipping any `pm.md` edit, assert that the Block A hash still matches the
pinned value. Check:

```bash
# Fail if the Block A hash in pm.md no longer matches the pinned value.
node --test tests/pm-md-prefix-stability.test.js
```

---

## 8. Rollback

To disable the protocol without removing it:

```bash
# Disable the experiment (hook no-ops immediately):
/orchestray:config set v2017_experiments.prompt_caching off

# Or use the global kill-switch:
/orchestray:config set v2017_experiments.global_kill_switch true
```

With `v2017_experiments.prompt_caching` not `"on"`, the `cache-prefix-lock.js` hook
exits 0 immediately. The Block A / B / C layout in `agents/pm.md` remains in place but
the sentinel is decorative only.

---

## 10. 1-hour TTL activation (v2.1.10)

### Default behaviour

As of v2.1.10, Orchestray sets `ENABLE_PROMPT_CACHING_1H=1` in `settings.json` by
default. This tells Claude Code (≥2.1.108) to keep cached prompt prefixes alive for
1 hour instead of the default 5-minute TTL.

The config flag `prompt_caching.ttl_1h_enabled` (default `true` in
`.orchestray/config.json`) controls whether the installer includes this env key.
If you set the flag to `false` and re-run the installer, the env key is omitted on
the next install.

### Why this matters: break-even analysis

Consider a representative long orchestration: 10 turns, 30-minute wall time,
50 000-token cacheable prefix (Block A + stable Tier-0 body).

**5-minute TTL (old default) — every turn is a cache write:**

```
10 turns × 50 000 tokens × 1.25× write multiplier = 625 000 effective tokens
```

**1-hour TTL (new default) — first turn writes, subsequent nine turns read:**

```
1 write:  50 000 × 2.0× write multiplier  = 100 000 effective tokens
9 reads:  50 000 × 0.1× read multiplier   =  45 000 effective tokens
Total:                                       145 000 effective tokens
```

**Saving: (625 000 − 145 000) / 625 000 ≈ 77%** on the cacheable portion, or
**15–30%** on total input tokens across a session (W1 matrix row 36).

Break-even point: ≥ 2 reads within the 1-hour window. Orchestray orchestrations are
multi-turn by definition, so the break-even condition is always satisfied.

The only scenario where the 1-hour TTL is a net cost increase is a single-turn
invocation that never reads the cache back. Orchestray's minimum viable orchestration
(2 turns — PM + one agent) already exceeds break-even.

### Rollback

`FORCE_PROMPT_CACHING_5M=1` (native Claude Code env var, W1 row 37) reverts to
5-minute TTL without any Orchestray code change and without restarting the session.

```bash
# Temporary — single session:
FORCE_PROMPT_CACHING_5M=1 claude

# Persistent — add to your shell profile or settings.json env block:
# "FORCE_PROMPT_CACHING_5M": "1"
```

To permanently opt out, set `prompt_caching.ttl_1h_enabled: false` in
`.orchestray/config.json` and re-run `node bin/install.js`.

### Claude Code version floor

`ENABLE_PROMPT_CACHING_1H` requires Claude Code **≥2.1.108** (W1 row 36). Orchestray's
documented working floor (CLAUDE.md) is 2.1.111, which already satisfies this
requirement. No user-visible version bump is required for v2.1.10.

---

## 9. Cross-References

- `bin/cache-prefix-lock.js` — UserPromptSubmit hook implementation
- `.orchestray/state/.block-a-hash` — persisted Block A hash (auto-created)
- `.orchestray/kb/artifacts/v2017-baseline-measured.md` — measured baseline
  (subagent cache-hit 0.94, median orch cost $11.42)
- `.orchestray/kb/artifacts/v2017-oq1-probe.md` — IGNORED verdict on
  caller-side `cache_control` markers
- `v2017_experiments.prompt_caching` flag in `.orchestray/config.json`
- `agents/pm-reference/event-schemas.md` — `prefix_drift` event schema
- `/orchestray:analytics` — **Cache Performance** section for drift event counts
- `bin/_lib/block-z.js` — Block-Z deterministic prefix builder (P2.1, v2.2.0)
- `bin/_lib/cache-breakpoint-manifest.js` — 4-slot manifest builder with TTL
  auto-downgrade (P2.1, v2.2.0)
- `.orchestray/state/cache-breakpoint-manifest.json` — persisted manifest read
  by the manifest invariant validator (P2.1, v2.2.0)
