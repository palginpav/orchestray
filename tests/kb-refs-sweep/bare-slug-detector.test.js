'use strict';

/**
 * Tests for bin/_lib/kb-slug-detector.js — K4 two-signal bare-slug detection rule.
 *
 * § Test matrix (≥ 20 cases):
 *   Roadmap §4.B.5 table (cases 1–10) + combinatorial (cases 11–22+).
 *
 * v2.1.7 — Bundle B.
 */

const test   = require('node:test');
const assert = require('node:assert');
const { performance } = require('node:perf_hooks');

const { detectBareSlug, detectAllBareSlugs } = require('../../bin/_lib/kb-slug-detector');

// ---------------------------------------------------------------------------
// Roadmap §4.B.5 table cases (1–10)
// ---------------------------------------------------------------------------

test('case 1 — true-pos: list item + "See also:"', () => {
  const result = detectBareSlug('- See also: foo-bar-baz', '', false, []);
  assert.equal(result.hit, true, 'expected hit');
  assert.equal(result.slug, 'foo-bar-baz');
});

test('case 2 — true-pos: link context with "See also:" prefix', () => {
  // "See also: [foo-bar-baz](../patterns/foo-bar-baz.md)" — slug in link target
  const line = 'See also: [foo-bar-baz](../patterns/foo-bar-baz.md)';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, true, 'expected hit for slug inside link target');
  assert.equal(result.slug, 'foo-bar-baz');
});

test('case 3 — true-pos: table cell with "Ref" prefix', () => {
  const line = '| Ref | cached-prompt-design |';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, true, 'expected hit for table cell with Ref prefix');
  assert.equal(result.slug, 'cached-prompt-design');
});

test('case 4 — false-pos-fixed: general prose with "refers to" but no list/table/link context', () => {
  // v2.1.6 would flag this; K4 must not.
  const line = 'This is a sentence that refers to the older design for reasons.';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'must not flag general prose even with prefix phrase');
});

test('case 5 — false-pos-fixed: "see also" but no slug-shape followed by list/link/table', () => {
  // Prefix fires but there is no slug-shaped word in list/table/link context.
  const line = 'We see also that consistency matters.';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'must not flag — no slug-shape in structural context');
});

test('case 6 — ignore-list: slug my-safe-slug in ignoreList is suppressed', () => {
  const line = '- See also: my-safe-slug';
  const result = detectBareSlug(line, '', false, ['my-safe-slug']);
  assert.equal(result.hit, false, 'ignored slug must not flag');
  assert.equal(result.reason, 'ignored');
});

test('case 7 — regression: true positive preserved — list item with "ref:"', () => {
  const line = '- ref: known-pattern-slug';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, true, 'true positive list item ref must still flag');
  assert.equal(result.slug, 'known-pattern-slug');
});

test('case 8a — degenerate: empty line', () => {
  const result = detectBareSlug('', '', false, []);
  assert.equal(result.hit, false, 'empty line must not flag');
});

test('case 8b — degenerate: HTML comment line', () => {
  const line = '<!-- See also: hidden-slug-here -->';
  const result = detectBareSlug(line, '', false, []);
  // HTML comment contains the prefix and a slug-shape — but no list/table/link structure.
  // Must not flag (line is not a list item, not a table, the slug is not in a link target).
  assert.equal(result.hit, false, 'HTML comment without structural context must not flag');
});

test('case 8c — degenerate: code-fence interior (caller skips code fences, detector sees clean line)', () => {
  // The detector itself does not track fence state — the caller does.
  // If a fence-interior line is passed, the detector applies the normal rule.
  // A plain code identifier line has no prefix phrase, so it must not flag.
  const line = '  my-cool-function-name()';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'bare code identifiers without prefix must not flag');
});

test('case 9 — adversarial: "linked" as a verb in prose (no list/table/link context)', () => {
  const line = 'The two modules are linked together by the main router.';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, '"linked" as verb in prose must not flag');
});

