'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseSections, reassembleSections } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/parse-sections.js')
);

// ---------------------------------------------------------------------------
// parseSections
// ---------------------------------------------------------------------------

test('parseSections: empty string returns empty array', () => {
  const result = parseSections('');
  assert.deepEqual(result, []);
});

test('parseSections: throws TypeError on non-string input', () => {
  assert.throws(() => parseSections(null), { name: 'TypeError' });
  assert.throws(() => parseSections(42), { name: 'TypeError' });
  assert.throws(() => parseSections(undefined), { name: 'TypeError' });
});

test('parseSections: input with no H2 headings returns single section with heading null', () => {
  const input = 'Hello world\nNo headings here.\nJust plain text.\n';
  const sections = parseSections(input);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, null);
  assert.equal(sections[0].body, input);
  assert.equal(sections[0].raw, input);
  assert.equal(sections[0].byteOffset, 0);
});

test('parseSections: preamble only (no headings) body equals the full input', () => {
  const input = 'Preamble content.\n### H3 inside preamble\nmore content\n';
  const sections = parseSections(input);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, null);
  assert.equal(sections[0].raw, input);
});

test('parseSections: input starting directly with H2 produces no preamble section', () => {
  const input = '## Heading One\nBody of first section.\n';
  const sections = parseSections(input);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, '## Heading One');
});

test('parseSections: preamble before first H2 produces two sections', () => {
  const input = 'Preamble text here.\n## First Section\nSection body.\n';
  const sections = parseSections(input);
  assert.equal(sections.length, 2);
  // First is preamble with null heading
  assert.equal(sections[0].heading, null);
  assert.equal(sections[0].raw, 'Preamble text here.\n');
  // Second is the H2
  assert.equal(sections[1].heading, '## First Section');
  assert.equal(sections[1].raw, '## First Section\nSection body.\n');
});

test('parseSections: multiple H2 headings produces correct section count', () => {
  const input = [
    '## Alpha',
    'Alpha body.',
    '## Beta',
    'Beta body.',
    '## Gamma',
    'Gamma body.',
    '',
  ].join('\n');
  const sections = parseSections(input);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading, '## Alpha');
  assert.equal(sections[1].heading, '## Beta');
  assert.equal(sections[2].heading, '## Gamma');
});

test('parseSections: sections are in correct order', () => {
  const input = '## First\nfirst body\n## Second\nsecond body\n## Third\nthird body\n';
  const sections = parseSections(input);
  assert.equal(sections[0].heading, '## First');
  assert.equal(sections[1].heading, '## Second');
  assert.equal(sections[2].heading, '## Third');
});

test('parseSections: byteOffset of each section matches position in original string', () => {
  const preamble = 'Preamble.\n';
  const h1Line = '## Section One\n';
  const h1Body = 'body one\n';
  const h2Line = '## Section Two\n';
  const h2Body = 'body two\n';
  const input = preamble + h1Line + h1Body + h2Line + h2Body;
  const sections = parseSections(input);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].byteOffset, 0);
  assert.equal(sections[1].byteOffset, preamble.length);
  assert.equal(sections[2].byteOffset, preamble.length + h1Line.length + h1Body.length);
});

test('parseSections: H3 headings inside H2 section stay with the H2 — not split points', () => {
  const input = [
    '## Outer Section',
    'intro text',
    '### Sub-heading A',
    'content A',
    '### Sub-heading B',
    'content B',
    '## Next Section',
    'next body',
    '',
  ].join('\n');
  const sections = parseSections(input);
  // Must be exactly 2 sections — H3s do not create new splits
  assert.equal(sections.length, 2);
  assert.equal(sections[0].heading, '## Outer Section');
  assert.ok(
    sections[0].raw.includes('### Sub-heading A'),
    'H3 sub-heading A must be inside first section'
  );
  assert.ok(
    sections[0].raw.includes('### Sub-heading B'),
    'H3 sub-heading B must be inside first section'
  );
  assert.equal(sections[1].heading, '## Next Section');
});

