<!-- PM Reference: Loaded by Tier 2 dispatch when enable_visual_review is true AND UI files detected -->

# Visual Review Protocol

Screenshot-based multi-modal review for UI changes. Uses Claude's native Read tool
to view images -- no external dependencies, no automated capture.

---

## Screenshot Discovery Protocol

When visual review is triggered, scan for screenshots in this priority order. Stop
after the first source that yields results (to avoid duplicate reviews of the same UI).

### Step 1: User-Provided Paths

Check the original user prompt for image file references matching:
`/\S+\.(png|jpg|jpeg|gif|webp)\b/i`

Path containment: Resolve all user-provided paths. Reject any path that does
not start with the project root directory. Only accept relative paths or
absolute paths within the project. This prevents reading files outside the
project boundary.

Validate each path exists using Read. Discard paths that do not resolve to a file.

### Step 2: Convention Directory

Glob for `.orchestray/screenshots/*.{png,jpg,jpeg,gif,webp}`.

If `before/` and `after/` subdirectories exist, pair screenshots by filename:
- `.orchestray/screenshots/before/login.png` pairs with `.orchestray/screenshots/after/login.png`
- Unpaired files are treated as standalone screenshots

### Step 3: Project Artifact Directories

Scan known screenshot locations (auto-detected, no configuration):

```
.storybook/screenshots/**/*.{png,jpg,jpeg,gif,webp}
cypress/screenshots/**/*.{png,jpg,jpeg,gif,webp}
tests/screenshots/**/*.{png,jpg,jpeg,gif,webp}
playwright-report/**/*.{png,jpg,jpeg,gif,webp}
__image_snapshots__/**/*.{png,jpg,jpeg,gif,webp}
.loki/**/*.{png,jpg,jpeg,gif,webp}
```

When reading from project artifact directories, prefer screenshots modified after the
orchestration start time (check file mtime via `ls -l`). If mtime filtering is not
practical, include all screenshots but note them as "possibly stale" in the reviewer
delegation.

### Step 4: No Screenshots Found

If no screenshots are found at any source:
- Fall back to standard text-only review (no error, no warning to user)
- Log to audit: `"Visual review enabled but no screenshots available. Text-only review."`
- Proceed with normal reviewer delegation per Section 4 / delegation-templates.md

---

## Screenshot Cap

Maximum **10 screenshots** per review to control context token consumption. Each image
costs approximately 1-2K tokens in multi-modal processing.

Priority when capping:
1. Before/after pairs (count as 2 each, but highest value)
2. User-provided paths
3. Convention directory screenshots
4. Project artifact screenshots

---

## Visual Review Checklist

Injected into the reviewer delegation when screenshots are available. The reviewer
applies this checklist alongside the standard 7-dimension code review.

1. **Layout integrity**: Elements properly aligned, spaced, and contained within parents?
2. **Text rendering**: All text visible, properly sized, not clipped or overflowing?
3. **Color and contrast**: Colors match expected design? Text readable against background?
4. **Typography**: Font sizes, weights, and families consistent with the design system?
5. **Responsive indicators**: If multiple viewport screenshots provided, check consistency across sizes.
6. **Regression signals**: Anything broken, misaligned, or visually different from the code change intent?
7. **Accessibility signals**: Interactive elements visually distinguishable? Sufficient color contrast?

---

## Visual Finding Severity

Visual findings use the same severity levels as code review findings:

- **error**: Visible rendering bug -- broken layout, overlapping elements, invisible text, missing components
- **warning**: Degraded but functional -- spacing inconsistency, contrast borderline, alignment slightly off
- **info**: Cosmetic suggestion -- could be improved but not broken

---

## Screenshot Source Classification

For audit event logging, classify each source:

| Source | Classification |
|--------|---------------|
| User-provided paths | `manual` |
| `.orchestray/screenshots/` | `convention` |
| `.storybook/screenshots/` | `storybook` |
| `cypress/screenshots/` | `cypress` |
| `playwright-report/` | `playwright` |
| `__image_snapshots__/`, `.loki/` | `other` |
| `tests/screenshots/` | `other` |
