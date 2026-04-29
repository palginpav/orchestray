'use strict';

/**
 * load-task-yaml.js — parses task YAML files and extracts the `contracts:` block.
 *
 * W3-1 (v2.2.11): New centralised loader for `.orchestray/state/tasks/*.yaml`
 * files. Extracts the structured `contracts:` key and returns a typed object,
 * or `null` when the key is absent.
 *
 * No external YAML library is used — the project has no js-yaml in its
 * dependency tree. We implement a minimal structural parser sufficient for
 * the contracts block shape defined in W4b §2.2. The parser handles:
 *   - Top-level scalar keys (`key: value`)
 *   - Top-level list keys (`key:\n  - item`)
 *   - Nested mapping keys (`key:\n  subkey: value`)
 *   - Quoted and unquoted scalar values
 *   - Block scalars (the `verify_criteria: |` style) skipped cleanly
 *
 * Limitations (acceptable for v2.2.11):
 *   - Does NOT support YAML anchors/aliases.
 *   - Does NOT support multi-document streams.
 *   - Does NOT support inline mappings/sequences as values beyond what is
 *     needed by the contracts block.
 *
 * Contract:
 *   - `loadTaskYaml(filePath)`: returns `{ raw, contracts }` where
 *     `contracts` is the parsed contracts object or `null` if absent.
 *     Throws on file-read errors (caller must handle).
 *   - `parseContractsBlock(raw)`: exported for unit testing.
 *     Returns `{ contracts, error }` — either contracts or an error string.
 */

const fs   = require('fs');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse a task YAML file.
 *
 * @param {string} filePath - Absolute path to the task YAML file.
 * @returns {{ raw: string, contracts: object|null, error: string|null }}
 *   - `raw`: the raw file content
 *   - `contracts`: parsed contracts block, or null if not present
 *   - `error`: parse error string if the contracts block was malformed; null otherwise
 */
function loadTaskYaml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { contracts, error } = parseContractsBlock(raw);
  return { raw, contracts, error };
}

/**
 * Parse a `contracts:` block from raw YAML text.
 *
 * Uses a line-by-line structural parser tailored to the task YAML format.
 *
 * @param {string} raw - Raw YAML file content.
 * @returns {{ contracts: object|null, error: string|null }}
 */
