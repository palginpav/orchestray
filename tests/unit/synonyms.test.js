#!/usr/bin/env node
'use strict';

/**
 * Tests for R-RET-EXPAND synonym expansion (v2.1.13 W7).
 *
 * Covers:
 *   A. Lookup returns expected expansions for 5 sample entries.
 *   B. Kill switch disables expansion entirely (taskTokens pass through
 *      unchanged; no synonym_expanded entries appear in match_reasons).
 *   C. Audit trail: synonym-matched pattern surfaces a synonym_expanded:{from}->{to}
 *      entry in match_reasons.
 *   D. Class count / word count smoke (≥35 entries).
 *   E. Zero-result-rate regression smoke: a query that already produces a
 *      match without synonyms MUST still return at least as many matches
 *      with synonyms enabled (monotonic-recall invariant).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  _expandSynonyms,
  lookupSynonyms,
  SYNONYM_WORD_COUNT,
  SYNONYM_CLASS_COUNT,
} = require('../../bin/mcp-server/tools/_synonyms.js');

const { handle: patternFindHandle } =
  require('../../bin/mcp-server/tools/pattern_find.js');

// ---------------------------------------------------------------------------
// Test-scaffold helpers (mirror the shape in pattern_find-proposed-filter.test.js)
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'orchestray-pf-synonyms-')
  );
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), {
    recursive: true,
  });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Write a pattern file with given description/body so the Jaccard path
 * has tokens to match against.
 */
function writePattern(dir, slug, description) {
  const body = [
    '---',
    'name: ' + slug,
    'category: decomposition',
    'confidence: 0.8',
    'description: ' + description,
    '---',
    '',
    '## Context',
    description,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, slug + '.md'), body, 'utf8');
}

/**
 * Write retrieval config with a given synonyms_enabled value.
 */
