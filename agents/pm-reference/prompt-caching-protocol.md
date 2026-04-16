<!-- PM Reference: Loaded when v2017_experiments.prompt_caching === "on" AND about to spawn subagents -->

# Prompt Caching Protocol

Defines the Block A / B / C prefix-stability discipline for `agents/pm.md`, the
`cache-prefix-lock.js` drift detector, and operator responses to `prefix_drift` events.

---

## 1. When This File Is Loaded

Load this file when ALL of the following are true:

- `v2017_experiments.prompt_caching` equals `"on"` in `.orchestray/config.json`
- `cache_choreography.enabled` equals `true` in `.orchestray/config.json`
- You are about to spawn one or more subagents this turn

Do NOT load this file on every turn. It is relevant only when spawning subagents while
the experiment flag is active.

---

## 2. Block A / B / C Mental Model

`agents/pm.md` is divided into three logical regions. Claude Code's automatic prompt
caching rewards a stable prefix — if the prefix is identical across turns, the cached
version is reused. If it changes, the cache miss covers the entire prefix.

```
┌─────────────────────────────────────────────────────┐
│  BLOCK A — Immutable prefix                         │
│  Frontmatter + CLAUDE.md content + Tier-0 body      │
│  (sections 0–11, stable across all orchestrations)  │
│  <!-- cache_breakpoint --> sentinel                  │
├─────────────────────────────────────────────────────┤
│  BLOCK B — Orchestration-stable context             │
│  Task description + decomposition + task graph      │
│  (set once at orchestration start; unchanged after) │
├─────────────────────────────────────────────────────┤
│  BLOCK C — Variable tail                            │
│  Agent history, tool results, conversation turns    │
│  (changes every turn; never cached across turns)   │
└─────────────────────────────────────────────────────┘
```

**Key property:** Claude Code controls where it places `cache_control` breakpoints
internally. Orchestray cannot inject explicit breakpoints through frontmatter fields
or CLAUDE.md directives (see §6 below). Block A's value is therefore *stability*, not
marker placement. An unchanged Block A means Claude Code's automatic caching can reuse
it. A mutated Block A means a full cache miss regardless of intent.

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
  through (and including) the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel. The Block A boundary is checked by the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel (currently at pm.md line ~909). Keep the sentinel close to the end of the stable Tier-0 core so the cache prefix stays small; do not move it without re-pinning the hash in the same commit.

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

The hook no-ops immediately when `cache_choreography.enabled` is `false`,
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

- **Caller-side `cache_control` markers are IGNORED by Claude Code.** The OQ-1
  investigation (`.orchestray/kb/artifacts/v2017-oq1-probe.md`) established that
  `cache_control_marker` is not a supported frontmatter field. Claude Code silently
  drops unknown frontmatter fields before they reach the API request. The
  `<!-- cache_breakpoint -->` sentinel in `agents/pm.md` is a discipline landmark
  for human reviewers, not a mechanical API breakpoint.

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
# Disable hook (no-ops immediately):
/orchestray:config set cache_choreography.enabled false

# Or disable the entire experiment:
/orchestray:config set v2017_experiments.prompt_caching off

# Or use the global kill-switch:
/orchestray:config set v2017_experiments.global_kill_switch true
```

With `cache_choreography.enabled` false, the `cache-prefix-lock.js` hook exits 0
immediately. The Block A / B / C layout in `agents/pm.md` remains in place but
the sentinel is decorative only.

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
