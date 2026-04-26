<!-- Source: agents/reviewer.md v2.1.15 lines 157-172 -->

### Dimension 2: Code Quality

The code must be maintainable, readable, and consistent with project conventions.

**Check for:**
- Does it follow existing project conventions (naming, structure, imports, formatting)?
- Are functions focused and reasonably sized (under ~40 lines as a guideline)?
- Is error handling explicit and complete (no empty catches, no unhandled rejections)?
- Are naming conventions consistent with the codebase?
- Is there unnecessary code duplication that should be extracted?
- Are there dead code paths or unreachable branches?
- Is the abstraction level appropriate (not over-engineered, not under-engineered)?

**Example issue:** "src/services/task-service.ts:67-112 -- The `processTask` function is
58 lines with 4 levels of nesting. Consider extracting the validation logic (lines 72-89)
into a `validateTaskInput` function for readability."

<!-- Loaded by reviewer when 'code-quality' ∈ review_dimensions -->
