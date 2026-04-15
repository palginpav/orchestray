# Changelog

All notable changes to Orchestray will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.0.15] - 2026-04-15

### Theme: "Harden what shipped in 2.0.14"

Correctness fixes across the Read cache-replay shield and the `cost_budget_check`
tool, a new `kb_write` MCP tool that eliminates KB index drift, prompt-injection
hardening on tool result excerpts, a more forgiving routing-gate match, and the
always-on pattern advisory.

### Added

- **`kb_write` MCP tool.** Atomically writes a KB artifact file and updates
  `.orchestray/kb/index.json` under a single exclusive lock. Fixes the long-standing
  drift where KB directories accumulated artifact files that were never registered in
  the index. Seeded enabled on fresh installs and backfilled automatically on upgrade.
  MCP tool count is now 9 (was 8 in 2.0.14).
- **Data-quality audit events.** When a pattern file is skipped because it lacks
  frontmatter, an `mcp_data_quality` event is now appended to `events.jsonl` alongside
  the existing stderr warning, so data-quality incidents are observable in post-run
  analysis.
- **`hook-warn` and `hook-strict` enforcement values.** The per-tool enforcement enum
  under `mcp_enforcement` now accepts `"hook-warn"` (always-on advisory) and
  `"hook-strict"` (opt-in blocking) in addition to `"hook"`, `"prompt"`, and `"allow"`.

### Changed

- **`cost_budget_check` now includes accumulated session spend.** Cap comparisons
  (`would_exceed_max_cost_usd`, `would_exceed_daily_cost_limit_usd`,
  `would_exceed_weekly_cost_limit_usd`) now sum prior `agent_stop` costs for the given
  `orchestration_id` before comparing against caps. Results will be more conservative
  than in 2.0.14 — that is the correct behaviour.
- **Tool result excerpts are sanitised.** Excerpts returned by `kb_search` and
  `pattern_find` are capped at 80 characters and stripped of markdown-special
  characters before inclusion, closing a prompt-injection surface.
- **`history_query_events` `agent_role` is now enum-validated.** Typos previously
  returned zero results silently; they now produce a validation error.
- **Routing gate matches on task identity.** The `PreToolUse:Agent` gate now matches
  spawns on `(task_id, agent_type)` — either supplied explicitly or derived from the
  leading `TASK-ID` token of the description — rather than requiring exact description
  text. Description drift no longer blocks valid spawns.
- **Pattern advisory is always on.** The `pattern_record_application` advisory emits
  regardless of `mcp_enforcement` config value. Previously suppressed when the config
  value was `"allow"`; now only the blocking-gate variant (planned for a future
  release) is suppressed by `"allow"`.
- **Server version is sourced from `package.json`.** `SERVER_VERSION` now reads from
  the package manifest at load time rather than a hardcoded string, eliminating drift
  on version bumps.

### Fixed

- **Read cache-replay shield (R14) — path normalisation.** A file accessed via a
  relative path and again via its absolute-path equivalent within the same session is
  now correctly recognised as the same file and deduplicated.
- **Read cache-replay shield (R14) — missing-file handling.** Reading a path that
  does not exist no longer caches a denial sentinel that could incorrectly block the
  same path once the file came into existence.
- **Read cache-replay shield (R14) — PDF page-range reads.** Repeated reads of the
  same PDF with different `pages` selections are no longer mis-identified as cache
  replays of a full-file read.
- **`pattern_record_skip_reason` audit gap.** The `PostToolUse` hook matcher now
  includes this tool, so skip-reason calls are audited consistently with the other
  MCP tools.
- **MCP tool audit event source of truth.** MCP tool audit events now prefer the
  `orchestration_id` supplied in the tool input over the filesystem-cached value,
  eliminating a corner case where the two could diverge during recovery.
- **`pattern_find` and `history_find_similar_tasks` result ordering.** Result order
  is now deterministic across Node.js versions (stable secondary sort on tied scores).
- **Upgrade-sweep migrations preserve newline shape.** Files rewritten by the
  upgrade sweep now retain the exact trailing-newline presence of the original.
- **Pattern-skip size-guard bypass is now observable.** When the `events.jsonl` scan
  is skipped because the file exceeds the 2 MB guard, an operator warning naming the
  orchestration is written to stderr instead of silently proceeding.
- **`cost_budget_check` input schema.** The `agent_type` field is now present on the
  input schema (previously documented but missing).

### Security

- **Prompt-injection hardening on tool excerpts.** `kb_search` and `pattern_find`
  excerpts are capped at 80 characters and markdown-special characters stripped before
  returning them, reducing the attack surface exposed by untrusted KB and pattern file
  content.
- **Session-ID sanitiser uses an allow-list.** The shield session-state path no longer
  accepts arbitrary session-ID characters; only a safe allow-list is permitted,
  preventing path-traversal via crafted IDs.
- **`kill_switch_reason` required when the kill switch is active.** Setting
  `mcp_enforcement.global_kill_switch: true` now requires a non-empty
  `kill_switch_reason` string. Blast-radius rationale is captured at the config level
  rather than reconstructed from logs.

### Deferred to a future release

- Default-flip of the `pattern_record_application` advisory to blocking mode
  (conditional on a follow-up false-positive review).
- An `orchestration://` read-only resource for live orchestration state.
- A `routing_lookup` MCP tool (superseded for this release by the routing-gate match
  relaxation above).
- A `cost_budget_reserve` MCP tool for pre-spawn budget holds.
- Activation of the `ask_user` `max_per_task` rate limit.

### Documentation

- The 2.0.14 entry referenced an incorrect path for the R14 shield session-state file.
  The actual path is `.orchestray/state/.shield-session-{session_id}.json`. The 2.0.14
  entry has been corrected in place.

### Upgrade notes

- **MCP tool count is now 9** (was 8). The new `kb_write` tool is seeded enabled on
  fresh installs and backfilled automatically by the upgrade sweep on existing installs.
- **`cost_budget_check` results will be more conservative.** The new accumulated-cost
  comparison is the intended behaviour; a session near its cap will now be flagged
  correctly.
- **Pattern advisory prints on every orchestration.** If you previously suppressed it
  with `mcp_enforcement.pattern_record_application: "allow"`, you will now see
  warn-level output regardless. The `"allow"` setting still suppresses the blocking
  gate (not yet enabled in this release).
- **R14 dedup now treats relative and absolute paths as equivalent.** If a workflow
  relied on re-reading the same file via two different path spellings within a session,
  the second read will now be deduplicated.
- **`global_kill_switch: true` now requires `kill_switch_reason`.** If you have the
  kill switch enabled in `.orchestray/config.json`, add a non-empty
  `kill_switch_reason` field; otherwise validation will fail on next config load.

Tests: 847 → 931.

---

## [2.0.14] - 2026-04-11

### Theme: "Close the §22c False-Positive Path"

Unblock the §22c advisory→blocking transition by closing the legitimate-skip signal
gap, add pre-spawn cost projection, and cut the two largest unchecked context taxes
(post-decision `pattern_find` ambiguity and `Read` cache-replay). Four work items
ship; one (§22c default flip) is explicitly deferred to 2.0.15 pending production
data from the N≥20 prerequisite installed here.

### Added

- **W1 — `pattern_record_skip_reason` MCP tool.** New tool at
  `bin/mcp-server/tools/pattern_record_skip_reason.js`, registered in
  `bin/mcp-server/server.js` TOOL_TABLE and `bin/mcp-server/lib/schemas.js`.
  When `pattern_find` returns results that do not shape a decomposition, the PM
  calls this tool (exactly once) instead of remaining silent — producing an
  auditable `mcp_tool_call` row with `tool: "pattern_record_skip_reason"`,
  `orchestration_id`, and a four-value `reason` enum (`all-irrelevant`,
  `all-low-confidence`, `all-stale`, `other`; `other` requires a mandatory `note`).
  `bin/record-pattern-skip.js` no longer emits the `pattern_record_skipped` advisory
  when a skip-reason call exists for the same `orchestration_id` in the pre-compact
  window — the skip is structurally accounted for. The tool is seeded in the
  `mcp_server.tools` enable map with default `true` on fresh installs (`bin/install.js`).

- **W2 — §22b probe-side prompt hardening.**
  `agents/pm-reference/tier1-orchestration.md` §22b now contains an explicit
  "MUST call EITHER `pattern_record_application` (one or more times) OR
  `pattern_record_skip_reason` (exactly once)" directive — not a suggestion.
  Fallback marker path documented for when the MCP tool is config-disabled: the PM
  writes `pattern_record_skipped_reason: <reason>` to
  `.orchestray/state/orchestration.md`. W2 is the sole owner of this fallback path.
  `agents/pm-reference/pattern-extraction.md` cross-references §22b so the two files
  do not drift. A golden-file test (`tests/pm-prompt-22b-hardening.test.js`) asserts
  the `MUST call either` directive and the fallback marker format are both present.

