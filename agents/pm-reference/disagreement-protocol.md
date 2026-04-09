<!-- PM Reference: Loaded by Section Loading Protocol when surface_disagreements is true -->

# Agent Disagreement Protocol -- Trade-Off Surfacing and Preference Learning

When a reviewer raises a finding that represents a genuine design trade-off (not a bug),
surface it to the user as a structured decision rather than routing it through the
verify-fix loop. Learn from the user's choice to build design-preference patterns.

---

## Disagreement Detection Criteria

A reviewer finding is classified as a **disagreement** (not a bug) when ALL four
conditions are met:

1. **Severity is "warning"** -- errors are always bugs and route to verify-fix (Section 18).
2. **Contains trade-off language** -- the description includes words like "consider",
   "alternatively", "trade-off", "could also", "one approach vs another", "might prefer",
   "another option", or similar phrasing that implies multiple valid choices.
3. **About design CHOICE, not CORRECTNESS** -- no compilation error, no security
   vulnerability, no broken test, no missing null check. The code works; the reviewer
   is suggesting a different approach.
4. **References a valid alternative** -- the reviewer describes an alternative approach
   that is also technically sound, not just "this is bad".

**When in doubt, route through verify-fix.** False negatives (treating a disagreement
as a bug) waste some tokens in the fix loop but cause no harm. False positives
(treating a bug as a disagreement) skip necessary fixes.

---

## Surfacing Format

When a disagreement is detected, present it to the user in this structured format:

```
Design trade-off detected:

[Agent A: reviewer] suggests: {approach A description}
  Trade-off: {pros and cons of the reviewer's suggested approach}

[Agent B: developer] implemented: {approach B description}
  Trade-off: {pros and cons of the current implementation}

Context: {PM's analysis of why both approaches are valid and what factors
          might favor one over the other}

Your call: [keep current] / [apply suggestion] / [defer]
```

### Synergy with Introspection

When `enable_introspection` is true and reasoning traces exist for the developer and/or
reviewer tasks, include their reasoning in the surfacing format to give the user richer
context:

```
Developer's reasoning trace shows:
  "{relevant excerpt from developer trace -- approaches_considered or trade_offs}"

Reviewer's perspective:
  "{relevant excerpt from reviewer trace -- trade_offs or risky_decisions}"
```

Place this block between the trade-off descriptions and the "Your call" line. Only
include traces that are directly relevant to the disagreement -- do not dump the
entire trace.

---

## User Response Handling

### "keep current"
1. Log the user's preference (see Design-Preference Pattern Format below).
2. Continue the orchestration -- no code changes needed.
3. Mark the reviewer finding as `resolved: "user_accepted_current"` in the audit trail.

### "apply suggestion"
1. Route the reviewer's suggestion to the developer as a targeted change request.
   Include the reviewer's description and the user's decision as context.
2. After the developer applies the change, re-run the reviewer on the modified files.
3. Log the preference (user preferred the alternative approach in this context).

### "defer"
1. Log the disagreement as `resolved: "deferred"` in the audit trail.
2. Do NOT save a design-preference pattern (the user has not expressed a preference).
3. Continue the orchestration.

---

## Design-Preference Pattern Format

When a user resolves a disagreement with "keep current" or "apply suggestion", save
a design-preference pattern to `.orchestray/patterns/design-preference-{slug}.md`:

```yaml
---
type: design-preference
name: <descriptive-kebab-case-name>
description: "User prefers {choice} over {alternative} when {context}"
context: <when this preference applies -- language, module, pattern type>
confidence: 0.6
times_applied: 0
evidence:
  - <orchestration_id>
created_at: <ISO 8601>
updated_at: <ISO 8601>
---

## Choice
{description of the preferred approach}

## Alternative
{description of the rejected approach}

## Rationale
{PM's summary of why the user made this choice, based on context}
```

---

## Preference Lifecycle

- **Initial confidence:** 0.6 (single data point).
- **Reaffirmation:** When a matching disagreement arises and the user makes the same
  choice, increase confidence by +0.1 (cap at 1.0) and add the orchestration_id to
  evidence.
- **Reversal:** When the user makes the opposite choice in a matching context, decrease
  confidence by -0.2 (floor at 0.1). If confidence drops below 0.3, mark the pattern
  as `deprecated: true` -- it will be excluded from future injection but preserved for
  audit history.
- **Application:** When a design-preference pattern matches the current task context
  (per Section 22.D in tier1-orchestration.md), inject it into the developer's
  delegation prompt so the developer follows the preference proactively, avoiding
  the disagreement entirely.
