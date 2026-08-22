#!/usr/bin/env node
'use strict';

/**
 * inject-review-dimensions.js — RETIRED (v2.3.31 W8B).
 *
 * Superseded: this hook emitted `updatedInput` to append the
 * `## Dimensions to Apply` block onto reviewer spawn prompts, but it ran as
 * a SIBLING PreToolUse:Agent hook alongside validate-reviewer-dimensions.js.
 * `updatedInput` from one PreToolUse:Agent hook does NOT propagate to
 * another (Claude Code platform constraint — see the same defect class
 * documented at validate-context-size-hint.js:18-34). The validator that
 * actually gates reviewer spawns always read the ORIGINAL prompt and never
 * observed this hook's injection, so it blocked every reviewer spawn that
 * lacked a hand-written block regardless of this hook running.
 *
 * The live implementation is now bin/validate-reviewer-dimensions.js, which
 * computes the same classification and appends the same block itself,
 * inside the hook that gates the spawn. This file is kept (not deleted) as
 * a documented no-op; it is also unwired from hooks/hooks.json so it no
 * longer executes at all.
 *
 * Do not re-wire this hook without first fixing the sibling-updatedInput
 * propagation problem it was built on.
 */

process.stdout.write(JSON.stringify({ continue: true }));
process.exit(0);