- **W3 — `cost_budget_check` MCP tool + pricing-table config seed.** New tool at
  `bin/mcp-server/tools/cost_budget_check.js`, registered after W1's TOOL_TABLE
  delta. Accepts `{agent_type, model, effort?, estimated_input_tokens?,
  estimated_output_tokens?}`; when token counts are omitted it computes defaults from
  historical `agent_spawn` averages. Returns `would_exceed_max_cost_usd`,
  `would_exceed_daily_cost_limit_usd`, estimated spawn cost, and warnings when no
  cap is configured. A centralized pricing table at
  `mcp_server.cost_budget_check.pricing_table` in `.orchestray/config.json` is seeded
  on fresh installs (`bin/install.js`): Haiku $1/$5, Sonnet $3/$15, Opus $5/$25, with
  a `last_verified` date for drift detection. `bin/collect-agent-metrics.js` now reads
  from the same config-resolver rather than carrying its own constants (single source
  of truth; eliminates the prior drift point flagged in CLAUDE.md). A new sub-operation
  in `bin/post-upgrade-sweep.js` backfills the pricing table block for pre-2.0.14
  installs, gated by an idempotent sentinel (same shape as 2.0.13's W8+W11 sub-ops).
  Schema additions in `bin/_lib/config-schema.js`.

- **W4 — CATRC: Cache-Aware Tool Result Compaction — new `bin/context-shield.js`
  hook + R14 rule.** Net-new infrastructure: `bin/context-shield.js` (new
  `PreToolUse:Read` hook script), `bin/_lib/shield-rules.js` (R14 rule module),
  `bin/_lib/shield-session-cache.js` (session-scoped manifest helper). On a second
  `Read` of the same `(file_path, mtime, size)` triple within a session with no
  `offset`/`limit` change, the hook returns `permissionDecision: "deny"` with a
  one-line hint pointing to the prior turn; re-reads with an explicit offset/limit or
  after a file-on-disk change are always `allow`-ed. `hooks/hooks.json` now contains
  a `PreToolUse` entry for the `Read` tool invoking `bin/context-shield.js`.
  Session-scoped state at `.orchestray/state/.shield-session-{session_id}.json`
  (corrected in 2.0.15; prior entry incorrectly stated `shield-session/{id}-reads.jsonl`)
  is archived by `bin/pre-compact-archive.js` at session end. New config flag
  `shield.r14_dedup_reads.enabled` (default `true`) seeded by `bin/install.js`;
  set to `false` to disable the rule without removing the hook. Schema addition in
  `bin/_lib/config-schema.js`.

### Deferred to 2.0.15

**§22c `pattern_record_application` advisory→blocking transition.** Deferred because
T1's pre-2.0.14 data snapshot showed N=3 non-skipped `pattern_find` rows — well below
the N≥20 prerequisite for a statistically meaningful false-positive analysis. 2.0.14
closes the signal gap (W1 legitimate-skip tool + W2 MUST directive) so the 2.0.15
scoping task has real K/F inputs to analyze. The transition will ship in 2.0.15 only
if the §22c confidence-feedback analysis over the post-2.0.14 audit window shows a
false-positive rate below a threshold to be set in 2.0.15's DESIGN.md.
Machine-readable status (historical, from the 2.0.14 design phase):
`transition_status: "no-go-data"`.

Also deferred:
- Any hook gate on `PreToolUse:Agent` enforcing `cost_budget_check` results (W3 ships
  advisory only; hard enforcement is 2.0.15 per T3 Part D forward contract)
- `mcp_enforcement.pattern_record_application: "hook-strict"` enum value (2.0.15)
- R1–R13 shield rules (T2 asserted these existed in v2.0.11; T5-r1 confirmed they do
  not; 2.0.14 ships R14 as the first and only rule in the new scaffold)
- Dedup across `Grep` or `Bash` tool calls (R14 is `Read`-only)

### Upgrade caveat / Recovery notes

**Automatic pricing-table migration on first 2.0.14 use.** The first
`UserPromptSubmit` after upgrade fires `bin/post-upgrade-sweep.js`, which now
includes a third sub-operation (W3) that backfills the
`mcp_server.cost_budget_check.pricing_table` block into `.orchestray/config.json` if
absent. Idempotent, sentineled at `.orchestray/state/.pricing-table-migrated-2014`,
fail-open. Manual rollback: delete the sentinel to re-run, or edit the config block
directly.

**Context-shield (W4) is on by default.** If re-reads that Claude Code previously
allowed start returning `deny` unexpectedly, set `shield.r14_dedup_reads.enabled: false`
in `.orchestray/config.json` to disable R14 without removing the hook. No session
restart required.

**MCP tool count is now 8** (was 6 in 2.0.13). New tools: `pattern_record_skip_reason`
and `cost_budget_check`. Both are seeded `enabled: true` in the `mcp_server.tools`
map on fresh installs; the upgrade sweep backfills them for existing installs.

**`bin/collect-agent-metrics.js` pricing is now config-driven.** If you had a
custom pricing override in the script directly (not standard usage but possible), the
script now reads from `mcp_server.cost_budget_check.pricing_table` in
`.orchestray/config.json`. Edit the config file to update pricing.

**Tested against Claude Code 2.1.59.**

Tests: 714 → 847 (+133 across W1/W2/W3/W4).

---

## [2.0.13] - 2026-04-11

### Theme: "Close the Loop"

Close 2.0.12's learning loop: the hook-enforced MCP surface now actually fires,
the gate's own blocking condition is self-consistent, and operational state files
stop growing unbounded.

### Added

- **W4 — Dispatch-name allowlist drift regression test.** `tests/gate-agent-spawn.test.js`
  now imports the `AGENT_DISPATCH_ALLOWLIST` and `SKIP_ALLOWLIST` constants from
  `bin/gate-agent-spawn.js` via regex and compares them to an embedded known-good
  manifest. When a future Claude Code version adds or removes a dispatch name, the
  test fails loudly with a message naming the three files to update in tandem (the
  code constant, the test manifest, `CLAUDE.md` if applicable). Closes 2.0.12 R5
  follow-up.

- **W5 — Configurable `events.jsonl` scan cap.** `bin/collect-agent-metrics.js`
  no longer hardcodes its scan threshold. New precedence chain:
  `ORCHESTRAY_MAX_EVENTS_BYTES` env var → `.orchestray/config.json`
  `audit.max_events_bytes_for_scan` → built-in default (materially larger than
  the 2.0.12 hardcode). The cap is read at hook-script load time per invocation —
  no session restart required to change it. New `audit` section added to
  `bin/_lib/config-schema.js` with validation.

- **W6 — Durable `events.jsonl` rotation with sentinel state machine.**
  `bin/_lib/events-rotate.js` is the new helper. At orchestration completion the
  PM cleanup sequence (tier1-orchestration.md Section 15, step 3) invokes
  `rotateEventsForOrchestration` which (a) filters the live `events.jsonl` to rows
  matching the current orchestration ID, (b) writes them to
  `.orchestray/history/<orch-id>/events.jsonl`, (c) atomically replaces the live
  file via a rename-dance preserving rows from other orchestrations. A three-state
  sentinel at `.orchestray/state/.events-rotation-<orch-id>.sentinel` makes the
  sequence crash-safe: `"started"` → restart from filter; `"archived"` → skip to
  truncate; `"truncated"` → delete sentinel only. `fs.truncateSync` is forbidden;
  a regression test asserts zero hits. Reader side (`history_scan.js`,
  `history_query_events`) is unchanged — archived rows remain queryable
  transparently.

- **W3 — `mcp_checkpoint_missing` audit event (promoted from RESERVED to
  IMPLEMENTED).** `bin/gate-agent-spawn.js` now emits a `mcp_checkpoint_missing`
  event to `events.jsonl` on every gate block. New `phase_mismatch` boolean field
  distinguishes genuine absence (`false`) from BUG-D phase-mismatch (`true`) — the
  latter is reachable when poisoned-phase rows coexist with genuine absences in the
  same orchestration. `agents/pm-reference/event-schemas.md` documents the
  IMPLEMENTED shape. Fails open on emission failure — the event write cannot mask a
  gate block.

- **W7 — Kill-switch health signal + `kill_switch_activated`/`kill_switch_deactivated`
  events.** `/orchestray:analytics` gains a Health Signals section that reads
  `.orchestray/config.json` and emits a bold warning when
  `mcp_enforcement.global_kill_switch === true`; it also scans recent `events.jsonl`
  for unpaired activation events. `/orchestray:config` set paths emit
  `kill_switch_activated`/`kill_switch_deactivated` events to `events.jsonl` (via
  `bin/emit-kill-switch-event.js`, a new CLI wrapper) whenever the switch value
  actually changes (no-op flips do not emit). Two new event shapes documented in
  `event-schemas.md`.

- **W8 + W11 — Post-upgrade sweep.** New `bin/post-upgrade-sweep.js` runs as a
  sibling under the existing `UserPromptSubmit` hook. Session-scoped lock at
  `/tmp/orchestray-sweep-<session>.lock` gives once-per-session fast-path;
  per-operation sentinels at `.orchestray/state/.config-migrated-2013` and
  `.orchestray/state/.mcp-checkpoint-migrated-2013` give once-per-upgrade
  semantics. Two sub-operations: (a) **W8** — additive migration of
  `.orchestray/config.json` to add the `mcp_enforcement` block if missing (preserves
  all other keys including non-schema `_note` fields); (b) **W11** — scan of
  `.orchestray/state/mcp-checkpoint.jsonl` to flip rows with
  `phase: 'post-decomposition'` that were poisoned by 2.0.12's BUG-B, based on a
  conservative timestamp heuristic (only flips rows where no matching `routing.jsonl`
  entry precedes them). Flipped rows gain a `_migrated_from_phase` audit marker.
  Fails open on every error; never blocks the user prompt. Replaces the 2.0.12 NG4
  "manual recovery only" stance.

- **W0 probe record.** `.orchestray/kb/artifacts/2013-posttooluse-probe-record.md`
  captures the Claude Code 2.1.59 `PostToolUse` payload shape for
  `mcp__orchestray__*` tools. Committed as a source of truth for the BUG-A fix
  (see W2 below). The probe revealed the real field is `event.tool_response`
  (a JSON string, not an object) — `event.tool_result`, which 2.0.12 read, is
  undefined. The artifact is the W2 implementation spec and the R1 pinned
  reference for the `tests/w2-smoke.test.js` contract.

### Fixed

- **BUG-A — `classifyOutcome` blindness (W2).** 2.0.12's
  `record-mcp-checkpoint.js` read `event.tool_result` which is undefined in
  CC 2.1.59. Every checkpoint row on disk showed `outcome: "skipped"`,
  `result_count: null`. The pattern-record-skipped advisory (which gated on
  `result_count >= 1`) was permanently dead code. W2 rewrites `classifyOutcome`
  to read `event.tool_response` (a JSON string), parses defensively (parse
  failure = `error`), and populates a new table-driven `extractResultCount`
  covering `pattern_find`, `kb_search`, and `history_find_similar_tasks`
  uniformly. The `pattern_record_skipped` advisory in `bin/record-pattern-skip.js`
  is rewired to gate on the now-populated `outcome === 'answered'` /
  `result_count >= 1` signals per the A-2 path in DESIGN §D2. A new smoke test
  at `tests/w2-smoke.test.js` exercises the end-to-end hook invocation against a
  real-shape PostToolUse payload — this is the test class that would have caught
  BUG-A in 2.0.12 had it existed. Historical pre-2.0.13 rows on disk retain their
  incorrect `outcome: "skipped"` classification — no migration is in scope; the
  sealed audit trail is immutable.

- **BUG-B — Phase derivation stale across orchestrations (W1).**
  `bin/record-mcp-checkpoint.js` derived `phase` from
  `fs.existsSync(routing.jsonl)` — a global file-presence check that ignored
  orchestration identity. Since `routing.jsonl` persists across orchestrations by
  design, every orchestration after the first in a project recorded its
  pre-decomposition MCP calls with `phase: "post-decomposition"`. W1 replaces the
  check with an orchestration-ID-scoped filter: read routing entries, count only
  those matching the current orchestration ID, return `"post-decomposition"` only
  if at least one matches. Fail-open to `"pre-decomposition"` on routing-file
  errors.

- **BUG-C — Gate phase-strict filter locks out repeat orchestrations (W1).**
  `bin/_lib/mcp-checkpoint.js` `missingRequiredToolsFromRows` defaults
  `phaseFilter = 'pre-decomposition'`. `bin/gate-agent-spawn.js` relied on the
  default. Combined with BUG-B, this gate-locked every second-or-later
  orchestration in any Orchestray project — the gate saw zero matching rows and
  blocked the first `Agent()` spawn. W1 passes `phaseFilter = null` explicitly
  at the gate call site with a `BUG-C-2.0.13` grep anchor comment blocking future
  reverts. Phase is now treated as an audit/analytics field, not an enforcement
  field. The default in `mcp-checkpoint.js` remains unchanged for potential future
  callers that want phase-strict behavior.

- **BUG-D — Gate diagnostic was actively misleading (W1).** When the gate blocked
  due to BUG-B+C, its stderr said "missing MCP checkpoint for pattern_find,
  kb_search, history_find_similar_tasks" — but the rows were in the ledger; they
  just had the wrong phase. A user reading the diagnostic would rerun the trio,
  write more wrong-phase rows, and loop forever. W1 adds a secondary phase-strict
  check that distinguishes true absence from phase mismatch and emits a distinct
  "phase mismatch" diagnostic in the latter case. Under the W1 BUG-C fix the
  phase-mismatch path is reachable only when legacy-poisoned rows coexist with
  genuinely-absent rows; the path is kept as defense-in-depth and feeds the W3
  `phase_mismatch` event field.

**BUG discovery context:** W1/W2/W3 were not identified by 2.0.12 review. They
were discovered on 2026-04-11 during the planning orchestration for 2.0.13, when
the PM ran the MCP trio for the first time in a project with an existing
`routing.jsonl` and its first `Agent()` spawn blocked. That single incident
revealed the full chain: BUG-B (phase poisoning) + BUG-C (gate strict-filter)
+ BUG-D (misleading message), plus surfaced BUG-A (classifyOutcome blindness)
for separate investigation. Original design notes lived in the 2.0.13 phase
directory (removed in 2.0.15 cleanup); the probe record remains at
`.orchestray/kb/artifacts/2013-posttooluse-probe-record.md`.

### Deferred to 2.0.14

**Deferred to 2.0.14: `pattern_record_application` advisory→blocking transition.** Depends on BUG-A fix validated in production across at least several orchestrations with non-null `outcome` / `result_count` data. 2.0.14 will ship the transition only if §22c confidence-feedback analysis over the post-2.0.13 audit window shows a false-positive rate of the `pattern_record_skipped` advisory below a threshold to be set in 2.0.14's DESIGN.md. The threshold and the evaluation window are not specified here — they are a 2.0.14 design decision — but the dependency on BUG-A being fixed and validated is a hard prerequisite.

Also deferred (per DESIGN §Non-goals):
- `ask_user` budget counter-hook (NG2 — zero overruns observed in 2.0.12 audit data)
- Empty-patterns-dir gate optimization (NG3 — directory is never empty in observable repos)
- No server-side MCP changes (NG5)
- No cron/daily rotation variants (NG6)

### Upgrade caveat / Recovery notes

**Automatic migration on first 2.0.13 use.** The first `UserPromptSubmit` after
upgrade fires `bin/post-upgrade-sweep.js`, which runs W8 (config `mcp_enforcement`
block) and W11 (ledger phase sweep). Both operations are idempotent, sentineled,
and fail-open — they cannot block the user prompt. Manual rollback: delete the
sentinels at `.orchestray/state/.config-migrated-2013` and
`.orchestray/state/.mcp-checkpoint-migrated-2013`.

**In-flight orchestration upgrade:** an orchestration that was decomposing when
2.0.13 landed continues to work because the gate is idempotent and all new hooks
fail open. The new `mcp_checkpoint_missing` event emission is additive — existing
consumers of `events.jsonl` who do not know the event type will simply ignore it.

**Kill-switch rollback still works** — `mcp_enforcement.global_kill_switch: true`
in `.orchestray/config.json` bypasses the 2.0.13 MCP checkpoint gate entirely
(now with BUG-B/C/D fixes applied). Per-tool `mcp_enforcement.<tool>: "prompt"`
also still works.

**Events.jsonl rotation** is PM-driven at orchestration-complete. A user whose
`events.jsonl` is already oversized at upgrade time: the W5 configurable cap
gives immediate cost-attribution relief (`ORCHESTRAY_MAX_EVENTS_BYTES` env var
OR `audit.max_events_bytes_for_scan` config key); the next orchestration to
complete triggers the durable W6 rotation which moves old rows to
`.orchestray/history/<orch-id>/events.jsonl`.

**Probe record reference.** The BUG-A fix depends on Claude Code 2.1.59's
`PostToolUse` payload shape for `mcp__orchestray__*` tools. The exact shape
captured during the 2.0.13 planning phase is at
`.orchestray/kb/artifacts/2013-posttooluse-probe-record.md`. If a future Claude
Code version renames `tool_response` or changes the MCP response envelope, the
`tests/w2-smoke.test.js` smoke test is the first thing that will fail.

**Tested against Claude Code 2.1.59.**

Tests: 631 → 714 (+83 across W1/W4/W5/W2/W3/W6/W7/W8+W11).

---

## [2.0.12] - 2026-04-11

### Theme: "Hook-Enforced MCP Surface"

Pre-decomposition retrieval becomes auditable, and the hook layer stops
trusting the dispatch name. The thesis: prompt compliance alone has failed
for retrieval-class MCP calls (`pattern_find`, `kb_search`,
`history_find_similar_tasks`, `pattern_record_application` had zero calls
across the full 2.0.11 audit history), exactly as prompt compliance failed
for model routing before 2.0.11. 2.0.12 closes both the retrieval gap and
the separately discovered Explore dispatch bypass using one architectural
principle: **every workflow-critical retrieval or spawn crosses a hook,
the hook writes a checkpoint, and the checkpoint is verified before the
next spawn.**

### Added

- **Hook-enforced MCP retrieval.** The four pre-decomposition MCP tools
  (`pattern_find`, `kb_search`, `history_find_similar_tasks`,
  `pattern_record_application`) that had zero calls across 2.0.11's full
  audit history are now hook-enforced via a new
  `.orchestray/state/mcp-checkpoint.jsonl` ledger. New hook script
  `bin/record-mcp-checkpoint.js` fires on each `PostToolUse` for the three
  required pre-decomposition tools and writes one row to the ledger plus one
  `mcp_checkpoint_recorded` event to `events.jsonl`. `gate-agent-spawn.js`
  reads the ledger before the first orchestration `Agent()` spawn and blocks
  (exit 2) with a diagnostic naming any missing required tool for the current
  `orchestration_id`. Closes the "PM forgets to call the tool" failure mode
  that 2.0.11's durable routing pattern proved the fix for.

- **Explicit dispatch allowlist in `gate-agent-spawn.js`.** The 2.0.11
  implicit `toolName !== 'Agent'` fail-open guard is replaced by an explicit
  `AGENT_DISPATCH_ALLOWLIST = {Agent, Explore, Task}` (tools that must be
  gated) and `SKIP_ALLOWLIST = {Bash, Read, Edit, Glob, Grep, Write, ...}`
  (tools that must be passed through). Any `tool_name` that appears in
  neither list is now handled according to the `mcp_enforcement.unknown_tool_policy`
  config flag, which defaults to `"block"` (fail-closed). A future Claude
  Code built-in that dispatches agents under an unknown name will produce a
  loud diagnostic naming the tool and the config key to flip — it will not
  silently bypass routing.

- **`hooks/hooks.json` matcher expansion.** `PreToolUse` and `PostToolUse`
  matchers grew from `"Agent"` to `"Agent|Explore|Task"` so Claude Code's
  built-in Explore and Task dispatches now flow through `gate-agent-spawn.js`
  (routing-entry validation + MCP checkpoint gate) and
  `emit-routing-outcome.js` (audit). Explore spawns now produce
  `routing_outcome` Variant A events with an added optional `tool_name` field
  so analytics can distinguish Explore from architect/developer spawns.

- **`mcp_enforcement` config block.** New nested section in
  `.orchestray/config.json` with per-tool enforcement mode toggles
  (`"hook" | "prompt" | "allow"`), `unknown_tool_policy`
  (`"block" | "warn" | "allow"`), and `global_kill_switch` (boolean).
  Defaults are frozen in `bin/_lib/config-schema.js` and merged at read
  time — no manual migration needed. The config is read stateless on every
  hook invocation, so **no session restart is required** to change any flag.
  `/orchestray:config` surfaces all keys and warns when `global_kill_switch`
  is `true`. Note: `pattern_record_application` is advisory only — not
  gate-enforced. Setting it to `"prompt"` or `"allow"` suppresses the
  `pattern_record_skipped` advisory event on PreCompact but has no effect
  on spawn gating (the gate only enforces `pattern_find`, `kb_search`,
  `history_find_similar_tasks`).

- **`record-pattern-skip.js` advisory on PreCompact.** Emits a
  `pattern_record_skipped` event once per orchestration if `pattern_find`
  returned ≥1 result but the PM never called `pattern_record_application`.
  Advisory only — does not block. Idempotent. Feeds the §22c confidence
  feedback loop as "no data this run" signal. Fires on the `PreCompact`
  hook (the closest available session-boundary event in Claude Code's
  current hook vocabulary) rather than `SubagentStop`, because the
  Orchestray PM is the main session agent — not a spawned subagent — so
  `SubagentStop` never fires for it.

- **New audit events:** `mcp_checkpoint_recorded` (per enforced MCP call,
  dual-written to the checkpoint ledger and `events.jsonl`) and
  `pattern_record_skipped` (advisory, emitted on `PreCompact` when
  `pattern_find` returned results but `pattern_record_application` was
  never called). A third event name, `mcp_checkpoint_missing`, is
  **RESERVED** — `gate-agent-spawn.js` currently blocks with a stderr
  diagnostic and `exit 2` only; the audit event is documented as a
  forward contract in `agents/pm-reference/event-schemas.md` and will be
  emitted in a follow-up release if analytics usage justifies it. The
  `routing_outcome` Variant A shape gains an optional `tool_name` field
  (backward-compatible; defaults to `"Agent"` when absent).

- **New shared module `bin/_lib/mcp-checkpoint.js`.** Reader and path helpers
  for `mcp-checkpoint.jsonl` — a single module instead of duplicating the
  "filter by orchestration_id + required-tool-set" logic across the writer
  and the gate.

- **From 2.0.11, folded into this release for README coverage.** The
  `mcp__orchestray__ask_user` MCP elicitation tool (mid-task structured
  ≤5-field form, pause-and-resume without unwinding orchestration) and durable
  hook-enforced model routing (`routing.jsonl` + `gate-agent-spawn.js`) were
  both shipped in 2.0.11 but the README was not swept at that release.
  README is now current for both releases in one pass.

### Fixed

- **Explore routing gap closed.** 2.0.11's `PreToolUse:Agent` hook matcher
  missed Claude Code's built-in `Explore` tool, which dispatches under
  `tool_name: "Explore"` rather than `"Agent"`. Explore spawns therefore
  bypassed model routing entirely — the hook never fired, so the model
  parameter was never validated and no `routing_outcome` event was emitted.
  The T2 diagnosis identified two independent bypass paths: (1) the
  `hooks.json` matcher covering only `"Agent"`, (2) the `gate-agent-spawn.js`
  early-exit on `toolName !== 'Agent'`. Both are closed in 2.0.12 via the
  matcher expansion and the explicit allowlist rewrite. Fix is folded into
  this release — no 2.0.11.1 patch.

- **`bin/emit-routing-outcome.js` coverage drift corrected.** The in-script
  `toolName !== 'Agent'` guard was load-bearing in 2.0.11 but would have
  silently blocked Explore/Task dispatches in the 2.0.12 matcher-expansion
  window until the T7 review caught it. The guard now uses the same explicit
  allowlist Set as `gate-agent-spawn.js`, with a `tool_name` field populated
  on the emitted `routing_outcome` Variant A event.

- **PM wire-check: pre-decomposition retrieval checklist and §22b.R re-entry
  instruction.** New Section 13 checklist in `tier1-orchestration.md` and
  a §22b.R sub-subsection give the PM an explicit re-entry path when
  `gate-agent-spawn.js` blocks with a missing-checkpoint diagnostic. Without
  this, the PM could loop retrying the spawn rather than re-running the
  retrieval sequence (R2 infinite-retry loop mitigation).

### Upgrade caveat / Recovery notes

**In-flight orchestrations upgrading to 2.0.12:** the new
`mcp-checkpoint.jsonl` gate fails open when the file is missing or has no
rows for the current orchestration, so a PM that was decomposing when the
upgrade landed will not be blocked on its next spawn. If the gate
unexpectedly blocks a spawn (e.g., the PM called `pattern_find` for this
orchestration but then skipped `kb_search`), set
`mcp_enforcement.kb_search: "prompt"` in `.orchestray/config.json` to fall
back to prompt-only for that tool, or set
`mcp_enforcement.global_kill_switch: true` to restore 2.0.11 enforcement
behavior entirely. **No session restart is required** — the hook re-reads
config on every invocation. To fully revert, delete
`.orchestray/state/mcp-checkpoint.jsonl` and set the kill switch.

To add a tool name that a future Claude Code built-in dispatches under, add
it to `AGENT_DISPATCH_ALLOWLIST` in `bin/gate-agent-spawn.js`, or set
`mcp_enforcement.unknown_tool_policy: "warn"` to restore the 2.0.11
fail-open behavior without editing any code.

**Tested against Claude Code 2.1.59.**

Tests: 569 → 631 (+62 across gate, checkpoint writer, allowlist,
pattern-record-skip, atomic-append IfAbsent helper, allowlist-sync,
and full-suite integration tests).

---

## [2.0.11] - 2026-04-10

### Added
- **Durable model routing.** PM routing decisions (model + effort + score
  per subtask) are now persisted to `.orchestray/state/routing.jsonl` at
  decomposition time and re-read per spawn. The `PreToolUse:Agent` hook
  at `bin/gate-agent-spawn.js` validates every `Agent()` call against the
  file — if the spawn's `model` parameter doesn't match the stored routing
  decision, the hook blocks with a clear diagnostic. This closes the
  long-session fragility where the PM would silently forget routing and
  fall back to the parent session's model (typically Opus), bypassing
  Section 19 entirely and blowing the cost budget. Routing is now
  **immortal** — it survives context compaction, session resumption,
  and PM forgetfulness because the PM reads its own decision fresh from
  the file every spawn, not from working memory. New helper
  `bin/_lib/routing-lookup.js` exposes `ROUTING_FILE`, `getRoutingFilePath`,
  `appendRoutingEntry`, `readRoutingEntries`, and `findRoutingEntry`.
  Matching is word-boundary aware (`"Fix auth"` does NOT match
  `"Fix authority"`) and rejects empty-description wildcards.
  `agents/pm.md` Section 13 and Section 19 updated with the hard rule:
  "The routing file is the SINGLE SOURCE OF TRUTH; do not trust your
  working memory." Dynamic spawns and re-planned tasks must append
  fresh entries — the hook matches most-recent timestamp. 30 new tests
  across `tests/gate-agent-spawn.test.js` (11 integration cases) and
  `tests/hooks/routing-lookup.test.js` (19 unit cases). Tests: 539 → 569.

### Durable routing — upgrade & recovery notes
- **In-flight orchestrations upgrading to 2.0.11:** a PM that was
  decomposing when the upgrade landed has no `routing.jsonl` file. The
  first post-upgrade `Agent()` call with a missing file falls through to
  the existing model-validity check (no new blocking). Once the PM starts
  writing entries, subsequent spawns must have matching entries or they
  are blocked. If an in-flight orchestration stalls on this check, delete
  `.orchestray/state/routing.jsonl` to fall back to the pre-2.0.11
  model-validity-only path and complete the current orchestration under
  the old semantics.
- **Corrupted `routing.jsonl` recovery:** if the file contains all
  garbage (every line fails JSON.parse), `readRoutingEntries` silently
  skips every line and returns an empty array. The hook then blocks with
  "no routing entry" rather than crashing or silently permitting unrouted
  spawns. Recovery: delete the file and re-run decomposition, or manually
  repair the file to have at least one valid JSON line.
- **`enable_regression_check` and `enable_static_analysis` removed**
  from the `agents/pm.md` Section 0 config defaults block. These keys
  were already unused at runtime (no consumer logic) and were flagged
  as dead config by prior audits. No behavior change for operators;
  the cleanup is purely documentation. Any tooling that scans
  `agents/pm.md` defaults should update its expectations.

- **New: `mcp__orchestray__ask_user` MCP tool.** Agents can pause mid-task to
  ask the user a structured ≤5-field form and resume with the answers, without
  unwinding the orchestration. Enabled for pm, architect, developer, and
  reviewer. Configuration under `mcp_server.tools.ask_user` in
  `.orchestray/config.json`.
- Plugin-bundled stdio MCP server at `bin/mcp-server/server.js` (Node 20
  stdlib only — no new npm deps). JSON-RPC 2.0 line-delimited framing;
  server-initiated `elicitation/create` with in-memory id correlation.
- Audit trail: every `ask_user` invocation appends one `mcp_tool_call` event
  to `.orchestray/audit/events.jsonl` with `outcome ∈ {answered, cancelled,
  declined, timeout, error}` and `form_fields_count`. No question or answer
  text is persisted.
- 28 new unit tests under `tests/mcp-server/` covering schema validation,
  audit-event shape, and the handler's decision rules (including timeout and
  cancel/decline branches) with an injected elicitation fake.

