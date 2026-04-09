<!-- PM Reference: Loaded by Section Loading Protocol when adversarial_review is true AND complexity score >= 8 -->

## 38. Adversarial Architecture Review

For very high complexity tasks, optionally run two competing architect designs in parallel to select the better approach before proceeding to implementation.

### Trigger Conditions

Both conditions must be true:

1. **Complexity score >= 8** (from Section 12 complexity scoring)
2. **Config `adversarial_review` is `true`** (default: `false` -- this is a premium opt-in feature)

If either condition is false, skip this section. The normal single-architect flow (Section 13, in tier1-orchestration.md) applies.

### Protocol

This section replaces the single architect step in Section 13's task decomposition when triggered.

1. **Spawn two architect agents in parallel** with the same task description but different directives:

   **Architect A prompt:**
   ```
   Design Approach A for the following task. Focus on **simplicity and minimal changes**:
   prefer fewer files, smaller interfaces, and the least disruptive path to solving the problem.
   Task: <task description>
   Existing context: <repo map / pre-scan findings from Section 12>
   ```

   **Architect B prompt:**
   ```
   Design Approach B for the following task. Focus on **robustness and extensibility**:
   prefer clean abstractions, clear separation of concerns, and a design that anticipates
   future requirements.
   Task: <task description>
   Existing context: <repo map / pre-scan findings from Section 12>
   ```

2. **Both architects use model: Opus** (adversarial review is reserved for high-complexity tasks where deeper reasoning pays off).

3. **PM evaluates both designs** by comparing on four criteria:
   - **Scope:** How many files and changes are estimated?
   - **Complexity:** How hard will the implementation be?
   - **Risk:** What are the identified risk areas?
   - **Task alignment:** How well does it address the stated requirements?

4. **Select the better design.** Write a brief justification (2-4 sentences) explaining what made the selected design preferable. If both designs are roughly equivalent, select A (simpler).

5. **Proceed to developer with the selected design.** Include the justification in the developer's delegation context.

### Cost Tracking

Track both architects separately in the audit trail. Log a `adversarial_review` event:
```json
{
  "timestamp": "<ISO 8601>",
  "type": "adversarial_review",
  "orchestration_id": "<orch-id>",
  "architect_a_cost_usd": 0.12,
  "architect_b_cost_usd": 0.11,
  "selected": "A",
  "justification": "<2-4 sentence summary>"
}
```

### Transparency

Announce when spawning both architects:
`Adversarial architecture review active (complexity score: <N>/12). Running two competing Opus designs in parallel (~2x architect cost).`

After selection:
`Selected Approach <A|B>: <justification>`