function writeRetrievalConfig(projectRoot, synonymsEnabled) {
  const configPath = path.join(projectRoot, '.orchestray', 'config.json');
  const payload = { retrieval: { synonyms_enabled: synonymsEnabled } };
  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// A. Direct lookup: 5 sample entries must expand to their known synonyms.
// ---------------------------------------------------------------------------

describe('_synonyms: lookupSynonyms sample entries', () => {
  test('bug expands to include debug, defect, correction, fix', () => {
    const syns = lookupSynonyms('bug');
    assert.ok(syns.includes('debug'), 'bug→debug');
    assert.ok(syns.includes('defect'), 'bug→defect');
    assert.ok(syns.includes('correction'), 'bug→correction');
    assert.ok(syns.includes('fix'), 'bug→fix');
  });

  test('performance expands to include perf and optimization', () => {
    const syns = lookupSynonyms('performance');
    assert.ok(syns.includes('perf'));
    assert.ok(syns.includes('optimization'));
  });

  test('config expands to include settings and configuration', () => {
    const syns = lookupSynonyms('config');
    assert.ok(syns.includes('settings'));
    assert.ok(syns.includes('configuration'));
  });

  test('deploy expands to include release and ship', () => {
    const syns = lookupSynonyms('deploy');
    assert.ok(syns.includes('release'));
    assert.ok(syns.includes('ship'));
  });

  test('database expands to include db and schema', () => {
    const syns = lookupSynonyms('database');
    assert.ok(syns.includes('db'));
    assert.ok(syns.includes('schema'));
  });

  test('unknown tokens return empty', () => {
    assert.deepEqual(lookupSynonyms('qwxzzznotareal'), []);
    assert.deepEqual(lookupSynonyms(''), []);
    assert.deepEqual(lookupSynonyms(null), []);
  });

  test('synonym word count is >= 35 (acceptance criterion)', () => {
    assert.ok(
      SYNONYM_WORD_COUNT >= 35,
      'expected >=35 words across classes, got ' + SYNONYM_WORD_COUNT
    );
    assert.ok(
      SYNONYM_CLASS_COUNT >= 35,
      'expected >=35 equivalence classes, got ' + SYNONYM_CLASS_COUNT
    );
  });
});

// ---------------------------------------------------------------------------
// B. _expandSynonyms: kill switch disables expansion.
// ---------------------------------------------------------------------------

describe('_expandSynonyms: kill switch semantics', () => {
  test('enabled=false returns tokens unchanged, expansions empty', () => {
    const input = new Set(['bug', 'performance']);
    const { tokens, expansions } = _expandSynonyms(input, { enabled: false });
    assert.deepEqual(
      Array.from(tokens).sort(),
      ['bug', 'performance'].sort(),
      'tokens passed through unchanged'
    );
    assert.deepEqual(expansions, [], 'expansions empty when disabled');
  });

  test('enabled=true expands known tokens', () => {
    const input = new Set(['bug']);
    const { tokens, expansions } = _expandSynonyms(input, { enabled: true });
    assert.ok(tokens.has('debug'), 'debug added');
    assert.ok(tokens.has('fix'), 'fix added');
    assert.ok(expansions.length > 0, 'expansions recorded');
    // Each expansion pair has from/to strings.
    for (const exp of expansions) {
      assert.equal(typeof exp.from, 'string');
      assert.equal(typeof exp.to, 'string');
    }
  });

  test('missing/invalid options defaults to disabled (safe default for internal callers)', () => {
    // Callers explicitly opt in via {enabled:true}; any other shape → disabled.
    const input = new Set(['bug']);
    const { tokens, expansions } = _expandSynonyms(input, {});
    assert.deepEqual(Array.from(tokens).sort(), ['bug']);
    assert.deepEqual(expansions, []);
  });

  test('query tokens with no synonyms yield empty expansions', () => {
    const input = new Set(['xyzzynomatch']);
    const { tokens, expansions } = _expandSynonyms(input, { enabled: true });
    assert.deepEqual(Array.from(tokens), ['xyzzynomatch']);
    assert.deepEqual(expansions, []);
  });
});

// ---------------------------------------------------------------------------
// C. End-to-end: pattern_find surfaces synonym_expanded in match_reasons.
//
// To force the Jaccard code path (where synonym expansion applies), we make
// sure the tmp project has NO patterns.db built yet for these tiny corpora,
// and the taskSummary uses a unique token so real user patterns cannot
// outrank the test pattern. When FTS5 is available it still attempts to
// rank local-tier entries, so we use a pattern body that contains ONLY the
// synonym token (not the query token) and assert via a `zkwXXXXXxqz` unique
// prefix that the ranked result is our test entry.
// ---------------------------------------------------------------------------

function uniqueToken() {
  return 'zkw' + Math.random().toString(36).slice(2, 10) + 'xqz';
}

describe('pattern_find: synonym_expanded audit trail (R-RET-EXPAND)', () => {
  test('synonym-matched pattern surfaces synonym_expanded in match_reasons', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    // Synonyms on by default (config absent → default true).
    const uniq = uniqueToken();
    // Pattern BODY uses the synonym "debug" together with the unique token so
    // the Jaccard overlap includes BOTH uniq and 'debug'. The query uses 'bug',
    // which expands to 'debug'. Shared-tier entries ALWAYS use Jaccard, so
    // we write the pattern to the SHARED patterns dir via the proposed-patterns
    // path? No — shared is federation-controlled. Use proposed-patterns
    // instead: proposed entries always use Jaccard (see pattern_find.js W4 note).
    const proposedDir = path.join(
      projectRoot,
      '.orchestray',
      'proposed-patterns'
    );
    fs.mkdirSync(proposedDir, { recursive: true });
    writePattern(
      proposedDir,
      'synonym-audit-proposal',
      uniq + ' handles debug workflow ' + uniq
    );

    const result = await patternFindHandle(
      {
        task_summary: uniq + ' bug workflow',
        max_results: 10,
        include_proposed: true,
      },
      { projectRoot }
    );
    assert.equal(result.isError, false, 'expected success');

    const entry = result.structuredContent.matches.find(
      (m) => m.slug === 'synonym-audit-proposal'
    );
    assert.ok(
      entry,
      'expected synonym-audit-proposal in results; got slugs=' +
        result.structuredContent.matches.map((m) => m.slug).join(',')
    );

    const hasSynonymReason = entry.match_reasons.some((r) =>
      r.startsWith('synonym_expanded:')
    );
    assert.ok(
      hasSynonymReason,
      'expected a synonym_expanded:* match_reason; got: ' +
        JSON.stringify(entry.match_reasons)
    );

    // Reason must name a (from, to) pair involving 'bug' → 'debug'.
    const synonymReasons = entry.match_reasons.filter((r) =>
      r.startsWith('synonym_expanded:')
    );
    const hasBugDebug = synonymReasons.some(
      (r) => r === 'synonym_expanded:bug->debug'
    );
    assert.ok(
      hasBugDebug,
      'expected synonym_expanded:bug->debug; got: ' +
        JSON.stringify(synonymReasons)
    );
  });

  test('kill switch: synonyms_enabled=false suppresses synonym_expanded entirely', async (t) => {
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    writeRetrievalConfig(projectRoot, false);

    const uniq = uniqueToken();
    const proposedDir = path.join(
      projectRoot,
      '.orchestray',
      'proposed-patterns'
    );
    fs.mkdirSync(proposedDir, { recursive: true });
    writePattern(
      proposedDir,
      'synonym-killed-proposal',
      uniq + ' handles debug workflow ' + uniq
    );

    const result = await patternFindHandle(
      {
        task_summary: uniq + ' bug workflow',
        max_results: 10,
        include_proposed: true,
      },
      { projectRoot }
    );
    assert.equal(result.isError, false);

    const entry = result.structuredContent.matches.find(
      (m) => m.slug === 'synonym-killed-proposal'
    );
    // The entry may or may not still appear (uniq tokens still match), but
    // even if it does its match_reasons MUST NOT contain synonym_expanded:*.
    if (entry) {
      const hasSynonymReason = entry.match_reasons.some((r) =>
        r.startsWith('synonym_expanded:')
      );
      assert.equal(
        hasSynonymReason,
        false,
        'kill switch must suppress synonym_expanded; got: ' +
          JSON.stringify(entry.match_reasons)
      );
    }
  });

  test('zero-result-rate regression smoke: baseline query still returns at least as many matches', async (t) => {
    // Query that matches WITHOUT synonyms: the description contains the exact
    // query token. Enabling synonyms must NOT reduce the match count for this
    // pattern (monotonic recall invariant).
    const projectRoot = makeTmpProject();
    t.after(() => cleanup(projectRoot));

    const uniq = uniqueToken();
    const proposedDir = path.join(
      projectRoot,
      '.orchestray',
      'proposed-patterns'
    );
    fs.mkdirSync(proposedDir, { recursive: true });
    writePattern(
      proposedDir,
      'baseline-recall-proposal',
      uniq + ' direct match test ' + uniq
    );

    // Count matches WITH kill switch ON (synonyms disabled).
    writeRetrievalConfig(projectRoot, false);
    const disabledResult = await patternFindHandle(
      {
        task_summary: uniq + ' direct match',
        max_results: 10,
        include_proposed: true,
      },
      { projectRoot }
    );
    const disabledHit = disabledResult.structuredContent.matches.some(
      (m) => m.slug === 'baseline-recall-proposal'
    );

    // Count matches WITH kill switch OFF (synonyms enabled).
    writeRetrievalConfig(projectRoot, true);
    const enabledResult = await patternFindHandle(
      {
        task_summary: uniq + ' direct match',
        max_results: 10,
        include_proposed: true,
      },
      { projectRoot }
    );
    const enabledHit = enabledResult.structuredContent.matches.some(
      (m) => m.slug === 'baseline-recall-proposal'
    );

    // With synonyms on, recall must be >= recall with synonyms off.
    // Specifically: if the baseline finds the pattern, the expanded path MUST also find it.
    if (disabledHit) {
      assert.ok(
        enabledHit,
        'synonym expansion regressed recall: baseline found the pattern but expanded did not'
      );
    }
  });
});