### Fixed
- **Model routing is now hook-enforced.** Previously, the PM was asked (by
  prompt) to pass `model: haiku|sonnet|opus` on every `Agent()` spawn during
  orchestrations and to emit a `routing_outcome` audit event. In practice
  the PM silently skipped both steps, so every subagent inherited the parent
  session's model (typically Opus), the UI showed no model badge next to
  running agents, and `model_used` was null on every `agent_stop` event —
  which made `bin/collect-agent-metrics.js` fall back to Sonnet rates and
  under-report cost. New `PreToolUse:Agent` hook at `bin/gate-agent-spawn.js`
  rejects (exit 2) any in-orchestration `Agent()` call missing `model` or
  using `model: "inherit"`. Companion `PostToolUse:Agent` hook at
  `bin/emit-routing-outcome.js` auto-appends a `routing_outcome` event with
  the assigned model, removing the prompt-compliance burden entirely. Both
  hooks no-op outside orchestrations and fail-open on unexpected errors.
- `agents/pm.md` Section 19 Transparency rewritten as a hard rule (was
  advisory). `agents/pm-reference/tier1-orchestration.md` Section 19 notes
  the PM no longer writes hook-covered fields manually but must still emit
  a PM-supplemented event for task_id, complexity_score, and final result.
- `agents/pm-reference/event-schemas.md` Section 19 now documents three
  `routing_outcome` variants — hook-emitted at spawn time (partial,
  `source: "hook"`), PM-supplemented after result processing (full,
  `source: "pm"`), and auto-emitted at completion (safety-net,
  `source: "subagent_stop"`) — with precedence rules and consumer guidance
  for downstream audit readers. Includes an explicit `agent_id` namespace
  warning: Variant C populates `agent_id` from two incompatible sources
  (subagent invocation ID vs team subtask label) and consumers MUST NOT
  cross-join on it.
