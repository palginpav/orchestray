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
