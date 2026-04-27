'use strict';

/**
 * block-z.js — Block-Z deterministic prefix builder (P2.1, v2.2.0).
 *
 * Produces a byte-stable concatenation of the four Tier-0 sources cited by the
 * v2.2.0 design dossier (W7 §"Item P2.1"):
 *
 *   1. agents/pm.md
 *   2. CLAUDE.md
 *   3. agents/pm-reference/handoff-contract.md
 *   4. agents/pm-reference/phase-contract.md
 *
 * The output is suitable for emission as the first `additionalContext` segment
 * on every PM turn. Content is orch-id-agnostic, contains no timestamps, and no
 * derived values that vary across sessions for the same project commit.
 *
 * Output format:
 *
 *   <!-- block-z:component:agents/pm.md -->
 *   <verbatim contents>
 *   <!-- block-z:component:CLAUDE.md -->
 *   <verbatim contents>
 *   ...
 *   <!-- block-z:sha256=<64-hex> -->
 *
 * Hashing rule: SHA-256 of the assembled body EXCLUDING the trailing fingerprint
 * comment (avoids chicken-and-egg). Fingerprint is the LAST line.
 *
 * Failure modes (fail-soft):
 *   - Missing input file        → { text: '', hash: null, error: 'missing_input' }
 *   - Component > 1 MB          → { text: '', hash: null, error: 'component_oversize' }
 *   - I/O error                 → caller's try/catch boundary; same fallthrough
 *
 * Public API: { buildBlockZ, DEFAULT_COMPONENTS }
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd } = require('./resolve-project-cwd');

// ---------------------------------------------------------------------------
// Component manifest — paths and order are binding
// ---------------------------------------------------------------------------

const DEFAULT_COMPONENTS = Object.freeze([
  Object.freeze({ name: 'agents/pm.md',                                  rel: 'agents/pm.md' }),
  Object.freeze({ name: 'CLAUDE.md',                                     rel: 'CLAUDE.md' }),
  Object.freeze({ name: 'agents/pm-reference/handoff-contract.md',       rel: path.join('agents', 'pm-reference', 'handoff-contract.md') }),
  Object.freeze({ name: 'agents/pm-reference/phase-contract.md',         rel: path.join('agents', 'pm-reference', 'phase-contract.md') }),
]);

const MAX_COMPONENT_BYTES = 1 * 1024 * 1024; // 1 MB belt-and-braces guard

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the deterministic Block-Z prefix.
 *
 * @param {object} opts
 * @param {string} opts.cwd                       Project root.
 * @param {Array<{name: string, rel: string}>} [opts.componentPaths]
 *                                                Test seam — override default list.
 * @returns {{
 *   text:       string,
 *   hash:       string|null,
 *   components: Array<{ name: string, sha: string, byte_offset: number }>,
 *   error:      string|null
 * }}
 */
function buildBlockZ(opts) {
  opts = opts || {};
  const cwd = resolveSafeCwd(opts.cwd);
  const components = Array.isArray(opts.componentPaths) && opts.componentPaths.length > 0
    ? opts.componentPaths
    : DEFAULT_COMPONENTS;

  const parts = [];
  const componentMeta = [];

  for (const comp of components) {
    let raw;
    try {
      const absPath = path.isAbsolute(comp.rel) ? comp.rel : path.join(cwd, comp.rel);
      const buf = fs.readFileSync(absPath);
      if (buf.length > MAX_COMPONENT_BYTES) {
        return { text: '', hash: null, components: [], error: 'component_oversize' };
      }
      raw = buf.toString('utf8');
    } catch (_e) {
      return { text: '', hash: null, components: [], error: 'missing_input' };
    }

    const header = '<!-- block-z:component:' + comp.name + ' -->\n';
    const sha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    // F-009 (v2.2.0): byte_offset is computed in the join-aware loop below;
    // attempting to compute it here using a runningOffset would be dead-stored
    // (the join adds '\n' separators not present in this loop's accounting).
    componentMeta.push({ name: comp.name, sha });
    parts.push(header + raw);
  }

  // Join parts with '\n' separator (matches existing zone1 join convention).
  const body = parts.join('\n');
  // Compute byte_offsets relative to the joined body. Each part except the
  // first is preceded by a single '\n' byte. This is the single source of
  // truth for byte_offset (F-009 fix: no dead first-loop assignment).
  let cursor = 0;
  for (let i = 0; i < componentMeta.length; i++) {
    if (i > 0) cursor += 1; // '\n' separator inserted by join
    const header = '<!-- block-z:component:' + componentMeta[i].name + ' -->\n';
    const headerBytes = Buffer.byteLength(header, 'utf8');
    componentMeta[i].byte_offset = cursor + headerBytes;
    const partBytes = Buffer.byteLength(parts[i], 'utf8');
    cursor += partBytes;
  }

  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const fingerprint = '<!-- block-z:sha256=' + hash + ' -->';
  const text = body + '\n' + fingerprint;

  return {
    text,
    hash,
    components: componentMeta,
    error: null,
  };
}

module.exports = {
  buildBlockZ,
  DEFAULT_COMPONENTS,
};