- **Third-variant routing_outcome safety net.** `bin/collect-agent-metrics.js`
  now auto-emits a `routing_outcome` event with `source: "subagent_stop"`
  on every `SubagentStop` and `TaskCompleted` hook firing (when inside an
  orchestration), carrying orchestration_id, agent_type, agent_id, the
  resolved model assignment (looked up from the prior Variant A event),
  turns_used, token counts, and a heuristic `result` field
  (error/unknown/success). Guarantees pattern-extraction, replay analysis,
  and cost attribution always see a completion observation even if the
  hook-emitted Variant A lands and the PM-emitted Variant B drifts. Fails
  open and cannot block the existing `agent_stop` / `task_completed_metrics`
  write that follows.
- **`bin/emit-routing-outcome.js` tool_name guard.** The hook was missing
  an early-return when `tool_name !== "Agent"`, so during any active
  orchestration every `PostToolUse` event (Bash, Read, Edit, Grep, etc.)
  would have silently appended a bogus `routing_outcome` row to
  `.orchestray/audit/events.jsonl`, poisoning pattern extraction and cost
  attribution downstream. Added the guard, matching the pattern already in
  `bin/gate-agent-spawn.js`. Caught during review, not by the hook matcher
  itself — `matcher: "Agent"` in `hooks.json` IS honored per Claude Code
  hook docs (verified at code.claude.com/docs/en/hooks), but the in-script
  guard is load-bearing as a defense-in-depth measure.
