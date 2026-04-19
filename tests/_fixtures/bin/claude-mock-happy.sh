#!/usr/bin/env bash
# claude-mock-happy.sh — mock claude that returns a valid ExtractorOutput JSON.
# Used by haiku-backend.test.js happy-path test.
# Arguments: --agent pattern-extractor -p <payload> (ignored)

cat <<'EOF'
{
  "schema_version": 1,
  "proposals": [
    {
      "slug": "parallel-developer-reviewer-small-tasks",
      "category": "decomposition",
      "tip_type": "strategy",
      "title": "Parallel developer+reviewer shortens small tasks",
      "context_md": "Applies when complexity_score < 5 and phase is implementation.",
      "approach_md": "Two agent_start events (developer, reviewer) within the same timestamp bucket. Both agent_stop outcome: success. orchestration_complete outcome: success, zero replan_triggered.",
      "evidence_refs": ["orch-test-001"],
      "source_event_ids": ["orch-test-001"],
      "proposed_confidence": 0.55
    }
  ],
  "skipped": [],
  "budget_used": { "input_tokens": 120, "output_tokens": 80, "elapsed_ms": 1200 }
}
EOF
