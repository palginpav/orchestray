<!-- PM Reference: Loaded by the Section Loading Protocol when an
     <oversized-input-advisory> block is present in context (W5 gate row).
     Realizes §2 of .orchestray/kb/artifacts/rlm-option1-implementation-plan.md. -->

# Oversized-Input Environment Mode (W4, v2.3.14)

This file is the PM's executable protocol for answering a query about a
**user input larger than the context window** — a referenced file/dir over
`oversized_input.threshold_bytes` (1.5 MB default) or pasted text over
`threshold_tokens` (200000 default). The corpus is **never ingested whole**:
a constant-size manifest + sliced read-only scouts + a verified KB buffer
carry the work. Strictly **depth=1** (PM → scout map layer → one synthesis
agent), reusing `haiku-scout`, Section 14 (parallel layer), Section 18
(verify-before-propagate), and the KB.

It is the concrete realization of the W1–W3 foundation already shipped:
`bin/_lib/oversized-input.js` (pure helpers), `bin/detect-oversized-input.js`
(UserPromptSubmit detection hook), and the `oversized_input` config block.

---

## Section OI.1 — Trigger & loading

Enter this mode **only** when an `<oversized-input-advisory>` block is present
in context. The W3 hook injects it on detection with these fields: `corpus_id`,
`manifest` (path), `total_bytes`, `est_tokens`, `trigger` (`pasted`|`file`|`dir`),
and `slice_plan: naturalCount=<N> mode=<direct|hierarchical|refuse>`.

1. **Read the manifest, NEVER the corpus.** Read the `manifest` path only. Its
   `buildManifest` shape is `{ corpusId, totalBytes, estTokens, totalChars,
   fileCount, slicePlan: { naturalCount, capped, mode }, createdAt, sourcePath?,
   trigger }`. The manifest is constant-size; the corpus is not. A full Read of
   the corpus path is a hard invariant violation (Section OI.10).
2. **Corpus location.** For `trigger: 'pasted'`, slices are read from
   `.orchestray/state/input-corpus/<corpus_id>/corpus.txt`. For
   `trigger: 'file' | 'dir'`, slices are read **in place** from
   `manifest.sourcePath` (the hook copied nothing).
3. **Kill switches** (any one → do not enter the mode; the hook also no-ops):
   `oversized_input.enabled: false` in `.orchestray/config.json`, or env
   `ORCHESTRAY_DISABLE_OVERSIZED_INPUT=1`. See Section OI.10.
4. **Pasted-text ceiling.** Pasted text above ~1 MB / ~262k tokens exceeds the
   hook's stdin cap (`MAX_INPUT_BYTES`) and bypasses this mode (hook fails open).
   For inputs that large, reference a file or directory instead.

## Section OI.2 — Mode dispatch (off `slicePlan.mode`)

Dispatch on `manifest.slicePlan.mode`, which the helper already computed:

- **`refuse`** → do NOT slice. The natural slice count exceeds `max_slices`
  and `hierarchical_reduce` is disabled. Surface the hook's refuse advisory to
  the user verbatim in intent: the corpus needs more than `max_slices`
  (default 64) slices. Offer exactly three remedies — (a) raise
  `oversized_input.max_slices`, (b) enable `oversized_input.hierarchical_reduce`,
  or (c) narrow the query to a smaller file/range. **Stop.** Do not spawn.
- **`direct`** → a single map layer (Sections OI.3–OI.6, OI.8).
- **`hierarchical`** → batched map layers (Section OI.7), then OI.8.

## Section OI.3 — Plan slices

Slice boundaries are `[start, end)` character windows computed by `planSlices`
in `bin/_lib/oversized-input.js` (N windows of ~`slice_chars`, 6000 default,
capped at `max_slices`). The CLI in OI.4b pre-extracts each window to a small
`slice-<i>.txt` file; scouts then do a plain whole-file Read of their slice —
never a Read of the original corpus. The invariant is "read only the slice,
never the whole corpus"; OI.4b handles the extraction.

## Section OI.4 — Cost-confirm gate