- **Final audit pass — 28 fixes across correctness, security, and dead-code
  dimensions.** Four parallel audit agents (MCP server review, hook-script
  review, cross-cutting security, dead-code/wiring) surfaced 5 majors,
  14 warnings, and 12 info-level findings; every one was landed in two
  parallel fix rounds. Highlights:
  - **TOCTOU fix in `tools/pattern_record_application.js`** — two sequential
    `rewriteField` calls merged into a single read-modify-write so concurrent
    pattern applications no longer silently lose `times_applied` increments.
  - **Correct error code on `resources/history_resource.js` TOCTOU** — all
    four read paths now remap ENOENT from unguarded `readFileSync` to
    `RESOURCE_NOT_FOUND` (−32002) instead of falling through to
    `INTERNAL_ERROR` (−32603).
  - **`history_find_similar_tasks._bodyAfterH1`** — now actually skips to
    after the H1 line instead of returning frontmatter content, fixing
    silent similarity-score pollution.
  - **`install.js` hook dedup is matcher-aware** — two hook blocks for the
    same event with different matchers (e.g., `PreToolUse:Agent` and
    `PreToolUse:Bash`) are no longer conflated during reinstall.
  - **Crypto-random elicitation correlation IDs** — `server.js` replaces the
    sequential `nextElicitationId = 1` counter with
    `crypto.randomBytes(8).toString('hex')`. A compromised client can no
    longer spoof elicitation responses by guessing sequential ids.
  - **`pre-compact-archive.js` symlink skip** — the recursive task-copy
    walk now short-circuits on `entry.isSymbolicLink()` before copying,
    so a malicious symlink in `.orchestray/state/tasks/` cannot leak
    arbitrary file contents into the pre-compact snapshot.
  - **Safe-cwd hook helper `bin/_lib/resolve-project-cwd.js`** — centralizes
    `event.cwd` resolution with null-byte rejection and clean fallback to
    `process.cwd()`. Documented why stricter containment (requiring a
    pre-existing project marker) was rejected: it would break every
    first-ever hook run in a fresh project.
  - **Orchestration-state path helper `bin/_lib/orchestration-state.js`** —
    `.orchestray/audit/current-orchestration.json` is no longer hardcoded
    in seven separate scripts; one constant, one helper.
  - **`schemas.js` `startLen` bail** — `_validate` now tracks the error
    count at entry and bails only on errors accumulated in the current
    call frame. Fixes the bug where a prior sibling property's validation
    error silently skipped all subsequent siblings in the same object.
  - **`kb_resource.list()` descriptions** — resource list responses now
    populate `description` from the first H1 instead of hardcoding empty
    string. Consistent with `pattern_resource`.
  - **Dead config keys removed** — `enable_regression_check` and
    `enable_static_analysis` stripped from `.orchestray/config.json`,
    `agents/pm.md`, and `skills/orchestray:config/SKILL.md` (defaults
    block, Available Settings table, validator list, Quick Reference
    table — three subsections cleaned).
  - **Hook-script hardening (bulk)** — every stdin-reading hook script
    now has a `MAX_INPUT_BYTES = 1 MB` guard that drops and exits cleanly
    on oversized payloads (fails open per each script's normal success
    contract); every audit-dir-creating script now calls
    `fs.chmodSync(auditDir, 0o700)` best-effort after `mkdirSync` to
    restrict world-read on shared systems.
  - **MCP `resources/list` meta propagation** — `server.js` aggregation
    loop now forwards `_truncated` and `_totalCount` from any handler
    that reports them (today: `history_resource` caps archives at 20).
    Previously the handler exposed the meta but the dispatcher stripped
    it silently, so clients could not tell they were seeing a partial
    list.
  - **Consistency sweep** — `lib/audit.js` and `lib/history_scan.js`
    now import `logStderr` from `lib/rpc.js` instead of duplicating the
    `[orchestray-mcp]` prefix locally; `elicit/ask_user.js` emits
    audit events with `tool: "ask_user"` instead of
    `mcp__orchestray__ask_user` for consistency with other tool names;
    `pattern_resource` and `kb_resource` shape errors use
    `INVALID_URI` instead of `PATH_TRAVERSAL`; `history_find_similar_tasks`
    applies `assertSafeSegment` to `orchId`/`taskId` before path joins.
  - **Documentation tightening** — `agents/pm-reference/event-schemas.md`
    `routing_outcome` Variant C documents the `agent_id` cross-event
    namespace caveat; inline comments added in `kb_search.js` (ReDoS
    safety constraint), `schemas.js` (`additionalProperties` exclusion
    rationale), `frontmatter.js` / `atomic-append.js` / `install.js`
    (predictable lockfile/tmp-name single-user acceptability),
    `reassign-idle-teammate.js` (DEF-3 defect ID expanded to human
    rationale), `emit-routing-outcome.js` (`score: null` reserved for
    PM supplement), and `audit-event.js` (SubagentStop is intentionally
    handled by `collect-agent-metrics.js`, positional `start` arg is
    decorative).
- Test suite now at 539/539 across all additions. All audit fixes verified
  by diff-scoped final review; no regressions introduced across the two
  fix rounds.

### Added
- **Dedicated rpc.js unit tests.** `tests/mcp-server/lib/rpc.test.js` —
  43 test cases covering `parseLine` edge cases (empty/malformed/non-object
  JSON, array messages, long lines, unicode), `isResponse` variants,
  `writeFrame` including circular-reference handling, `sendError`/`sendResult`
  envelope shape, `logStderr` prefix + coercion, and numeric values of all
  six error code constants. Locks in the extraction contract from the
  refactor above.
- **Hook script tests.** `tests/gate-agent-spawn.test.js` and
  `tests/emit-routing-outcome.test.js` — 41 test cases across both files
  using `child_process.spawnSync` and isolated tmpdir fixtures. Cover tool
  name filtering (including the `Bash`/`Read`/`Edit` cases that would have
  caught the emit-routing-outcome bug above), outside-orchestration no-op,
  inside-orchestration block/allow paths, case-insensitive model matching,
  full model id normalization (`claude-opus-4-6` → `"opus"`), description
  truncation, atomic append of sequential events, and every fail-open path
  (malformed stdin, empty stdin, read-only audit dir).
- **Additional test hardening** — 6 more cases added as a final pass:
  (1) `writeFrame(null)` and `writeFrame(42)` primitive-argument behavior
  locked in as documentation tests — frame-shape validation is the caller's
  job, not `writeFrame`'s; (2) `gate-agent-spawn.js` `tool_input.tool`
  fallback branch tested (three cases covering Agent-via-fallback, Bash-via-fallback,
  and tool_name precedence over tool_input.tool); (3) concurrent-append
  correctness test for `emit-routing-outcome.js` — spawns 10 parallel hook
  invocations with distinct descriptions and asserts `atomicAppendJsonl`
  preserves all 10 as valid jsonl lines with no lost updates. Also hardened
  the `rpc.test.js` stdout/stderr capture pattern with null guards in every
  `afterEach` so a hypothetical `beforeEach` failure can't leave
  `process.stdout.write` / `process.stderr.write` swapped for subsequent
  tests.
