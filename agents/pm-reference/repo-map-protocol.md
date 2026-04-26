# Repository Map Protocol

Reference for the PM during Step 2.7 (map generation) and Section 3 (map injection
into delegation prompts).

**Status:** Stub doc — full implementation deferred to v2.1.17 architect spike.
Legacy 388-line heuristic preserved as `repo-map-protocol.md.legacy` for one release.

---

## Canonical algorithm

The Aider tree-sitter + PageRank approach is the SOTA for code-aware context
selection (4.3–6.5% context-window utilization vs 54–70% for naive iterative
search). The v2.1.17 implementation should follow this recipe:

1. **Tag extraction.** Parse every source file with `tree-sitter` using the
   appropriate per-language grammar to extract symbol *definitions* (functions,
   classes, methods, types) and *references* (calls, identifier uses). Each
   tag carries `{file, name, kind, line}`.
2. **Reference graph.** Build a directed multigraph where nodes are
   `(file, symbol)` and edges go from a referencing file to the file that
   *defines* the referenced symbol. Edge weight = reference count. Files with
   no defs/refs are dropped.
3. **PageRank ranking.** Run weighted PageRank over the graph with the current
   task's "files of interest" set as personalization vector (mass concentrated
   on files the agent already plans to touch). The ranking surfaces files that
   are structurally important relative to the task, not just lexically nearby.
4. **Fit-to-budget.** Walk the ranked list and emit each file's tag list (defs
   + refs) until the token budget is exhausted. Emit definitions before
   references; truncate references first under pressure.

## Recommended JS dependencies

- `web-tree-sitter` — parser runtime (WASM, cross-platform, no native build).
- `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python` —
  representative language grammars (full set per the architect spike).
- `graphology` — graph data structure.
- `graphology-pagerank` — weighted PageRank with personalization support.

All MIT-licensed and actively maintained (verified 2026-04-25, see W1 research).

## Token-budget heuristic

Aider's default repo-map budget is **~1000 tokens**. Orchestray should make
this configurable per task — small focused diffs can run with 500, cross-cutting
refactors may want 2000–3000. The hard cap stays at 4000 tokens (consistent
with the legacy heuristic doc).

## Integration target

Inject the ranked map into delegation prompts for **developer** and **reviewer**
agents on multi-file changes (≥ 2 files in the task graph's read-or-write set).
Single-file tasks can skip the map; the surrounding source already fits.
Architect and debugger keep the broader Tier-2 view per the legacy filtering
rules.

## Open design questions for the v2.1.17 spike

1. **Language-grammar bundling.** Bundle all grammars (~50 MB WASM) vs lazy-load
   per detected language vs ship a curated top-10 set with a fallback path.
2. **Graph cache invalidation.** Hash-by-file, hash-by-import-set, or just
   regenerate on `git rev-parse HEAD` change. Trade-off between freshness on
   incremental edits and recompute cost on large repos.
3. **Cross-platform native-dep testing.** `web-tree-sitter` is WASM (portable),
   but grammar packages historically had platform-specific build steps. Verify
   on Linux + macOS + Windows in CI before promoting out of feature flag.

## Citations

- [Aider repo map (canonical algorithm description)](https://aider.chat/2023/10/22/repomap.html)
- [pdavis68/RepoMapper (Apache-2 standalone Python port)](https://github.com/pdavis68/RepoMapper)
- [DeepWiki — Aider repository mapping](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping)
- [web-tree-sitter on npm](https://www.npmjs.com/package/web-tree-sitter)
- [graphology-pagerank on npm](https://www.npmjs.com/package/graphology-pagerank)
