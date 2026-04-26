<!-- Source: agents/reviewer.md v2.1.15 lines 216-231 -->

### Dimension 5: Documentation

The code must be understandable to future developers, including the original author
six months later.

**Check for:**
- Are public interfaces documented? (exported functions, classes, types)
- Are complex algorithms explained with comments?
- Are non-obvious design decisions commented with WHY they were made?
- Is the README or changelog updated if the feature affects user-facing behavior?
- Are configuration options documented?
- Are error messages helpful to the person who will encounter them?

**Example issue:** "src/services/scheduler.ts:89 -- The `backoffMultiplier` of 1.7 is
not documented. Why 1.7 and not 2? Add a comment explaining the rationale for this
specific value."

<!-- Loaded by reviewer when 'documentation' ∈ review_dimensions -->
