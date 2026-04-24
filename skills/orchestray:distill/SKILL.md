---
name: distill
description: Alias for /orchestray:learn-doc — distill a URL into a reusable skill pack
disable-model-invocation: true
argument-hint: "<url>"
---

# Distill — alias for `/orchestray:learn-doc`

The user invoked `/orchestray:distill <url>`. This command is a registered
alias for `/orchestray:learn-doc` and produces identical output for the same
URL.

## Protocol

Execute the protocol defined in `skills/orchestray:learn-doc/SKILL.md` using
`$ARGUMENTS` as the input. The two entry points share:

- The same URL parsing and validation.
- The same cache-check logic at `.orchestray/skills/learn-doc/<slug>.md`.
- The same WebFetch + distiller flow (see
  `skills/orchestray:learn-doc/distiller.md`).
- The same write step via `node bin/learn-doc.js --url "<url>" ...`.
- The same source-aware expiry (14 / 30 / 90 days).

Do NOT invent a separate cache path. Both entry points write to
`.orchestray/skills/learn-doc/<slug>.md` so the first caller wins regardless
of which alias was used.

Follow the six protocol steps in `skills/orchestray:learn-doc/SKILL.md`:

1. Validate the URL.
2. Check the cache.
3. Fetch the URL with `WebFetch`.
4. Distill via the prompt in `skills/orchestray:learn-doc/distiller.md`.
5. Commit via `node bin/learn-doc.js`.
6. Report the output path and expiry.

Report the final summary with the note that this was invoked via
`/orchestray:distill`. The output file is the same either way.