- Test suite now at 539/539 across all additions (up from the 449 baseline
  at the start of v2.0.11 development).

### Changed
- **`bin/mcp-server/server.js` internal refactor.** JSON-RPC 2.0 wire
  plumbing (`writeFrame`, `sendError`, `sendResult`, `isResponse`,
  `logStderr`, `parseLine`, error-code constants) extracted into a new
  sibling module `bin/mcp-server/lib/rpc.js` (106 lines). `server.js`
  drops from 602 to 574 lines and now contains only domain-coupled
  dispatch, elicitation correlation, tool/resource tables, and the
  readline loop. Behavior-preserving; integration test suite stays green
  end-to-end (449 → 533 with the new dedicated rpc.js unit tests and
  hook-script tests layered on top). No protocol, wire, or API surface
  changes — this is purely internal restructuring to keep the MCP server
  module under a sane line budget as the Stage 2 tool and resource
  surface grows.
- **`package.json` test glob** now includes `tests/hooks/*.test.js` so
  hook-script tests placed in that subdirectory are picked up automatically
  without a glob update each time. Existing explicit subdirectory globs
  retained for the other test locations.

### Upgrade caveat
- **Restart your Claude Code session** (or run `/agents`) after upgrading to
  v2.0.11 before `mcp__orchestray__ask_user` becomes visible to agents.
  Claude Code caches agent definitions at session start, so the new `tools:`
  frontmatter entries on pm/architect/developer/reviewer won't take effect
  until a reload.

## [2.0.10] - 2026-04-10

### Theme: "The Self-Improving Orchestrator"

### Added
- **Orchestration Threads** — Cross-session continuity via thread summaries. After each orchestration, PM writes a compressed thread entry (domain tags, files touched, decisions, open items, next steps). Before decomposing new tasks, PM scans threads for semantic overlap and injects matching context as "Previously" section. Thread lifecycle: 30-day age limit, 20-thread cap, automatic update on re-match. Opt-out via `enable_threads`.
- **Outcome Tracking** — Deferred quality validation via outcome probes. After orchestration, PM records delivered files and success conditions. On next session touching same files, PM lazily validates (git history, test runs) and feeds results back into pattern confidence (+0.15 positive, -0.3 negative). `/orchestray:learn validate` for manual validation. Opt-in via `enable_outcome_tracking`.
- **Adaptive Agent Personas** — Auto-generated project-tuned agent behavior. After 3+ orchestrations, PM synthesizes behavioral personas per agent type from accumulated patterns, corrections, KB facts, and repo structure. Injected as `## Project Persona` in delegation prompts. Refreshes every 5 orchestrations. Opt-out via `enable_personas`.
- **Replay Analysis** — Counterfactual reasoning on friction orchestrations. When re-plans, verify-fix failures, cost overruns, or low confidence occur, PM generates alternative strategies stored as replay patterns. Applied as advisory counter-evidence in future decompositions. Opt-out via `enable_replay_analysis`.
- 4 new Tier 2 reference files: `orchestration-threads.md`, `outcome-tracking.md`, `adaptive-personas.md`, `replay-analysis.md`
- 5 new config settings: `enable_threads`, `enable_outcome_tracking`, `enable_personas`, `enable_replay_analysis`, `max_turns_overrides`
- 8 new event schemas: `thread_created`, `thread_matched`, `thread_updated`, `persona_generated`, `persona_injected`, `probe_created`, `probe_validated`, `replay_analysis`
- `validate` subcommand for `/orchestray:learn` skill
- **Configurable `maxTurns` ceilings** — `max_turns_overrides` config key lets users override per-agent turn budget ceilings without editing agent frontmatter. Example: `{"reviewer": 50, "debugger": 60}`. When `null` (default), each agent's frontmatter `maxTurns` is used. PM Section 3.Y turn budget formula now resolves ceiling from config override first, then frontmatter default.
- **PreCompact hook** — New `bin/pre-compact-archive.js` hook script registered in `hooks/hooks.json` under Claude Code's `PreCompact` event. Before auto-compaction or `/compact` runs, the hook archives the current orchestration state (`.orchestray/state/orchestration.md`, `task-graph.md`, `tasks/*`), audit trail (`events.jsonl`, `current-orchestration.json`), and writes a manifest to `.orchestray/history/pre-compact-{timestamp}/`. Non-blocking — compaction always proceeds. Ensures valuable orchestration context is preserved before summarization.
- **Memory integration for personas and threads** — Personas now dual-write to `.claude/agent-memory/{agent-type}/MEMORY.md` so they're auto-loaded into the agent's context by Claude Code's memory system (first 25KB / 200 lines on every spawn). Threads now dual-write to `.orchestray/kb/facts/thread-{orch-id-slug}.md` with `ttl_days: 60` so they're queryable via `/orchestray:kb` and survive auto-compaction. Canonical copies remain in `.orchestray/personas/` and `.orchestray/threads/`; the memory/KB entries are mirrors for context survival.
- **Compact Instructions in CLAUDE.md** — New "Compact Instructions" section at the top of CLAUDE.md tells Claude Code's auto-compactor what to preserve during summarization: orchestration state, active audit round, applied fixes, cost tracking, modified files, decisions, and known blockers.
- **Agent caching troubleshooting note in CLAUDE.md** — Documents the gotcha that editing `agents/*.md` frontmatter mid-session doesn't take effect until the session restarts or `/agents` is run. Explains the workaround: pass `maxTurns` as an explicit parameter on `Agent()` calls.
- **Test coverage** — suite now at 195/195 across 11 test files. New: `tests/hooks-json.test.js` (asserts every `hooks/hooks.json` command path resolves to a real script) and an installer `_lib/` regression test in `tests/install.test.js` asserting every installed script's `require('./_lib/...')` resolves.