test('case 10 — performance: 10k-line file scans in < 500 ms', () => {
  // Build a 10k-line file mix: prose, list items, table rows, links.
  const lines = [];
  for (let i = 0; i < 10000; i++) {
    const mod = i % 10;
    if (mod === 0) lines.push('- See also: foo-bar-baz');
    else if (mod === 1) lines.push('| Ref | cached-prompt-design |');
    else if (mod === 2) lines.push('This is general prose about linked modules and refers to things.');
    else if (mod === 3) lines.push('See also: [foo-bar-baz](../patterns/foo-bar-baz.md)');
    else if (mod === 4) lines.push('  * refers to: deep-slug-name');
    else if (mod === 5) lines.push('No references at all on this line.');
    else if (mod === 6) lines.push('  1. compare: another-test-slug');
    else if (mod === 7) lines.push('```\ncode block interior\n```');
    else if (mod === 8) lines.push('- linked: ignored-slug-value');
    else            lines.push('Just plain text with a word like feature-flag-value that means nothing.');
  }
  const content = lines.join('\n');
  const lineArr = content.split('\n');

  const ignoreList = [];
  const t0 = performance.now();
  let prevLine = '';
  for (const line of lineArr) {
    detectAllBareSlugs(line, prevLine, false, ignoreList);
    prevLine = line;
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 500, `10k-line scan took ${elapsed.toFixed(1)} ms — exceeds 500 ms limit`);
});

// ---------------------------------------------------------------------------
// Combinatorial cases (11–22)
// ---------------------------------------------------------------------------

test('case 11 — nested list item with "cf." prefix', () => {
  // "  - cf. some-nested-slug" — nested list + cf. prefix.
  const line = '  - cf. some-nested-slug';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, true, 'nested list item with cf. prefix must flag');
  assert.equal(result.slug, 'some-nested-slug');
});

test('case 12 — HTML comment line with only comment markers, no slug', () => {
  const line = '<!-- This is a comment with no slug-shaped content. -->';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'comment without slug-shaped content must not flag');
});

test('case 13 — code-fence opening line is not a slug reference', () => {
  // The ``` line itself toggles the fence but should never be a slug reference.
  const line = '```javascript';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'code-fence open line must not flag');
});

test('case 14 — fenced-block spillover: line after closing fence is normal', () => {
  // After a closing ```, the next line is back in prose — no structural context means no flag.
  const line = 'This prose line follows a code block.';
  const result = detectBareSlug(line, '```', false, []);
  assert.equal(result.hit, false, 'prose after fence close without structural context must not flag');
});

test('case 15 — table with pipe in content: slug-like word in table cell with prefix on prev line', () => {
  // Previous line has "See also", current line is a table row.
  const prevLine = 'See also:';
  const line = '| design-pattern-name | description here |';
  const result = detectBareSlug(line, prevLine, false, []);
  assert.equal(result.hit, true, 'table cell with prefix on prev line must flag');
});

test('case 16 — link-title vs link-target: slug in link text (not target) does not qualify via link-context signal', () => {
  // [foo-bar-baz](https://example.com) — slug in link TEXT, not target.
  // The target is a URL, not a slug reference — no structural signal fires via link-context.
  // But there is also no list/table structure. With no prefix phrase, it cannot flag.
  const line = '[foo-bar-baz](https://example.com/some/path)';
  const result = detectBareSlug(line, '', false, []);
  // No prefix phrase, no list/table context → no hit.
  assert.equal(result.hit, false, 'slug only in link text with no prefix must not flag');
});

test('case 17 — slug-like URL path segment: does not flag if no structural context', () => {
  // "https://example.com/my-cool-page" contains "my-cool-page" which is slug-shaped.
  // But the line has no prefix and no structural context.
  const line = 'Visit https://example.com/my-cool-page for details.';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'URL path segment without prefix/context must not flag');
});

test('case 18 — slug-shape-but-uppercase: UPPER-CASE-THING does not match slug shape', () => {
  // Slug shape requires lowercase start: /^[a-z][a-z0-9-]{3,40}$/.
  const line = '- See also: UPPER-CASE-THING';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'uppercase slug-shape must not flag — slug shape requires lowercase');
});

test('case 19 — slug-shape-too-short: "ab" is only 2 chars, does not match min length', () => {
  const line = '- See also: ab';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'slug shorter than 4 chars must not match');
});

test('case 20 — slug-shape-too-long: slug exceeding 41 chars does not match', () => {
  // 42 chars: 1 letter + 41 = exceeds max of 40 for the trailing part.
  const tooLong = 'a' + 'b'.repeat(41); // 42 chars total
  const line = `- See also: ${tooLong}`;
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, false, 'slug > 41 chars must not match');
});