If the planned scout count (`min(naturalCount, max_slices)`, or the per-layer
batch size under hierarchical mode) is greater than
`oversized_input.confirm_over_slices` (16 default), surface a cost estimate to
the user and **ask before dispatching the map layer**. Use the standard
cost-display format and the ROI-scorecard conventions (see pm.md "ROI scorecard
(mandatory)"). Estimate ≈ `scout_count × map_model per-slice cost` +
`one synthesis_model pass`. Proceed only on confirmation. At or below the
threshold, proceed without prompting.

## Section OI.4b — Generate slice files

Before spawning any scouts, run the slice extractor via Bash to write the
`slice-<i>.txt` files that scouts will Read:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/oversized-extract.js \
  --cwd <cwd> \
  --corpus <corpus_id> \
  [--batch-start <B>] \
  [--max-out <max_slices>]
```

The CLI prints JSON `{ sliceFiles: [{index, path, start, end, chars}], naturalCount, mode, written, error }` to stdout and exits 0 on success (exit 1 if `error` is set). Use `sliceFiles[i].path` as the `SLICE FILE` in each OI.5 scout prompt. For hierarchical mode (OI.7), call once per batch with `--batch-start <B>`.

## Section OI.5 — Map (parallel, Section 14)

Dispatch ONE Section-14 parallel group of `haiku-scout` spawns — one per slice,
model = `oversized_input.map_model` (haiku default); emit `oversized_map_dispatched`
(`corpus_id`, `slice_count`, `map_model`; add `batch` for hierarchical batches).
Follow Section 14 exactly:
write a `routing.jsonl` row per slice (`ox routing add`) BEFORE the first
`Agent()` call; the group-boundary gate keeps the layer disciplined. Concurrency
is bounded by `max_slices`.

```
# One spawn per slice (read-only single-shot reconnaissance — Section 23 scout shape)
Agent(
  subagent_type = "haiku-scout",
  model         = "<map_model>",      # haiku default
  effort        = "low",
  maxTurns      = 3,
  task_id       = "oi-<corpus_id>-slice-<i>",
  prompt = """
    Slice <i>/<N> of an oversized-input corpus.
    SLICE FILE: <sliceFiles[i].path>
    Read ONLY this file (plain whole-file Read — no offset or limit needed).
    Do NOT read the original corpus or any other file.
    USER QUERY: <verbatim user question>
    Return: (1) RELEVANT: yes|no  (2) the extract from this slice that bears on
    the query, verbatim or tightly filtered. No analysis, no recommendations.
  """
)
```

Each scout returns a per-slice extract + a `RELEVANT` flag. Scouts are
read-only (`tools: [Read, Glob, Grep]`) and single-shot — they **cannot spawn**.
This is the depth=1 invariant, enforced structurally by the scout tool set and
`bin/validate-task-completion.js`, not by prose.

## Section OI.6 — Verify before aggregate (Section 18-lite)

Apply verify-before-propagate before anything is reduced:

1. **Drop** every slice whose scout returned `RELEVANT: no`; emit `oversized_slice_skipped` (`corpus_id`, `slice_id`) for each dropped slice.
2. **Keep** the verified partials; append each to a KB buffer artifact
   `kb://artifacts/oversized-buffer-<corpus_id>`, one entry per kept slice,
   tagged with its **slice id** for provenance (`oi-<corpus_id>-slice-<i>`,
   range `[start,end)`).

Never propagate an unverified partial into synthesis (Section 18 post-condition
discipline). The buffer — not the corpus — is the only thing that crosses into
the reduce step.

## Section OI.7 — Hierarchical reduce (mode = `hierarchical`)

When `slicePlan.mode === 'hierarchical'`, the natural slice count exceeds
`max_slices` but reduction is permitted:

1. Map the slices in **batches of `max_slices`** — each batch is its own
   Section-14 group (Section OI.5), gated and cost-confirmed (Section OI.4).
2. After each batch, reduce its kept partials into a **batch partial** written
   to the buffer (`...-batch-<b>`), then discard the per-slice entries for that
   batch to keep the buffer bounded.
3. When all batches are reduced, reduce the **batch partials** into the final
   buffer state.

Every layer is PM-authored and still **depth=1** — no scout spawns a sub-agent,
no nested reduction agents. Total scout count stays bounded by
`naturalCount` (each slice mapped once); only the reduction fan-in grows, and
it is PM-local.

## Section OI.8 — Reduce / synthesize

ONE synthesis agent produces the final answer. It reads **only** the buffer
artifact — never the corpus, never `sourcePath`, never `corpus.txt`. After
the synthesis agent completes, emit `oversized_synthesis_complete` (`corpus_id`,
`slices_kept`, `synthesis_model`).

```
Agent(
  subagent_type = "documenter",        # synthesis_model role. MUST be a role WITHOUT the
                                       # Agent tool so it cannot spawn (preserves depth=1).
                                       # Do NOT use general-purpose here — it can spawn.
  model         = "<synthesis_model>", # sonnet default
  effort        = "medium",
  task_id       = "oi-<corpus_id>-synthesis",
  prompt = """
    Read ONLY kb://artifacts/oversized-buffer-<corpus_id>. Do NOT read
    <sourcePath|corpus.txt> — it is out of bounds.
    Answer the user query from the buffered verified partials. Cite each claim
    back to its slice id (oi-<corpus_id>-slice-<i>). If the buffer is insufficient
    to answer, say so and name the gap — do not invent.
  """
)
```

The synthesis agent's `files_read` MUST be the buffer artifact only; a corpus
path in `files_read` is an invariant violation.

## Section OI.9 — Report

Return the synthesized answer plus a **one-line cost/slice summary** in the
Orchestration ROI scorecard (pm.md "ROI scorecard (mandatory)"): slices mapped,
slices kept, map model, synthesis model, estimated cost. The corpus staging dir
`.orchestray/state/input-corpus/<corpus_id>/` is reclaimed by the existing
`state-gc` (`bin/state-gc.js`) — do not delete it manually.

## Section OI.10 — Invariants & kill switches

**Invariants (binding):**
- **Never full-read the corpus.** The PM reads the manifest; scouts read only
  their `[start,end)` window; synthesis reads only the buffer.
- **Bounded fan-out.** ≤ `max_slices` scouts per map layer; over the natural cap
  → hierarchical reduce or `refuse`, never unbounded spawning.
- **Depth=1.** PM → scout map layer → one synthesis agent. Scouts and the
  synthesis agent cannot spawn. No recursion, no nested sub-agents.
- **Fail-safe.** If `slicePlan`, `trigger`, or `sourcePath` is missing/ambiguous,
  do NOT guess — fall back to asking the user (Section 14.Y `ask_user`) or to a
  normal single-question flow. Ambiguity never escalates fan-out.

**Kill switches:**
- Config: `oversized_input.enabled: false` in `.orchestray/config.json`.
- Env (current session): `ORCHESTRAY_DISABLE_OVERSIZED_INPUT=1`.

When either is active the W3 hook no-ops (no advisory injected), this mode is
never entered, and prior single-question behavior is byte-identical.