### Fixed
- **Installer `_lib/` copy** — `bin/install.js` now copies `bin/_lib/` into the install target. Prior versions shipped broken installed hooks (MODULE_NOT_FOUND on `require('./_lib/...')`). Any user who installed 2.0.8 or 2.0.9 via `npx orchestray --global|--local` should re-run the installer to pick up the fix.
- **Installer non-destructive uninstall** — `bin/install.js` uninstall path now uses conditional `rmdirSync` only when the `orchestray/` directory is empty, instead of a blanket `rmSync`. The uninstall log correctly reflects whether the directory was actually removed or preserved.
- **Installer "already installed" parse** — regex-based detection of existing install entries now handles paths containing spaces.
- **Installer bare-environment error** — `--global` with no `HOME` / `USERPROFILE` now emits a friendly error instead of crashing with a cryptic `TypeError`.
- **`collect-agent-metrics.js` O(n²) scan** — events.jsonl scan is now O(n) with a 2 MB read cap and a `"routing_outcome"` substring pre-filter (previously re-parsed the full file on every SubagentStop). When the cap is hit, writes a stderr warning and sets `model_resolution_note` on the emitted event so `/orchestray:analytics` can flag degraded cost rows.
- **`_lib/atomic-append.js` stale-lock recovery** — on `EEXIST`, stats the lockfile and unlinks + retries if older than 10 s. Fallback stderr message now surfaces the underlying error code instead of a generic "retry exhausted". The unlink guard logs non-ENOENT errors instead of silently dropping them.
- **`pre-compact-archive.js` Node 21+ compat** — uses `entry.parentPath || entry.path` because `entry.path` is deprecated in Node 21+.
- **`reassign-idle-teammate.js` pending-task regex** — now requires line-leading `- [ ]` / `status:` so documentation-style checkboxes embedded in task descriptions no longer match as pending work.
- **`reviewer.md` scope clarification** — line 347 now reads "you do not change source files. KB writes and findings artifacts via Write are allowed." (was ambiguous "you do not change files", which conflicted with the reviewer's audit-write permissions.)
- **PM section reference corrected** — `agents/pm.md:130` now says "Sections 0–43 across this file and `agents/pm-reference/`" (was "Sections 1-43", which both undercounted the range and failed to clarify the scope spans Tier 0 + Tier 2 files).
- **PM Tier 1 cross-references disambiguated** — three "Section 13 / 14 / 17" references in `agents/pm.md` now carry a `(tier1)` suffix so they are not confused with pm.md's own section numbers.
- **`/orchestray:config` agent-teams enablement** — setting `enable_agent_teams: true` now mutates `settings.json` to add `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"` (two-layer enablement: Orchestray config + Claude Code env var). Setting it to `false` removes the env var cleanly.
- **Tier 2 frontmatter cleanup** — stripped stale YAML frontmatter from `adaptive-personas.md`, `outcome-tracking.md`, `orchestration-threads.md`, and `replay-analysis.md` so all 29 tier2 files now follow a uniform "no frontmatter" convention.
- **CLAUDE.md slash-command clarification** — added a one-line note that `skills/orchestray:*` directories are slash commands (all use `disable-model-invocation: true`), not model-invoked skills.

### Changed
- **PM Section 3.Y hardened**: Now explicitly mandates "MUST pass `maxTurns` parameter on every Agent() call" (not "may pass"). Previously the PM relied on frontmatter as a fallback; now it must always pass the calculated value explicitly, bypassing the Claude Code session-start agent definition cache that caused mid-session `maxTurns` edits to be ignored.
- Config defaults now include 47 keys (was 42)
- `agents/pm-reference/scoring-rubrics.md` Turn Budget Reference table updated with current frontmatter ceiling values (previously stale: developer 25→50, reviewer 20→30, debugger 30→40, tester 25→40, documenter 20→30, refactorer 25→50, inventor 40→50)
- PM Tier 0 updated from ~1,082 to ~1,215 lines (config defaults, step references, dispatch entries, inline probe validation protocol in Section 0 step 0.5 to avoid Tier 2 dependency on simple-task path)
- PM Tier 1 post-orchestration flow expanded with steps 7.1-7.4 (thread creation, probe creation, persona refresh, replay analysis)
- Pattern extraction updated with replay pattern advisory integration (Section 22b)
- 29 pm-reference files (was 25)
- Section 0 Silent Pre-Check gains step 0.5 (probe scan on every session)
- Section 3 delegation gains step 9.5 (persona injection)
- Section 0 Medium+ path gains step 2.6 (thread scan)

## [2.0.9] - 2026-04-09

### Theme: "Agents That Think About Thinking"

### Added
- **Agent Introspection Protocol** -- After each non-Haiku agent completes, a Haiku distiller extracts the reasoning trace (approaches considered, assumptions made, trade-offs evaluated, discoveries) into a compressed file. Downstream agents receive relevant traces in their delegation prompts, eliminating redundant exploration and preventing repetition of rejected approaches. Opt-out via `enable_introspection`.
- **Cognitive Backpressure** -- Agents write structured confidence signals to `.orchestray/state/confidence/` at defined checkpoints during execution. PM reads signals between execution groups and reacts: proceeding normally (>=0.7), injecting context (0.5-0.69), re-evaluating (0.3-0.49), or escalating to user (<0.3). Low-confidence successes are flagged. Opt-out via `enable_backpressure`.
- **Agent Disagreement Protocol** -- Reviewer findings that represent genuine design trade-offs (not bugs) are surfaced to the user as structured decisions instead of being routed through the verify-fix loop. User choices are saved as design-preference patterns that proactively guide future orchestrations. Opt-out via `surface_disagreements`.
- **Drift Sentinel** -- Detects architectural drift via 3 invariant sources: auto-extracted from architect output, 3 conservative static rules (no-new-deps, no-removed-exports, test-coverage-parity), and session invariants from the current orchestration. Pre/post-execution checks surface violations to user. Opt-out via `enable_drift_sentinel`.
- **Visual Orchestration** -- Multi-modal review for UI changes. When enabled, PM auto-detects screenshots from project artifact directories (Storybook, Cypress, Playwright) and includes them in reviewer delegation. Reviewer applies 6-dimension visual checklist. No external dependencies — uses Claude's native image reading. Opt-in via `enable_visual_review`.
- 5 new Tier 2 reference files: `introspection.md`, `cognitive-backpressure.md`, `disagreement-protocol.md`, `drift-sentinel.md`, `visual-review.md`
- 5 new config settings: `enable_introspection`, `enable_backpressure`, `surface_disagreements`, `enable_drift_sentinel`, `enable_visual_review`
- 5 new event schemas: `introspection_trace`, `confidence_signal`, `disagreement_surfaced`, `drift_check`, `visual_review` (plus `invariant_extracted`)

### Changed
- Tier 1 orchestration reference expanded with new subsections for introspection injection, backpressure reading, and disagreement routing
- Delegation templates updated with trace injection, confidence checkpoints, and design-preference context
- Config defaults now include 42 keys (was 37)
- PM Tier 0 updated from ~1,043 to ~1,081 lines (dispatch entries and config defaults only; all feature logic in Tier 1/2)
- 5 new Tier 2 reference files (was 3)
- 5 new config settings (was 3)

## [2.0.8] - 2026-04-09

### Theme: "Self-Aware Orchestration"

### Added
- **Prompt tiering** -- PM prompt restructured into 3 tiers (Tier 0 always-loaded ~1,030 lines, Tier 1 orchestration-only, Tier 2 feature-gated). Reduces PM input tokens by 30-40% for simple tasks.
- **Orchestration contracts** -- Machine-verifiable pre/post-conditions per subtask. PM validates file existence, file ownership, and content patterns before accepting agent results. Configurable via `contract_strictness` setting (none/standard/strict).
- **Delegation pre-flight checklists** -- Per-agent-type validation ensures delegation prompts include all required context before spawning. Reduces verify-fix loops.
- **Diff-scoped review** -- Reviewer receives git diff alongside file paths, focusing analysis on changed lines. Reduces reviewer token consumption.
- **Consequence forecasting** -- Pre-execution dependency scan predicts downstream effects; post-execution validation tracks accuracy. Opt-out via `enable_consequence_forecast`.
- **Adaptive agent turn budgets** -- Dynamic `maxTurns` per agent based on subtask complexity and file count instead of static defaults.
- **Orchestration ROI scorecard** -- Post-orchestration summary shows issues caught, files delivered, manual effort estimate, cost vs all-Opus baseline, and routing savings.
- PM Section 39 (Consequence Forecasting)
- 2 new config settings: `contract_strictness`, `enable_consequence_forecast`
- 3 new event schemas: `contract_check`, `consequence_forecast`, `orchestration_roi`
- 42 new tests for `audit-event.js` and `audit-team-event.js` hooks (21 each). All 7 hook scripts now have test coverage.

### Changed
- `command_exits_zero` contract type hardened from freeform command string to indexed enum (1-6). PM selects from a fixed command table instead of composing arbitrary commands.
- PM prompt restructured from monolith to tiered architecture (Tier 0 + Tier 1 + Tier 2). Total content preserved; loading is conditional.
- pm-reference/ expanded from 8 to 20 files with restructured PM sections
- Config defaults now include 37 keys (was 35)
- Reviewer now receives git diff in delegation prompt for focused review
- Agent `maxTurns` set dynamically per-invocation based on complexity
- Section 0 reference updated from "Sections 1-38" to "Sections 1-39"

## [2.0.7] - 2026-04-09

### Added
- **Custom YAML workflows** — Define reusable orchestration sequences in `.orchestray/workflows/*.yaml`. PM auto-matches workflows via `trigger` field or `--workflow` flag. New `/orchestray:workflows` skill for CRUD management.
- **Auto-documenter** — PM automatically spawns documenter agent after feature additions (new files, exports, endpoints). Opt-in via `auto_document` config setting.
- **Monorepo awareness** — Auto-detects monorepo structures (pnpm, lerna, nx, turbo) and scopes agent file ownership to affected packages.
- **Adversarial architecture review** — Two competing architect designs evaluated in parallel for high-complexity tasks (score 8+). Opt-in via `adversarial_review` config setting.
- **Exportable audit reports** — `/orchestray:report --export json|csv` writes machine-readable report files to `.orchestray/exports/`.
- **Cross-project pattern transfer** — `/orchestray:learn export` and `/orchestray:learn import` for sharing patterns between projects.
- **Magic keyword triggers** — Words like "orchestrate", "multi-agent", "use orchestray" automatically trigger orchestration in `complexity-precheck.js`.
- `.gitignore` negation patterns for `team-config.json`, `team-patterns/`, and `workflows/` (version-controlled team files).
- 2 new config settings: `auto_document`, `adversarial_review`
- 1 new skill: `/orchestray:workflows`

### Fixed
- Agent description format now always shows effort level (e.g., `"Fix auth (sonnet/medium)"`) — previously hidden when effort matched model default.
- PM Section 0 reference updated from "Sections 1-34" to "Sections 1-38".
- Magic keyword triggers use word-boundary regex to prevent false positives on conversational text.
- Workflows skill uses `.yaml` extension consistently (matching PM Section 35).
- Report `--export` flag parsing moved to step 1 (before orchestration lookup).
- Learn export confidence threshold corrected from 0.3 to 0.5 (matches minimum creation confidence).

### Changed
- PM prompt expanded from 34 to 38 sections (2,574 → 2,847 lines)
- Config defaults now include 35 keys (was 33, added `auto_document` and `adversarial_review`)
- 15 skills (was 14, added `/orchestray:workflows`)

## [2.0.6] - 2026-04-09

### Added
- **Inventor agent** — 10th core agent. First-principles creation specialist that designs and prototypes novel tools, DSLs, and custom solutions. Includes Phase 5 self-assessment gate (RECOMMEND / DO NOT RECOMMEND) to prevent unnecessary reinvention.
- **Effort/reasoning level routing** — PM assigns `low`/`medium`/`high`/`max` effort alongside model selection. Default mapping: haiku→low, sonnet→medium, opus→high. Configurable via `default_effort`, `force_effort`, `effort_routing`.
- Effort shown in agent descriptions when overridden (e.g., `"Design auth (opus/max)"`)
- Inventor delegation example in delegation-templates.md
- Inventor routing default in scoring-rubrics.md (Opus default, never Haiku)
- Effort assignment section in scoring-rubrics.md with anti-patterns and escalation rules
- `effort_assigned`, `effort_override`, `effort_override_reason` fields in routing_outcome event schema
- 3 new config settings: `default_effort`, `force_effort`, `effort_routing`

### Fixed
- `complexity-precheck.js`: added `process.exit(0)` on early-return paths (hook hung until timeout)
- `install.js`: fixed mergeHooks broken duplicate-detection predicate (both conditions now on same entry)
- `reassign-idle-teammate.js`: added stdout JSON response before exit-code-2 (was missing)
- `collect-agent-metrics.js`: NaN-safe token accumulation with `Number()` coercion
- `collect-agent-metrics.js`: wired to `TaskCompleted` hook for Agent Teams cost tracking (was dead code)
- Report skill now reads both `agent_stop` and `task_completed_metrics` events for cost aggregation
- PM Section 3/13/17/20 incomplete agent enumeration lists (missing refactorer, security-engineer, inventor)
- `pattern-extraction.md`: fixed stale "step 10" reference (actual: step 5)
- `scoring-rubrics.md`: added missing security-engineer routing default (never Haiku)

### Changed
- PM prompt expanded from 34 to 34 sections (2,500 → 2,574 lines); no new section numbers, content added to existing sections
- Config defaults now include 33 keys (was 30, added 3 effort settings)
- 10 core agents (was 9, added Inventor)
- Agent descriptions show effort level when overridden from model default

## [2.0.5] - 2026-04-09

### Added
- **Refactorer agent** — 9th core agent for systematic code transformation without behavior change. Bridges the architect/developer gap with behavioral equivalence verification.
- **Repository map** — compact codebase representation injected into agent prompts, reducing exploration overhead by 60-75%. Per-agent filtering, staleness detection, incremental regeneration.
- **User correction ingestion** — captures direct user corrections as high-confidence patterns. Auto-detection during orchestration, post-orchestration, and manual via `/orchestray:learn correct`.
- **Pattern effectiveness dashboard** — `/orchestray:patterns` shows pattern inventory, application history, confidence trajectories, estimated savings, and actionable recommendations.
- **PR review mode** — `/orchestray:review-pr` reviews GitHub PRs using the reviewer agent. Fetches diff via `gh`, optionally posts findings as review comments.
- **Trajectory analysis** — execution timeline in `/orchestray:report` showing agent sequencing, parallelism, per-agent metrics, and SWE-agent-style insights.
- **Agent description format** — model name shown in background agent UI instead of redundant agent type.
- **Model routing enforcement** — PM must pass explicit `model` parameter on Agent() calls; agents no longer silently inherit parent model.
- 3 new skills: `/orchestray:patterns`, `/orchestray:review-pr`, `/orchestray:learn correct`
- 2 new config settings: `enable_repo_map`, `post_pr_comments`
- PM Section 34 (User Correction Protocol), repo map protocol reference, event schemas for `agent_stop` and `pattern_pruned`

### Fixed
- Agent description bug: background agent UI showed agent type instead of routed model name
- Model routing: agents inherited parent Opus instead of using routed model (now enforced via explicit `model` parameter)
- Double backtick in architect.md line 149 breaking prompt rendering
- `.claude-plugin/` directory missing from package.json `files` array (plugin undiscoverable on npm)
- stdin error handlers added to all 6 hook scripts (was missing on 4)
- install.js banner printed before uninstall check
- install.js missing `'use strict'` directive
- Pricing comment year updated from 2025 to 2026
- Analytics skill step 8 referenced wrong frontmatter field names
- CLAUDE.md missing security-engineer agent and 5 skill commands
- PM Section 17 and Section 13 missing refactorer/security-engineer from agent lists
- Delegation templates missing user-correction and repo map steps
- Learn skill template missing user-correction category
- Report skill missing cross-references to analytics/patterns

### Changed
- PM prompt expanded from 34 to 35 sections (2,330 → ~2,500 lines)
- Config defaults now include 32 keys (was 30)
- Refactorer added to all PM agent lists, routing defaults, and delegation patterns
- Pre-scan (step 2.7) replaced by richer repository map generation

## [2.0.4] - 2026-04-08

### Added
- **GitHub Issue integration** — `/orchestray:issue` skill orchestrates directly from GitHub issues via `gh` CLI. PM auto-detects issue URLs in prompts, creates branches, maps labels to templates, optionally comments results back.
- **CI/CD feedback loop** — PM runs `ci_command` after orchestration, auto-fixes failures up to `ci_max_retries` attempts. Delivers verified, merge-ready code.
- **Mid-orchestration checkpoints** — pause between groups to review, modify, or abort. User sees results and controls flow with continue/modify/review/abort commands.
- **Structured plan editing** — modify tasks during preview: `remove`, `model`, `add`, `swap` commands before execution starts.
- **User-authored playbooks** — `.orchestray/playbooks/*.md` files inject project-specific instructions into agent delegation prompts. CRUD via `/orchestray:playbooks`.
- **Correction memory** — PM learns from verify-fix loops. Correction patterns extracted, stored, and applied to prevent repeated mistakes.
- **Cost prediction** — pre-execution cost estimates from historical data, with post-orchestration accuracy tracking.
- **Agent checkpointing** — per-agent state persistence for reliable resume after interruptions.
- **Pattern effectiveness dashboard** — `/orchestray:analytics` now shows pattern applications, correction effectiveness, and learning trends.
- **Team configuration** — `.orchestray/team-config.json` (version-controlled) sets team-wide policies, overrideable by individual config.
- **Team patterns** — `.orchestray/team-patterns/` for shared patterns across team members. `/orchestray:learn promote` copies local patterns to team.
- **Daily/weekly cost budgets** — `daily_cost_limit_usd` and `weekly_cost_limit_usd` with 80% warning and 100% hard stop.
- Model displayed in all agent status messages (before-group, after-agent, checkpoint results)
- 7 new config settings: `ci_command`, `ci_max_retries`, `post_to_issue`, `enable_checkpoints`, `daily_cost_limit_usd`, `weekly_cost_limit_usd`
- 2 new skills: `/orchestray:issue`, `/orchestray:playbooks`
- PM Sections 25-33 (9 new sections)

### Fixed
- Installer now copies `agents/pm-reference/` directory (previously missing for all installed users)
- Complexity hook no longer scores internal Claude Code messages (task-notification, command-name XML)
- KB index auto-reconciles when empty but files exist in subdirectories
- Token usage fallback chain: transcript → event payload → turn-based estimation (fixes $0.0000 analytics)
- History archive structure standardized (mandatory flat layout with events.jsonl)
- config.json created with all 27 defaults during first-run onboarding
- plugin.json version and URLs synced with package.json
- `security-engineer` added to reserved names (was already present)
- PM section reference updated from "Sections 1-15" to "Sections 1-33"

### Changed
- PM prompt expanded from 24 to 34 sections (1,836 → 2,330 lines)
- Config defaults now include all 27 keys (was 17, missing 10 routing/model keys)
- `usage_source` field added to audit events (transcript/event_payload/estimated)
- Session ID tracked in auto-trigger markers for staleness validation
- Pattern loading now searches both local and team-patterns directories
- Cost budget check runs before task decomposition

## [2.0.3] - 2026-04-08

### Added
- **Security Engineer** — 8th core agent with shift-left security analysis (design review + implementation audit)
- Pipeline templates — 7 workflow archetypes (bug fix, new feature, refactor, test, docs, migration, security audit) for consistent task decomposition
- TDD orchestration mode — test-first workflow: architect → tester → developer → reviewer (`tdd_mode` config)
- Adaptive complexity thresholds — self-calibrating orchestration trigger based on historical signals
- Codebase pre-scan — one-time lightweight project overview on first orchestration (`enable_prescan` config)
- Orchestration preview — task graph with cost estimates before execution (`confirm_before_execute` config)
- Regression detection — test baseline before/after orchestration (`enable_regression_check` config)
- Static analysis integration — run linters before reviewer step (`enable_static_analysis` config)
- 5 new specialist templates: performance-engineer, release-engineer, migration-specialist, accessibility-specialist, api-designer
- 7 new config settings: `security_review`, `tdd_mode`, `enable_regression_check`, `enable_prescan`, `enable_static_analysis`, `test_timeout`, `confirm_before_execute`
- PM Section 24: Security Integration Protocol with auto-detection rules and dual invocation modes
- Enhanced progress visibility — structured per-group announcements during orchestration

### Changed
- Reviewer expanded from 5 to 7 review dimensions (added Operability and API Compatibility)
- Developer self-check protocol now runs automatically on every orchestrated task (compile, lint, test, spec verify, diff review)
- PM task decomposition now classifies tasks into archetypes before decomposing
- Installer reads version from package.json instead of hardcoded string

## [2.0.2] - 2026-04-08

### Fixed
- Fix zero-token transcript parsing — cost tracking now reads `entry.message.usage` (Claude Code's actual format)
- Add cache creation token pricing (25% surcharge) to cost estimates
- Fix KB index sync — added `/orchestray:kb reconcile` command to rebuild index from files
- Standardize event field parsing (`event` vs `type`) for backward compatibility in analytics/report skills
- Remove unconditional debug logging from complexity-precheck.js (now gated behind `verbose` config)
- Fix stale auto-trigger.json cleanup (markers older than 5 minutes auto-deleted)
- Fix empty task archives — state directory now properly copied to history on completion

### Added
- `effort` frontmatter field on all 7 agents (pm: high, architect: high, developer: medium, reviewer: medium, debugger: high, tester: medium, documenter: low)
- `max_cost_usd` config setting for per-orchestration budget enforcement
- `turns_used` metric displayed in `/orchestray:analytics` (turns by agent type table)
- PM prompt size reduction — reference material extracted to `agents/pm-reference/` (loaded on-demand)
- This CHANGELOG.md

### Changed
- Consolidated config reads in complexity-precheck.js (single read instead of two)

## [2.0.1] - 2026-04-08

### Added
- Analytics skill (`/orchestray:analytics`) for aggregate performance stats
- Knowledge base skill (`/orchestray:kb`) for cross-session context reuse
- Update skill (`/orchestray:update`) for npm-based updates
- Learn skill (`/orchestray:learn`) for manual pattern extraction
- Specialist templates (security-auditor, database, frontend, devops)
- `turns_used` metric in agent_stop events
- Installer fix for hook merging

### Changed
- Bumped version to 2.0.1
- Improved reviewer severity calibration
- Developer self-check protocol

## [2.0.0] - 2026-04-08

### Added
- Initial release: multi-agent orchestration plugin for Claude Code
- PM agent with 23 orchestration sections
- 7 specialized agents (PM, architect, developer, reviewer, debugger, tester, documenter)
- 10 slash commands for orchestration management
- 6 hook scripts for audit logging and complexity detection
- Smart model routing (Haiku/Sonnet/Opus per subtask complexity)
- Persistent specialist registry
- Pattern extraction and learning
- Agent Teams integration (experimental)
- Knowledge base with TTL-based staleness
- Audit trail with per-agent cost tracking
- File-based state management
