'use strict';

/**
 * schemas/_yaml.js — minimal YAML frontmatter parser used by the zod boot
 * validator.
 *
 * v2.1.13 R-ZOD. The existing parser in `bin/validate-specialist.js` only
 * handles `key: value` and bracket arrays; it concatenates block-sequence
 * continuation lines (`  - item`) into a single string, which causes false
 * negatives when the zod schema expects an array.
 *
 * We intentionally don't reach for `js-yaml` — the plan's "What NOT to Add"
 * list keeps runtime deps minimal; zod is the one addition for v2.1.13.
 *
 * Supported subset:
 *   - `key: value`                       → string (with quote stripping)
 *   - `key: [a, b, c]`                   → array
 *   - `key:\n  - a\n  - b`               → array (block sequence)
 *   - `key: >-`-style folded scalars     → NOT supported (fall back to empty string)
 *   - nested objects                     → NOT supported
 *
 * Returns `null` when no frontmatter block is present.
 *
 * @param {string} content - Raw file contents.
 * @returns {{ frontmatter: object, body: string } | null}
 */
function parseFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const raw = match[1];
  const body = match[2] || '';
  const frontmatter = {};

  const lines = raw.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // Only parse key:value at column 0 (no leading whitespace) — nested
    // fields are handled as continuation of the parent key.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }

    const key = m[1];
    let value = m[2];

    // `key: [a, b, c]` — inline array
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      frontmatter[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
      i++;
      continue;
    }

    // `key: "quoted"` / `key: 'quoted'` / `key: bare`
    if (value !== '') {
      value = value.replace(/^["'](.*)["']\s*$/, '$1');
      frontmatter[key] = value;
      i++;
      continue;
    }

    // `key:` with no value → look ahead for either a block sequence
    //   (indented lines starting with `-`) or a multi-line scalar
    //   (indented continuation lines).
    let j = i + 1;
    // First, decide: is the next non-empty line a `- item` sequence entry?
    while (j < lines.length && lines[j].trim().length === 0) j++;

    if (j < lines.length && /^\s+-\s+/.test(lines[j])) {
      // Block sequence
      const arr = [];
      while (j < lines.length) {
        const ln = lines[j];
        if (ln.trim().length === 0) { j++; continue; }
        const seqMatch = ln.match(/^\s+-\s+(.*)$/);
        if (!seqMatch) break;
        let item = seqMatch[1].trim();
        item = item.replace(/^["'](.*)["']\s*$/, '$1');
        arr.push(item);
        j++;
      }
      frontmatter[key] = arr;
      i = j;
      continue;
    }

    // Multi-line scalar: join indented lines until we hit another
    // top-level `key:` or the end of the frontmatter.
    let scalar = '';
    while (j < lines.length) {
      const ln = lines[j];
      if (ln.trim().length === 0) { j++; continue; }
      // New top-level key? — stop collecting continuation lines.
      if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(ln)) break;
      scalar = (scalar ? scalar + ' ' : '') + ln.trim();
      j++;
    }
    frontmatter[key] = scalar;
    i = j;
  }

  return { frontmatter, body };
}

module.exports = { parseFrontmatter };
