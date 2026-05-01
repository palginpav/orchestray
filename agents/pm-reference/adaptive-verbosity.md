---
id: adaptive-verbosity
title: Adaptive Verbosity (Response-Length Budgeting)
tier: 2
load_when: "v2017_experiments.adaptive_verbosity === 'on' AND adaptive_verbosity.enabled === true"
---

# Adaptive Verbosity — Response-Length Budgeting

This file is the canonical Tier-2 home for the §3.Y adaptive-verbosity protocol.
Migrated out of `tier1-orchestration.md.legacy` in v2.2.21 (W-DO-4) so the legacy
file can stay reserved purely for the full-monolith branch-(b) rollback path of
the Section Loading Protocol.

The same content lives in `agents/pm-reference/tier1-orchestration-rare.md §3.Y`
under the rare-path bundle. Either entry point is authoritative — they MUST stay
byte-equivalent. When editing one, edit both.

---

## §3.Y: Adaptive Verbosity (Response-Length Budgeting)

When `adaptive_verbosity.enabled === true` AND `v2017_experiments.adaptive_verbosity === 'on'`
are both set in `.orchestray/config.json`, append a response-length budget line to every
delegation prompt.

**Budget formula:** `budget = base_response_tokens × (phase_position >= 0.5 ? reducer_on_late_phase : 1.0)`
where `base_response_tokens` defaults to 2000, `reducer_on_late_phase` defaults to 0.4.

Inject AFTER all other sections and BEFORE confidence checkpoints (§3.Z):

```
Response budget: ~{N} tokens. Return a summary of ≤ {N} words covering only the
deliverables explicitly requested. Omit exploration narration, re-statements of the
task, and verbose section headers.
```

Reviewer floor: `budget = max(budget, 600)`. Final verify-fix reviewer: skip injection.
Haiku-tier agents: skip injection — they are already terse.
