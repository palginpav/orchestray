# Section 42: Adaptive Personas

Project-tuned behavioral directives for specialist agents. After enough orchestrations,
the PM synthesizes patterns, corrections, and project conventions into a short per-agent
directive that is injected into every delegation for that agent type.

---

## 42a: Persona Generation Trigger

**Integration point:** Section 15 step 3, after thread creation (40a), as step 7.3.

Protocol:

1. Count completed orchestrations by listing `.orchestray/history/` directories.
   Let `orch_count` = number of directories found.

2. Check generation threshold:
   - `orch_count < 3`: skip persona generation entirely. Not enough signal yet.
   - `orch_count >= 3` AND no files exist in `.orchestray/personas/`: trigger initial
     generation for all agent types used in recent orchestrations.
   - `orch_count >= 3` AND personas exist: check refresh trigger. Read the most recent
     persona file's `generated_from` list length (N). If `orch_count - N >= 5`: trigger
     refresh for all agent types used 2+ times in recent orchestrations.

3. If trigger conditions are NOT met: skip to the next post-orchestration step.

4. When triggered, proceed to Section 42b.

---

## 42b: Persona Synthesis

When generation is triggered by Section 42a:

1. Identify agent types to synthesize for. Scan `.orchestray/history/*/events.jsonl`
   (last 10 orchestrations, or all if fewer). Extract distinct `agent_type` values from
   `agent_stop` events. Only synthesize for agent types that appear 2+ times.

2. For each qualifying agent type, aggregate signals:

   - **Correction patterns:** Glob `.orchestray/patterns/correction-*.md` and
     `.orchestray/patterns/user-correction-*.md`. Filter for patterns whose `task_types`
     or `description` field mentions this agent type. Read matching files.

   - **Successful patterns:** Glob `.orchestray/patterns/decomposition-*.md`,
     `routing-*.md`, `specialization-*.md`. Filter for content mentioning this agent type.

   - **KB facts:** Read `.orchestray/kb/index.json`. Filter for entries related to the
     project's tech stack and conventions (language, framework, file structure). Read
     up to 5 matching fact files.

   - **Repo map:** Read `.orchestray/kb/facts/repo-map.md` Language, Framework, and
     Conventions sections only.

3. Synthesize persona using PM's own reasoning (NOT a subagent call):
   - Generate a 50-100 word directive encoding project-specific behavioral guidance.
   - Focus on: language/framework conventions this agent should follow, common pitfalls
     in this project, file naming patterns, test conventions, known constraints.
   - Write in second person ("You are working on...") as an instruction to the agent.
   - Do NOT duplicate playbook content. Read `.orchestray/playbooks/*.md` first and
     exclude any guidance already covered there.

4. **Path validation (security):** Before writing the persona file, validate `{agent-type}`
   against `^[a-zA-Z0-9_-]+$`. Reject any name containing `/`, `.`, or other path
   characters. If validation fails, skip persona generation for that agent type and log
   a warning: "Persona generation skipped for agent type '{agent-type}' — invalid characters
   in name."

5. Write persona file to `.orchestray/personas/{agent-type}.md`. Before writing, ensure
   the parent directory exists — the Write tool auto-creates parent directories, but if
   writing via Bash run `mkdir -p .orchestray/personas` first.

```markdown
---
agent: {agent-type}
project: {project name from repo root directory name or CLAUDE.md}
generated_from: [{orch-id-1}, {orch-id-2}, {orch-id-3}]
generated_at: "{ISO 8601}"
updated_at: "{ISO 8601}"
word_count: {N}
---

{50-100 word persona directive}
```

6. Validate: Count words in the directive. If it exceeds 150 words, trim to the most
   actionable guidance. Project-specific constraints take priority over general advice.

7. **Dual-write to agent memory (context survival):** ALSO write the same persona
   directive to the agent's `memory: project` file at
   `.claude/agent-memory/{agent-type}/MEMORY.md`. Use the `## Project Persona` heading
   so it's discoverable. This ensures the persona survives Claude Code's auto-compaction
   and is auto-loaded into the agent's context on every spawn (first 200 lines / 25KB
   of MEMORY.md are auto-loaded per Claude Code docs).
   - Validate the same `^[a-zA-Z0-9_-]+$` regex + core-agent name check before writing.
   - If `.claude/agent-memory/{agent-type}/` doesn't exist, create it with `mkdir -p`.
   - If MEMORY.md already has a `## Project Persona` section, replace it. Other sections
     in MEMORY.md (existing agent memory) must be preserved.
   - The canonical copy remains `.orchestray/personas/{agent-type}.md`. The MEMORY.md
     copy is a mirror for Claude Code's auto-load mechanism.

8. Log `persona_generated` event for each persona created or refreshed per
   `agents/pm-reference/event-schemas.md`.

**Design note:** PM reasoning is used instead of a Haiku agent (~$0.005 per call)
because the PM already has all signals in context at this point (patterns, corrections,
KB, repo map) and can synthesize a 50-100 word directive without a subagent round-trip.
This saves latency and a tool call. See roadmap section 3.3 for the full rationale.

---

## 42c: Persona Injection

**Integration point:** Section 3 (Agent Spawning Instructions), step 9.5 — AFTER
repository map injection (step 9) and BEFORE the `### Anti-Patterns` section.

Protocol:

1. Check if `enable_personas` is true. If false, skip silently.

2. Check if `.orchestray/personas/{agent-type}.md` exists for the agent about to be
   spawned. If the file does not exist, skip silently. Do not generate on-demand here;
   that only happens in Section 42a/42b post-orchestration.

3. If persona file exists:
   - Read the persona file.
   - Check staleness: compute days between `updated_at` and today. If more than 30 days,
     prefix the content with `[STALE] Persona may be outdated — generated {N} days ago.`
   - Inject as `## Project Persona` section in the delegation prompt, placed AFTER
     `## Repository Map` and BEFORE the task description and upstream reasoning context.
   - Cap: trim persona content to 150 words if it exceeds that limit.

4. Log `persona_injected` event per `agents/pm-reference/event-schemas.md`.

Injection order in the delegation prompt:
1. `## Repository Map` (existing, step 9)
2. `## Project Persona` (new, step 9.5)
3. `## Upstream Reasoning Context` (existing, Section 11.Y)
4. `## Context from Previous Agent` (existing, Section 11)
5. Playbook instructions (existing, step 6)
6. Correction patterns (existing, steps 7-8)
7. Task description and requirements
