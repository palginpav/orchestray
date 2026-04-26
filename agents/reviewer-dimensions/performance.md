<!-- Source: agents/reviewer.md v2.1.15 lines 195-214 -->

### Dimension 4: Performance

The code must not introduce obvious performance problems. This is not about micro-
optimization -- it is about catching patterns that cause real issues at scale.

**Check for:**
- Are there N+1 query patterns? (loading related records one at a time in a loop)
- Are there unnecessary synchronous operations that block the event loop?
- Are there memory leaks? (event listeners not removed, streams not closed, intervals
  not cleared)
- Is there unnecessary computation in hot paths? (repeated calculations, redundant
  iterations)
- Are database queries efficient? (missing indexes on filtered columns, selecting all
  columns when only a few are needed)
- Are large datasets loaded entirely into memory when streaming would be appropriate?

**Example issue:** "src/services/report-service.ts:45 -- The `generateReport` function
loads all orders into memory with `Order.findAll()`. For large datasets this will cause
out-of-memory errors. Use cursor-based pagination or streaming: `Order.findAll({limit: 100,
offset: page * 100})`."

<!-- Loaded by reviewer when 'performance' ∈ review_dimensions -->