test('case 21 — multiple slugs on one list line: detectAllBareSlugs returns all hits', () => {
  const line = '- See also: foo-bar-baz and compare: another-test-slug';
  const hits = detectAllBareSlugs(line, '', false, []);
  const slugs = hits.map((h) => h.slug);
  assert.ok(slugs.includes('foo-bar-baz'), 'must include foo-bar-baz');
  assert.ok(slugs.includes('another-test-slug'), 'must include another-test-slug');
  assert.ok(hits.length >= 2, `expected >= 2 hits, got ${hits.length}`);
});

test('case 22 — ignore list with multiple entries: all ignored slugs are suppressed', () => {
  const ignoreList = ['foo-bar-baz', 'another-test-slug'];
  const hits = detectAllBareSlugs('- See also: foo-bar-baz', '', false, ignoreList);
  assert.equal(hits.length, 0, 'ignored slug must be suppressed');
});

test('case 23 — ordered list item (digits) with "ref:"', () => {
  const line = '  3. ref: my-ordered-slug';
  const result = detectBareSlug(line, '', false, []);
  assert.equal(result.hit, true, 'ordered list item with ref: must flag');
  assert.equal(result.slug, 'my-ordered-slug');
});

test('case 24 — prefix on previous line, slug on current list item', () => {
  // Two-line pattern: prev line has the prefix, current line is a list item.
  const prevLine = 'See also:';
  const line = '- my-pattern-slug';
  const result = detectBareSlug(line, prevLine, false, []);
  assert.equal(result.hit, true, 'prefix on prev line + list item must flag');
});

test('case 25 — reference-style link: [text][slug-ref] — slug in ref part', () => {
  const line = 'Ref: [some text][design-pattern-name]';
  const result = detectBareSlug(line, '', false, []);
  // prefix "Ref:" fires; "design-pattern-name" is in link reference context (signal2 via link)
  assert.equal(result.hit, true, 'reference-style link with Ref prefix must flag');
});

// ---------------------------------------------------------------------------
// SEC-06: Stateless /g regex — calling detector twice on same input must
// return identical results regardless of call order.
// ---------------------------------------------------------------------------

test('SEC-06 — detectBareSlug is deterministic across repeated calls on same input', () => {
  const line = '- See also: foo-bar-baz';
  const first  = detectBareSlug(line, '', false, []);
  const second = detectBareSlug(line, '', false, []);
  const third  = detectBareSlug(line, '', false, []);
  assert.equal(first.hit,  true, 'first call must hit');
  assert.equal(second.hit, true, 'second call must hit (stateful /g would fail here)');
  assert.equal(third.hit,  true, 'third call must hit');
  assert.equal(first.slug,  second.slug,  'slug must be identical across calls');
  assert.equal(second.slug, third.slug,   'slug must be identical across calls');
});

test('SEC-06 — detectAllBareSlugs returns same hits on identical input across calls', () => {
  const line = '- See also: foo-bar-baz and Ref: another-test-slug';
  const first  = detectAllBareSlugs(line, '', false, []).map((h) => h.slug).sort();
  const second = detectAllBareSlugs(line, '', false, []).map((h) => h.slug).sort();
  assert.deepEqual(first, second, 'detectAllBareSlugs must return identical results on repeated calls');
});

test('SEC-06 — no-hit line stays a no-hit across repeated calls (lastIndex guard)', () => {
  // If lastIndex leaked, a prior hit-line's state could affect a no-hit-line result.
  const hitLine   = '- See also: foo-bar-baz';
  const noHitLine = 'plain sentence without any qualifying prefix';
  // Interleave calls to stress the stateful-regex scenario.
  detectBareSlug(hitLine,   '', false, []);
  const r = detectBareSlug(noHitLine, '', false, []);
  detectBareSlug(hitLine,   '', false, []);
  const r2 = detectBareSlug(noHitLine, '', false, []);
  assert.equal(r.hit,  false, 'no-hit line must not flag after a hit-line call');
  assert.equal(r2.hit, false, 'no-hit line must not flag after a hit-line call (second check)');
});
