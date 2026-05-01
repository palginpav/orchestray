---
name: feature
description: Wake or inspect quarantined feature gates — see which optional protocols are active
disable-model-invocation: true
argument-hint: "wake <name> | wake --persist <name> | status | list"
---

# Orchestray Feature Quarantine Management

The user wants to manage feature demand-gate quarantine state.

## Protocol

### Step 1 — Parse subcommand

Parse `$ARGUMENTS`. The first whitespace-separated token is the subcommand.

| Subcommand | Description |
|------------|-------------|
| `wake`     | Wake a quarantined feature (session or 30-day pinned) |
| `status`   | Show quarantine state and active wakes |
| `list`     | Alias for `status` |

If the subcommand is empty, treat it as `status` (default).

If the subcommand is not in the table above:
- Emit: "Unknown subcommand '<name>'. Available: wake, status, list."
- Stop.

---

### Step 2 — `wake` branch

Syntax: `wake [--persist] <name>`

Parse the remaining tokens after `wake`. If `--persist` is present (anywhere in the
remaining tokens), this is a 30-day pinned wake; otherwise it is a session-local wake.
The feature name `<name>` is the gate slug (e.g., `pattern_extraction`, `archetype_cache`).

Invoke via Bash:

```
node bin/feature-wake.js [--persist] <name>
```

Display the output as-is.

**Session wake (no --persist):**
- Adds `<name>` to `.orchestray/state/feature-wake-session.json`.
- Emits a `feature_wake` audit event with `scope: "session"`, `caller: "cli"`.
- The gate is treated as enabled for the remainder of this session (overrides quarantine_candidates).
- Session wake is cleared on session end (file is session-scoped; a fresh session starts with a clean file).

**30-day pinned wake (with --persist):**
- Adds `<name>` to `.orchestray/state/feature-wake-pinned.json` with a 30-day expiry.
- Emits a `feature_wake` audit event with `scope: "30d_pinned"`, `caller: "cli"`.
- The gate is treated as enabled across sessions for 30 days.

If `<name>` is not a recognized gate slug (see below), print a warning:
"Warning: '<name>' is not a recognized gate slug. Recognized: pattern_extraction, archetype_cache."
Then proceed anyway (the write still happens — user may be operating on a future slug).

---

### Step 3 — `status` / `list` branch

Invoke via Bash:

```
node bin/feature-gate-status.js
```

Display the output as-is.

**Sample output:**
```
Feature Demand Gate Status
==========================
Quarantine candidates (from config):  pattern_extraction
Session wakes (override quarantine):  (none)
Pinned wakes (30-day, override):      (none)

Eligible gate slugs:                  pattern_extraction, archetype_cache
  pattern_extraction:  eval_true_count=8, invoked_count=0, first_eval_at=2026-04-01, quarantine_eligible=true
  archetype_cache:     eval_true_count=2, invoked_count=0, first_eval_at=2026-04-22, quarantine_eligible=false (observation window not elapsed: 2d < 14d)

Active quarantines this session:
  - pattern_extraction  [opt-in via quarantine_candidates]

Re-enable with: /orchestray:feature wake <name>
```

If the feature demand gate is disabled (config.feature_demand_gate.enabled: false or
ORCHESTRAY_DISABLE_DEMAND_GATE=1), show:
"Feature demand gate is disabled. Set feature_demand_gate.enabled: true in .orchestray/config.json to enable."

---

## Notes

- Recognized gate slugs: `pattern_extraction`, `archetype_cache`. New protocols
  become eligible automatically when their `tier2_invoked` emitter is wired in
  `bin/_lib/feature-demand-tracker.js#WIRED_EMITTER_PROTOCOLS`.
  (Only protocols with wired tier2_invoked emitters are eligible; see R-GATE docs.)
- To quarantine a feature, add it to `quarantine_candidates` in `.orchestray/config.json`:
  ```json
  { "feature_demand_gate": { "quarantine_candidates": ["pattern_extraction"] } }
  ```
