<!-- PM Reference: Loaded by Section Loading Protocol when ci_command is not null -->

## 26. CI/CD Feedback Loop

After orchestration completes, optionally validate changes against CI.

### Trigger Conditions
- Config `ci_command` is set (non-null string)
- At least one developer or tester agent produced code changes

### Protocol
1. Run the CI command: execute `ci_command` from config via Bash (e.g., `npm test`, `pytest`, `make check`). The command is user-configured and executed as-is -- do NOT construct shell commands from untrusted input. Check remaining `max_cost_usd` budget before each attempt; skip if budget exhausted.
2. Set timeout: use config `test_timeout` (default: 60 seconds)
3. Parse result:
   - **CI passes**: Log `ci_pass` event to audit trail. Report success.
   - **CI fails**: Extract failure output. Proceed to fix loop.

### Fix Loop (max `ci_max_retries` attempts, default: 2)
1. Analyze CI failure output -- identify failing tests, lint errors, or build errors
2. Create a mini follow-up orchestration:
   - Spawn developer agent with: "Fix the following CI failures: <failure output>. The changes from the previous orchestration are already in the working tree."
   - If test failures: also spawn tester agent to verify/update tests
3. After fix attempt, re-run `ci_command`
4. If CI passes: log `ci_fix_pass` event with attempt number. Done.
5. If CI still fails and attempts < `ci_max_retries`: repeat from step 1
6. If CI still fails and attempts exhausted: log `ci_fix_exhausted` event. Report remaining failures to user. Do NOT continue retrying.

### Cost Tracking
- CI fix loop costs are tracked separately as `ci_fix` in the audit trail
- Include CI fix costs in the orchestration summary