test('parseSections: H3 at start of input is NOT treated as H2', () => {
  const input = '### Only an H3\nsome content\n';
  const sections = parseSections(input);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, null);
});

test('parseSections: raw fields concatenate to reproduce the original input exactly', () => {
  const input = 'Preamble.\n## Alpha\nalpha body\n## Beta\nbeta body\n';
  const sections = parseSections(input);
  const rebuilt = sections.map(s => s.raw).join('');
  assert.equal(rebuilt, input);
});

test('parseSections: each section body starts with heading line when heading != null', () => {
  const input = '## Section One\nbody one\n## Section Two\nbody two\n';
  const sections = parseSections(input);
  for (const s of sections) {
    if (s.heading !== null) {
      assert.ok(s.body.startsWith(s.heading), `body of "${s.heading}" should start with heading line`);
    }
  }
});

// ---------------------------------------------------------------------------
// reassembleSections
// ---------------------------------------------------------------------------

test('reassembleSections: throws TypeError on non-array input', () => {
  assert.throws(() => reassembleSections(null), { name: 'TypeError' });
  assert.throws(() => reassembleSections('string'), { name: 'TypeError' });
});

test('reassembleSections: empty array returns empty string', () => {
  assert.equal(reassembleSections([]), '');
});

test('reassembleSections: excludes sections marked dropped:true', () => {
  const sections = [
    { raw: 'keep this\n', dropped: false },
    { raw: 'drop this\n', dropped: true },
    { raw: 'keep this too\n' },
  ];
  assert.equal(reassembleSections(sections), 'keep this\nkeep this too\n');
});

test('reassembleSections: sections without dropped field are included', () => {
  const sections = [
    { raw: 'section one\n' },
    { raw: 'section two\n' },
  ];
  assert.equal(reassembleSections(sections), 'section one\nsection two\n');
});

// ---------------------------------------------------------------------------
// Round-trip property
// ---------------------------------------------------------------------------

function roundTrip(input) {
  const sections = parseSections(input);
  const marked = sections.map(s => ({ ...s, dropped: false }));
  return reassembleSections(marked);
}

test('round-trip: plain text with no headings is byte-identical', () => {
  const input = 'Just plain text.\nNo headings.\nMultiple lines.\n';
  assert.equal(roundTrip(input), input);
});

test('round-trip: single H2 section is byte-identical', () => {
  const input = '## Single Section\nBody content here.\n';
  assert.equal(roundTrip(input), input);
});

test('round-trip: preamble + multiple sections is byte-identical', () => {
  const input = [
    'Preamble line one.',
    'Preamble line two.',
    '',
    '## Acceptance Rubric',
    '- criterion one',
    '- criterion two',
    '',
    '## Structured Result',
    '```json',
    '{"status":"done"}',
    '```',
    '',
    '## Repository Map',
    'src/foo.js',
    'src/bar.js',
    '',
  ].join('\n');
  assert.equal(roundTrip(input), input);
});

test('round-trip: input with H3 sub-headings inside H2 is byte-identical', () => {
  const input = [
    '## Outer',
    'intro',
    '### Sub A',
    'content A',
    '### Sub B',
    'content B',
    '## Other',
    'other body',
    '',
  ].join('\n');
  assert.equal(roundTrip(input), input);
});

test('round-trip: input with unicode characters is byte-identical', () => {
  const input = '## Section With Unicode\nCafé résumé naïve\n日本語テスト\n🚀 emoji\n';
  assert.equal(roundTrip(input), input);
});

test('round-trip: input ending without trailing newline is byte-identical', () => {
  const input = '## Section\nNo trailing newline';
  assert.equal(roundTrip(input), input);
});

test('round-trip: input with Windows-style line endings preserved', () => {
  const input = '## Section\r\nBody line.\r\n## Second\r\nMore body.\r\n';
  assert.equal(roundTrip(input), input);
});
