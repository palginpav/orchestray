#!/usr/bin/env node
'use strict';

/**
 * Tests for the citation-resolution wiring:
 *   - bin/_lib/pattern-citation-render.js — no branch may omit the body, every
 *     branch carries an exact `slug:` line.
 *   - bin/render-pattern-citations.js — PreToolUse:Agent hook that resolves
 *     `@orchestray:pattern://<slug>` in tool_input.prompt into the pattern text.
 *
 * Closes the two gaps in
 *   .orchestray/kb/decisions/pattern-citation-uri-without-body.md  (dead link)
 *   .orchestray/kb/decisions/pattern-ack-slug-fidelity-limit.md    (slug rewrite)
 *
 * Hook payloads mirror the captured shape in
 * .orchestray/fixtures/record-pattern-offers/*.json (top-level cwd + tool_name +
 * tool_use_id; tool_input carries description/prompt/subagent_type/model/name).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'render-pattern-citations.js');
const { renderCitation, renderPatternsApplied } = require('../_lib/pattern-citation-render');
const { scanOffers } = require('../_lib/pattern-offer-scan');

// --- fixtures --------------------------------------------------------------

const SLUG = 'anti-pattern-regex-false-positives';
const BODY_MARK = 'each alternative must be tested independently';

// Real corpus shape: the frontmatter `name:` differs from the filename slug —
// that mismatch is what the live ack echoed instead of the slug.
function patternFile(body) {
  return [
    '---',
    'name: regex-false-positive-check',
    'category: anti-pattern',
    'confidence: 0.6',
    'times_applied: 0',
    'description: Regex lookahead alternatives can create unintended matches',
    '---',
    '',
    '# Pattern: Regex Lookahead False Positives',
    '',
    '## Context',
    body || `When using regex with lookahead alternatives, ${BODY_MARK} against negative cases.`,
    '',
  ].join('\n');
}

function makeProject(label, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pcr-' + label + '-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.orchestray', 'patterns', (opts.slug || SLUG) + '.md'),
    patternFile(opts.body)
  );
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-pcr-' + label })
  );
  return root;
}

function payload(root, prompt, overrides = {}) {
  return {
    session_id: 'c8147ec5-454c-4f88-bc53-c950f68fcbd1',
    transcript_path: '/d0/d1/d2/d3/d4/f.jsonl',
    cwd: root,
    permission_mode: 'bypassPermissions',
    agent_type: 'pm',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: 'Do the thing (sonnet/high)',
      prompt,
      subagent_type: 'tester',
      model: 'sonnet',
      run_in_background: true,
      name: 'test-verify-chain',
      ...(overrides.tool_input || {}),
    },
    tool_use_id: 'toolu_01TkLv549e3bazVJaaXWue1s',
    ...overrides.event,
  };
}

function runHook(event, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, 'hook always exits 0: ' + res.stderr);
  return JSON.parse(res.stdout.trim());
}

function newPrompt(out, fallback) {
  return out.hookSpecificOutput ? out.hookSpecificOutput.updatedInput.prompt : fallback;
}

// --- renderer --------------------------------------------------------------

describe('pattern-citation-render — every branch carries the body', () => {
  const match = {
    slug: 'test-pattern', body: 'Full pattern body here.',
    source: 'local', confidence: 0.85, times_applied: 5,
  };

  test('cached cite still carries the body (a second agent never saw the first copy)', () => {
    const root = makeProject('cached');
    renderCitation(match, 'developer', 'orch-c', true, root);
    const second = renderCitation(match, 'tester', 'orch-c', true, root);

    assert.ok(second.includes('[CACHED'), 'cached annotation retained');
    assert.ok(second.includes('loaded by developer'), 'names the first agent');
    assert.ok(second.includes('Full pattern body here.'), 'body present on cached cite');
  });

  test('every branch emits an exact `slug:` line', () => {
    const root = makeProject('slugline');
    const first  = renderCitation(match, 'developer', 'orch-s', true, root);
    const cached = renderCitation(match, 'tester', 'orch-s', true, root);
    const rev    = renderCitation(match, 'reviewer', 'orch-s', true, root);
    const off    = renderCitation(match, 'developer', 'orch-s', false, root);

    for (const [name, out] of [['first', first], ['cached', cached], ['reviewer', rev], ['no-cache', off]]) {
      assert.ok(out.includes('\n  slug: test-pattern'), name + ' cite has a bare slug line');
    }
  });

  test('slug line is unadorned — copying the whole line value yields the exact slug', () => {
    const out = renderCitation(match, 'developer', null, false, os.tmpdir());
    const line = out.split('\n').find((l) => l.trim().startsWith('slug:'));
    assert.equal(line.trim().slice('slug:'.length).trim(), 'test-pattern');
  });

  test('team tier gets its own label', () => {
    const out = renderCitation({ ...match, source: 'team' }, 'developer', null, false, os.tmpdir());
    assert.ok(out.includes('[team]'), 'team-tier label');
  });

  test('renderPatternsApplied header tells the agent to echo the slug verbatim', () => {
    const block = renderPatternsApplied([match], 'developer', null, false, os.tmpdir());
    assert.ok(block.startsWith('## Patterns Applied'), 'section heading preserved');
    assert.ok(/verbatim/i.test(block), 'verbatim echo instruction present');
    assert.ok(/patterns_used/.test(block), 'names the target field');
    assert.ok(/name:/.test(block), 'warns off the frontmatter name field');
    assert.ok(
      block.trimEnd().endsWith('Reminder — echo these slugs verbatim in `patterns_used` / `patterns_rejected`: test-pattern'),
      'closing reminder repeats the exact slugs last'
    );
  });

  test('renderPatternsApplied emits nothing when no citation renders', () => {
    assert.equal(renderPatternsApplied([{ body: 'orphan, no slug' }], 'developer', null, false, os.tmpdir()), '');
  });
});

// --- hook ------------------------------------------------------------------

describe('render-pattern-citations hook — resolves citations into bodies', () => {
  test('bare URI in a delegation prompt comes back with the pattern text', () => {
    const root = makeProject('e2e');
    const prompt = `Implement W1.\n\n## Patterns\n- @orchestray:pattern://${SLUG}     [local]     conf 0.6, applied 0x\n`;
    const out = runHook(payload(root, prompt));

    assert.ok(out.hookSpecificOutput, 'updatedInput emitted');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
    const p = out.hookSpecificOutput.updatedInput.prompt;
    assert.ok(p.startsWith(prompt), 'original prompt preserved as prefix');
    assert.ok(p.includes(BODY_MARK), 'pattern body inlined');
    assert.ok(p.includes('\n  slug: ' + SLUG), 'exact slug line present');
    assert.ok(p.includes('source_file: .orchestray/patterns/' + SLUG + '.md'), 'resolvable path present');
    assert.ok(!p.includes('name: regex-false-positive-check'), 'frontmatter name stripped — it competes with the slug');
  });

  test('updatedInput preserves the rest of tool_input', () => {
    const root = makeProject('preserve');
    const out = runHook(payload(root, `see @orchestray:pattern://${SLUG}`));
    const ui = out.hookSpecificOutput.updatedInput;
    assert.equal(ui.subagent_type, 'tester');
    assert.equal(ui.model, 'sonnet');
    assert.equal(ui.name, 'test-verify-chain');
    assert.equal(ui.run_in_background, true);
  });

  test('unresolvable slug → fail open, prompt untouched', () => {
    const root = makeProject('missing');
    const out = runHook(payload(root, 'cite @orchestray:pattern://no-such-pattern-anywhere'));
    assert.deepEqual(out, { continue: true });
  });

  test('pattern file with no body → fail open', () => {
    const root = makeProject('emptybody');
    fs.writeFileSync(path.join(root, '.orchestray', 'patterns', SLUG + '.md'), '---\nname: x\n---\n\n');
    const out = runHook(payload(root, `cite @orchestray:pattern://${SLUG}`));
    assert.deepEqual(out, { continue: true });
  });

  test('no citation in the prompt → no mutation', () => {
    const root = makeProject('nocite');
    const out = runHook(payload(root, 'Just do the work, no patterns here.'));
    assert.deepEqual(out, { continue: true });
  });

  test('non-Agent tool → no mutation', () => {
    const root = makeProject('nontool');
    const ev = payload(root, `@orchestray:pattern://${SLUG}`);
    ev.tool_name = 'Bash';
    assert.deepEqual(runHook(ev), { continue: true });
  });

  test('malformed stdin → fail open', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.stdout.trim()), { continue: true });
  });

  test('kill switch disables rendering', () => {
    const root = makeProject('killswitch');
    const ev = payload(root, `cite @orchestray:pattern://${SLUG}`);
    assert.deepEqual(runHook(ev, { ORCHESTRAY_PATTERN_CITATION_RENDER_DISABLED: '1' }), { continue: true });
    assert.deepEqual(runHook(ev, { ORCHESTRAY_PATTERN_EVIDENCE_DISABLED: '1' }), { continue: true });
  });

  test('pattern_evidence.enabled:false disables rendering', () => {
    const root = makeProject('cfgoff');
    fs.writeFileSync(
      path.join(root, '.orchestray', 'config.json'),
      JSON.stringify({ pattern_evidence: { enabled: false } })
    );
    assert.deepEqual(runHook(payload(root, `cite @orchestray:pattern://${SLUG}`)), { continue: true });
  });

  test('already-rendered prompt is not rendered twice', () => {
    const root = makeProject('idem');
    const first = runHook(payload(root, `cite @orchestray:pattern://${SLUG}`));
    const rendered = first.hookSpecificOutput.updatedInput.prompt;
    const again = runHook(payload(root, rendered));
    assert.deepEqual(again, { continue: true }, 'second pass is a no-op');
  });

  test('a slug quoted from a prior agent output is not expanded (parity with the offer scanner)', () => {
    const root = makeProject('quoted');
    const prompt = `Prior tester said: "I rejected @orchestray:pattern://${SLUG} because of X`;
    assert.deepEqual(runHook(payload(root, prompt)), { continue: true });
  });

  test('oversized body is truncated with a pointer to the file', () => {
    const root = makeProject('trunc', { body: 'x'.repeat(20000) });
    const p = newPrompt(runHook(payload(root, `@orchestray:pattern://${SLUG}`)), '');
    assert.ok(p.includes('[truncated at 8000 chars'), 'truncation marker');
    assert.ok(p.includes('.orchestray/patterns/' + SLUG + '.md'), 'pointer to full text');
    assert.ok(p.length < 12000 + 20000, 'body not inlined whole');
  });
});

// --- offer-scanner invariance ---------------------------------------------

describe('render-pattern-citations — offer scanner is unaffected', () => {
  const exists = () => true;

  test('shape_detected is unchanged by the appendix: uri_only before and after', () => {
    const root = makeProject('shape');
    const prompt = `W1. Cite: @orchestray:pattern://${SLUG}     [local]     conf 0.6, applied 0x`;
    const before = scanOffers(prompt, exists);
    assert.equal(before.shape_detected, 'uri_only');

    const after = scanOffers(newPrompt(runHook(payload(root, prompt)), prompt), exists);
    assert.equal(after.shape_detected, 'uri_only', 'appendix introduces no ambient shape');
    assert.deepEqual(after.offers.map((o) => o.offer_kind), ['curated'], 'still curated, not ambient');
    assert.deepEqual(before.offers.map((o) => o.slug), after.offers.map((o) => o.slug));
  });

  test('appendix emits neither a TOON catalog line nor a pattern_find results section', () => {
    const root = makeProject('noambient');
    const p = newPrompt(runHook(payload(root, `@orchestray:pattern://${SLUG}`)), '');
    assert.ok(!/PATTERN\s+slug=/.test(p), 'no TOON line — would flip the offer to ambient');
    assert.ok(!/##\s*pattern_find\s+results/i.test(p), 'no JSON-matches section');
    assert.ok(!p.includes('<mcp-grounding'), 'no grounding fence');
  });

  test('ambient catalog entries are not expanded — curated citations only', () => {
    const root = makeProject('ambient');
    const prompt = [
      '<mcp-grounding>',
      '## pattern_find results',
      `PATTERN slug=${SLUG} confidence=0.6 applied=0`,
      '</mcp-grounding>',
      'Do the work.',
    ].join('\n');
    assert.deepEqual(runHook(payload(root, prompt)), { continue: true });
  });
});

// --- cost ------------------------------------------------------------------

describe('render-pattern-citations — hot-path cost', () => {
  test('in-process render of 3 cited patterns stays in the low-ms range', () => {
    const root = makeProject('cost');
    for (const s of ['p-two', 'p-three']) {
      fs.writeFileSync(path.join(root, '.orchestray', 'patterns', s + '.md'), patternFile());
    }
    const prompt = [SLUG, 'p-two', 'p-three'].map((s) => `- @orchestray:pattern://${s}`).join('\n');
    const { buildAppendix } = require('../render-pattern-citations.js');

    buildAppendix(prompt, 'developer', root, {}); // warm
    const t0 = process.hrtime.bigint();
    const out = buildAppendix(prompt, 'developer', root, {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.ok(out && out.includes(BODY_MARK), 'rendered');
    assert.ok(ms < 100, `render took ${ms.toFixed(2)}ms — expected well under 100ms`);
    if (process.env.ORCHESTRAY_TEST_VERBOSE === '1') console.log(`render 3 patterns: ${ms.toFixed(2)}ms`);
  });
});
