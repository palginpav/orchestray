# Delegation Templates Reference

Detailed delegation prompt formats and context handoff protocols.
For principles and anti-patterns, see the main PM prompt Sections 3 and 11.

---

## Section 3: Delegation Prompt Format

When delegating to a subagent, provide a **clear, self-contained task description**.
The subagent has NO context from this conversation. It starts fresh.

### What to Include in Every Delegation

1. **Task description:** What needs to be done, in specific terms
2. **Relevant file paths:** Where to look, where to make changes
3. **Requirements and constraints:** Must-haves, must-not-haves
4. **Expected deliverables:** What the agent should produce
5. **Context from prior agents:** If architect produced a design, include it for developer
6. **Playbook instructions:** If Section 29 matched any playbooks for this agent type, append their Instructions sections to the delegation prompt
7. **Correction patterns**: If Section 30 found matching correction patterns for this agent, include the Known Pitfall warnings
8. **User correction patterns**: If Section 34f found matching user-correction patterns, include the Known Pitfall (User Correction) warnings. Combined cap with step 7: max 5 total correction warnings per delegation, prioritized by confidence.
9. **Repository map:** Include the relevant portion of the repo map from
   `.orchestray/kb/facts/repo-map.md` as a `## Repository Map` section (see Section 3
   Repository Map Injection rules for per-agent filtering)

### Example Delegation Prompts

**Good:** "Create a REST API endpoint POST /api/tasks in src/api/tasks.ts that accepts
{name: string, priority: number} and saves to the tasks table. Use the existing pattern
from src/api/users.ts. Return validation errors as 400 with {error: string} body."

**Good:** "Review the implementation in src/api/tasks.ts and src/models/task.ts.
Validate: correct error handling, SQL injection prevention, input validation completeness,
proper HTTP status codes. The endpoint accepts POST with {name, priority} body."

**Good:** "Design the caching architecture for the /api/products endpoint. Consider:
cache invalidation strategy, TTL values, storage backend (Redis vs in-memory), cache
key design. Output a design document with file structure and implementation approach."

**Good (Inventor):** "We need a lightweight task queue for this project. Existing solutions
(Bull, Bee-Queue) are Redis-dependent and overkill for our 10-job/minute volume. Design
and prototype a file-based task queue using only Node.js stdlib. Evaluate whether it
justifies the maintenance cost vs. just using Bull. Produce prototype code + trade-off
analysis."

---

## Section 11: Context Handoff Template

Use this template when spawning a sequential agent that depends on a prior agent's work:

```
[Task description for Agent B -- specific, self-contained, per Section 3 rules]

## Context from Previous Agent

The {previous_agent} completed {previous_task}. Key context:

### KB Entries to Read
- `.orchestray/kb/{category}/{slug-1}.md` -- {summary from index}
- `.orchestray/kb/{category}/{slug-2}.md` -- {summary from index}

### Code Changes
{git diff output -- or summary if diff exceeds 200 lines}

Use the KB entries and code changes above to understand the current state before
proceeding. Do NOT re-read files covered by the KB entries -- they contain the
distilled analysis.
```

**Template field reference:**
- `{previous_agent}`: The agent type that just completed (architect, developer, etc.)
- `{previous_task}`: One-line description of what the previous agent did
- `{category}/{slug-N}`: Exact paths from index.json entries written by the previous agent
- `{summary from index}`: The `summary` field from the index entry (50 tokens max)
- `{git diff output}`: Output of `git diff` for the previous agent's changes

---

## Section 11: KB + Diff Handoff Flow

Follow this 5-step pattern for every sequential agent handoff:

1. **PM spawns Agent A** with the task description plus an instruction to write discoveries
   to the KB (using the template from Section 10: "Instructing Agents to Write KB").

2. **Agent A completes work** and writes findings to `.orchestray/kb/{category}/{slug}.md`,
   updating `index.json` with the new entry.

3. **PM prepares handoff for Agent B** by:
   a. Checking `index.json` for entries where `source_agent` matches Agent A and
      `updated_at` is recent (within the current orchestration timeframe)
   b. Running `git diff` to capture Agent A's code changes (use `git diff HEAD~1` or
      the appropriate range for Agent A's commits)
   c. Composing Agent B's delegation prompt with all three components:
      the task, the KB references, and the diff
   d. **Selective relevance filter:** Before including any KB entry in the handoff, evaluate
      whether it is relevant to Agent B's SPECIFIC subtask (not just the overall orchestration).
      Skip entries about parts of the system Agent B won't touch. This prevents context waste
      from irrelevant KB entries.

4. **Agent B reads specified KB entries**, understands the changes via the diff, and
   proceeds with its own task. Agent B does NOT re-read files that Agent A already
   analyzed -- the KB entry provides the distilled context.

5. **Agent B writes its own discoveries to KB**, continuing the chain for any subsequent
   agent (e.g., reviewer after developer).
