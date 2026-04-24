---
name: learn-doc
description: Turn a URL into a reusable, auto-loaded skill pack
disable-model-invocation: true
argument-hint: "<url>"
---

# Learn Doc — URL → Skill Pack

The user invoked `/orchestray:learn-doc <url>` (or its alias `/orchestray:distill <url>`).
Paste a URL the user keeps repeating in prompts, and this command distills it into a
reusable skill pack that future agent sessions auto-load from
`.orchestray/skills/learn-doc/`.

Distilled skill packs are source-aware:

| Source                                                                  | Expiry |
|-------------------------------------------------------------------------|--------|
| `code.claude.com/docs/` or `docs.anthropic.com/en/docs/claude-code/`    | 14 days |
| `platform.claude.com/docs/` or other `docs.anthropic.com/en/`           | 30 days |
| Anything else                                                           | 90 days |

The expiry is stamped into the skill-pack frontmatter (`expires_at`, `expiry_days`)
so future agents can self-police stale caches.

---

## Protocol

### Step 1 — Validate the URL

Parse `$ARGUMENTS`. The first whitespace-separated token is the URL. If
`$ARGUMENTS` is empty or does not start with `http://` or `https://`:

> "Usage: `/orchestray:learn-doc <url>` — paste a URL to distill into a reusable
> skill pack."

Stop.

### Step 2 — Check the cache

Compute the slug using the same rules as `bin/learn-doc.js` (host + pathname,
lowercased, non-word → `-`). Look for an existing skill pack at:

```
.orchestray/skills/learn-doc/<slug>.md
```

If the file exists and its `expires_at` frontmatter value is in the future:

> "Skill pack already cached at `.orchestray/skills/learn-doc/<slug>.md`
> (expires {expires_at}). To refresh early: delete the file
> (`rm .orchestray/skills/learn-doc/<slug>.md`) and re-run."

Stop.

If the file exists but is expired, proceed with Step 3 — the write in Step 5
overwrites stale caches in place.

### Step 3 — Fetch the URL

Use the `WebFetch` tool to retrieve the URL. Pass a focused prompt such as:

> "Return the full primary content of this page as clean markdown. Strip
> navigation, footers, and marketing boilerplate. Preserve headings, code
> blocks, tables, and inline links."

Store the fetched markdown in memory for the next step. If WebFetch fails or
returns an empty body, report the failure and stop — do NOT write a skill pack
with no content.

### Step 4 — Distill via subagent prompt

Spawn a **researcher** subagent (model: `sonnet`, effort: `medium`) and supply
the prompt in `skills/orchestray:learn-doc/distiller.md` along with two inputs:

1. The URL.
2. The fetched markdown from Step 3.

The distiller returns a compressed, reusable skill-pack body (sections: Purpose,
Key Concepts, Canonical Examples, Gotchas, Source Anchors). Full rules are in
`distiller.md`.

### Step 5 — Commit the skill pack

Write the distilled body to disk by invoking the bin script:

```
node bin/learn-doc.js --url "<url>" --title "<title>" --content-file <tmp-file>
```

- Write the distilled body to a tmp file first (e.g.
  `.orchestray/tmp/learn-doc-<slug>.md`) so the shell argument stays small.
- `--title` is optional; defaults to the last pathname segment.
- The script writes to `.orchestray/skills/learn-doc/<slug>.md` and stamps
  `fetched_at` / `expires_at` frontmatter using the source-aware rules above.

### Step 6 — Report

Print a one-line summary with the output path and expiry:

> "Cached skill pack at `.orchestray/skills/learn-doc/<slug>.md` — expires
> {expires_at} ({expiry_days} days)."

### Alias

`/orchestray:distill <url>` is a registered alias for this command. Both
entry points use identical logic and produce identical output. See
`skills/orchestray:distill/SKILL.md`.