function parseContractsBlock(raw) {
  if (!raw || typeof raw !== 'string') {
    return { contracts: null, error: null };
  }

  const lines = raw.split('\n');

  // Find the `contracts:` top-level key (no leading whitespace)
  let contractsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^contracts:\s*$/.test(lines[i])) {
      contractsStart = i;
      break;
    }
  }

  if (contractsStart === -1) {
    return { contracts: null, error: null };
  }

  // Collect all lines that are part of the contracts block (indented or blank
  // continuation lines until the next top-level key or EOF).
  const blockLines = [];
  for (let i = contractsStart + 1; i < lines.length; i++) {
    const line = lines[i];
    // Empty or whitespace-only lines continue the block
    if (/^\s*$/.test(line)) {
      blockLines.push(line);
      continue;
    }
    // Top-level key (no leading whitespace, not a comment, not a list item)
    // signals end of the contracts block.
    if (/^[a-zA-Z_]/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  if (blockLines.length === 0) {
    return { contracts: null, error: 'contracts: key present but block is empty' };
  }

  try {
    const contracts = parseIndentedBlock(blockLines, 2);
    return { contracts, error: null };
  } catch (err) {
    return { contracts: null, error: String(err && err.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Internal: minimal YAML block parser
// ---------------------------------------------------------------------------

/**
 * Parse an indented YAML block (child of a parent key) into a plain JS object.
 * Lines must be pre-sliced to exclude the parent key line itself.
 *
 * @param {string[]} lines - Block lines (still indented relative to the document root).
 * @param {number}   baseIndent - Expected indentation level of the first level of children.
 * @returns {object}
 */
function parseIndentedBlock(lines, baseIndent) {
  const obj = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) {
      // Dedent signals end of block — should not happen in well-formed input
      break;
    }

    const trimmed = line.slice(indent);

    // Comment
    if (trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Key-value pair at this indent level: `key: value` or `key:`
    const kvMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!kvMatch) {
      // Could be a list item without a parent list key — skip with warning
      i++;
      continue;
    }

    const key = kvMatch[1];
    const valueStr = kvMatch[2].trim();

    if (valueStr === '' || valueStr === '|' || valueStr === '>') {
      // Block scalar or nested block — gather child lines
      const childLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const childLine = lines[j];
        if (/^\s*$/.test(childLine)) {
          childLines.push(childLine);
          j++;
          continue;
        }
        const childIndent = getIndent(childLine);
        if (childIndent <= indent) break;
        childLines.push(childLine);
        j++;
      }

      if (childLines.length > 0) {
        const firstChild = childLines.find(l => !/^\s*$/.test(l));
        if (firstChild && /^\s*-\s/.test(firstChild)) {
          // List block
          obj[key] = parseListBlock(childLines, getIndent(firstChild));
        } else if (firstChild) {
          // Nested mapping block
          obj[key] = parseIndentedBlock(childLines, getIndent(firstChild));
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = null;
      }
      i = j;
    } else {
      // Inline scalar value
      obj[key] = parseScalar(valueStr);
      i++;
    }
  }

  return obj;
}

/**
 * Parse a YAML list block (lines starting with `- `) into an array.
 * Each item can be a scalar or a mapping.
 *
 * @param {string[]} lines
 * @param {number}   baseIndent - Indentation of the `- ` markers.
 * @returns {Array}
 */
function parseListBlock(lines, baseIndent) {
  const arr = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break;

    const trimmed = line.slice(indent);

    if (!trimmed.startsWith('- ') && trimmed !== '-') {
      // Not a list item at this level — could be a continuation of a mapping item
      i++;
      continue;
    }

    const itemContent = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : '';

    if (itemContent === '' || itemContent === '{') {
      // Empty list item or mapping — gather child lines
      const childLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const childLine = lines[j];
        if (/^\s*$/.test(childLine)) {
          childLines.push(childLine);
          j++;
          continue;
        }
        const childIndent = getIndent(childLine);
        if (childIndent <= indent) break;
        childLines.push(childLine);
        j++;
      }
      if (childLines.length > 0) {
        const childBaseIndent = getIndent(childLines.find(l => !/^\s*$/.test(l)) || '  ');
        arr.push(parseIndentedBlock(childLines, childBaseIndent));
      } else {
        arr.push(null);
      }
      i = j;
    } else if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(itemContent)) {
      // Inline mapping item: `- key: value [key2: value2 ...]`
      // Gather this line + indented continuation lines
      const itemLines = [' '.repeat(indent + 2) + itemContent];
      let j = i + 1;
      while (j < lines.length) {
        const childLine = lines[j];
        if (/^\s*$/.test(childLine)) {
          j++;
          continue;
        }
        const childIndent = getIndent(childLine);
        if (childIndent <= indent) break;
        itemLines.push(childLine);
        j++;
      }
      arr.push(parseIndentedBlock(itemLines, indent + 2));
      i = j;
    } else {
      // Scalar list item
      arr.push(parseScalar(itemContent));
      i++;
    }
  }

  return arr;
}

/**
 * Parse a scalar YAML value string into the appropriate JS primitive.
 * Handles: quoted strings, booleans, null, integers, floats.
 */
function parseScalar(str) {
  if (str === null || str === undefined) return null;
  const s = str.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }

  // Numeric
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);

  // Plain string (includes "1" schema_version etc.)
  return s;
}

/** Return the number of leading spaces in a string. */
function getIndent(str) {
  const m = /^( *)/.exec(str);
  return m ? m[1].length : 0;
}

// ---------------------------------------------------------------------------
// Glob matching for file_ownership
// ---------------------------------------------------------------------------

/**
 * Minimal glob matcher supporting `*`, `**`, and `?` wildcards.
 * Used for file_ownership.write_allowed and write_forbidden checks.
 *
 * @param {string} pattern - Glob pattern.
 * @param {string} filePath - File path to test (forward slashes).
 * @returns {boolean}
 */
function matchGlob(pattern, filePath) {
  // Normalize separators
  const p = pattern.replace(/\\/g, '/');
  const f = filePath.replace(/\\/g, '/');

  // Exact match shortcut
  if (p === f) return true;

  // Convert glob to regex
  // ** matches any sequence including path separators
  // *  matches any sequence NOT including path separators
  // ?  matches any single character except separator
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '__STAR__')
    .replace(/__STAR____STAR__/g, '.+')
    .replace(/__STAR__/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  try {
    const re = new RegExp('^' + escaped + '$');
    return re.test(f);
  } catch (_e) {
    return false;
  }
}

module.exports = {
  loadTaskYaml,
  parseContractsBlock,
  matchGlob,
};
