# Pipeline Templates Reference

Standard workflow archetypes for common task types. The PM classifies each task
into an archetype during Section 13 decomposition and uses the matching template
as the starting decomposition strategy. Templates are advisory — the PM adjusts
based on task-specific needs. Patterns from Section 22 override templates when
historical data is available.

---

## Archetype Classification

Classify the task using keyword matching and task structure:

| Archetype | Trigger Keywords | Score Range |
|-----------|-----------------|-------------|
| Bug Fix | "fix", "bug", "broken", "error", "crash", "regression" | 4-6 |
| New Feature | "add", "create", "implement", "build", "new" | 6-9 |
| Refactor | "refactor", "restructure", "reorganize", "clean up", "simplify" | 5-8 |
| Test Improvement | "test", "coverage", "spec", "assertion" | 4-5 |
| Documentation | "docs", "readme", "changelog", "document", "explain" | 3-5 |
| Migration | "migrate", "upgrade", "schema", "breaking change", "legacy" | 7-10 |
| Security Audit | "security", "vulnerability", "audit", "CVE", "OWASP" | 6-9 |
| Release | "release", "ship", "tag", "version bump", "publish", "cut release", "v\d+\.\d+\.\d+" | 3-7 |
| UX Critique | "UX", "DX", "friction", "discoverability", "ergonomics", "command names", "prompt copy", "error messages" | 4-7 |
| Platform Q&A | "Claude Code", "subagent frontmatter", "hook event", "MCP tool", "settings.json schema", "Anthropic SDK", "claude API" | 2-4 |

If the task matches multiple archetypes, prefer the one with higher complexity.
If no archetype matches, use the **New Feature** template as default.

---

## Template Definitions

### Bug Fix
```
Agent Flow: debugger -> developer -> reviewer
Groups: [debugger] -> [developer] -> [reviewer]
Notes: Debugger investigates root cause, developer implements fix, reviewer validates.
Security: Skip unless bug is security-related.
```

### New Feature
```
Agent Flow: architect -> [developer + tester] -> reviewer
Groups: [architect] -> [developer, tester] -> [reviewer]
Notes: Architect designs, developer and tester work in parallel (developer implements,
tester writes tests from architect's spec). Reviewer validates both.
Security: Include security-engineer if task touches auth, APIs, data storage, or crypto.
```

### Refactor
```
Agent Flow: architect -> developer -> reviewer
Groups: [architect] -> [developer] -> [reviewer]
Notes: Architect defines refactoring strategy and boundaries. Developer executes.
Reviewer ensures behavior is preserved (no functional changes).
Security: Skip unless refactor touches security-sensitive code.
```

### Test Improvement
```
Agent Flow: tester -> reviewer
Groups: [tester] -> [reviewer]
Notes: Tester writes/improves tests. Reviewer validates test quality and coverage.
No architect needed — tests follow existing interfaces.
Security: Skip.
```

### Documentation
```
Agent Flow: documenter
Groups: [documenter]
Notes: Single-agent orchestration. Documenter handles all documentation work.
Security: Skip.
```

### Migration
```
Agent Flow: architect -> [developer + tester] -> reviewer
Groups: [architect] -> [developer, tester] -> [reviewer]
Notes: Architect designs migration strategy with rollback plan. Developer implements.
Tester writes migration-specific tests (before/after validation).
Security: Include security-engineer — migrations often touch data and auth.
```

### Security Audit
```
Agent Flow: security-engineer -> [developer] -> reviewer
Groups: [security-engineer] -> [developer] -> [reviewer]
Notes: Security engineer performs full audit. Developer fixes findings.
Reviewer validates fixes. This is the ONLY archetype where security-engineer leads.
Security: Always included (this IS the security archetype).
```

### Release
```
Agent Flow: release-manager -> reviewer
Groups: [release-manager] -> [reviewer]
Notes: Release-manager bumps version, sweeps README, writes CHANGELOG, refreshes
event-schemas, runs `npm pack --dry-run`, and stages the commit. Reviewer validates
that ONLY release-mechanical files changed (per release-manager's hard fence).
Does NOT push or tag — the user does that explicitly. If the prior orchestration
history shows >0 audit findings, refuse and route back to the audit loop FIRST
(per `feedback_preship_audit_loop`).
Security: Skip — release commits should not introduce code changes; if they did,
that is a hard-fence violation handled by reviewer, not security-engineer.
```

### UX Critique
```
Agent Flow: ux-critic -> [developer | inventor]
Groups: [ux-critic] -> [developer or inventor depending on hand-off field]
Notes: ux-critic produces a findings artifact (read-only). Each finding has a
`Hand-off:` field naming the right downstream agent — usually developer for
text-level fixes, inventor when a friction class needs a new mechanism. PM
reads the findings, batches by hand-off, and spawns the appropriate agent(s).
Bursty workload — UX cycles cluster around brainstorm phases; expect 0-3 spawns
per release in execution-heavy cycles.
Security: Skip.
```

### Platform Q&A
```
Agent Flow: platform-oracle
Groups: [platform-oracle]
Notes: Single-agent orchestration. PM forwards a focused platform question
(Claude Code, Anthropic SDK/API, MCP) and receives a cited factual answer
with a stability-tier label. PM uses the tier label to decide whether to
write a hard dispatch (stable primitive) or a config-gated dispatch
(experimental / community). Refuses outside the four named platforms.
Security: Skip.
```

### TDD Mode (Config: tdd_mode = true)

When `tdd_mode` is enabled in config AND the archetype is "New Feature":
```
Agent Flow: architect -> tester -> developer -> reviewer
Groups: [architect] -> [tester] -> [developer] -> [reviewer]
Notes: Tester writes tests from architect's spec BEFORE developer implements.
Developer's goal: make the tester's tests pass. Reviewer validates both.
Tester delegation: "Write tests based on the architect's design. Tests should
define the expected behavior. They WILL fail initially — that is correct."
Developer delegation: "Run the tests the tester wrote. They should fail.
Implement code to make them pass. Do not modify the test files."
```

TDD is NOT used for: bug fixes, refactors, test improvements, docs, or when the
user explicitly says "no TDD" or "skip tests first".

---

## Template Selection Integration

During Section 13 decomposition:
1. Classify the task into an archetype using the keyword table above
2. Log the archetype: "Archetype: {name} (matched keywords: {list})"
3. Load the matching template as the starting decomposition
4. Adjust for task-specific needs (add/remove agents, change parallelism)
5. Check if `tdd_mode` is enabled and archetype is "New Feature" — if so, use TDD variant
6. Check if security review is applicable (see PM Section 24)
