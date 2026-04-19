'use strict';

/**
 * Install-integrity manifest helpers.
 *
 * Compute per-file SHA-256 hashes at install time, and verify the installed
 * file tree against those hashes at MCP boot time.
 *
 * Design doc: .orchestray/kb/decisions/v213-bundle-II-design.md
 *
 * Contract:
 *   - computeManifest: synchronous, throws on I/O error (caller: installer, fatal).
 *   - verifyManifest:  synchronous, NEVER throws. All I/O errors become verdicts.
 *   - verifyManifestOnBoot: NEVER throws. Journals drift via recordDegradation.
 *
 * Hash algorithm: SHA-256 over raw bytes (no line-ending normalization).
 * See §3 Step 2 of design doc for normalization rationale.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Lazy-load to avoid circular deps at module load time.
function _getDegradedJournal() {
  return require('./degraded-journal');
}

// In-process dedup for boot verify: one journal write per (kind, version) per process.
const _bootSeen = new Set();

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Hash one file synchronously via streaming 64KB chunks.
 * Throws on any read error (ENOENT, EACCES, etc.).
 *
 * @param {string} absPath   Absolute path to the file.
 * @returns {string}         Lowercase hex SHA-256 digest.
 */
function _hashFile(absPath) {
  const hash = crypto.createHash('sha256');
  // Use a fixed-size buffer and read in chunks to avoid loading large files
  // entirely into memory. 64 KB chunks balance throughput and memory.
  const CHUNK = 64 * 1024;
  const buf   = Buffer.alloc(CHUNK);
  const fd    = fs.openSync(absPath, 'r');
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      hash.update(buf.slice(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Read and parse manifest.json from `rootDir`.
 * Returns { manifest, error } — error is set on any failure (missing, bad JSON).
 *
 * @param {string} rootDir
 * @returns {{ manifest: object|null, error: string|null }}
 */
function _readManifest(rootDir) {
  const manifestPath = path.join(rootDir, 'manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    return { manifest, error: null };
  } catch (e) {
    const error = e.code === 'ENOENT' ? 'absent' :
                  (e instanceof SyntaxError)  ? 'unparseable' :
                  'read_error';
    return { manifest: null, error };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hashes over a list of target-relative paths.
 * Synchronous. Reads every file once.
 *
 * @param {string}   rootDir   Absolute path. Files resolved as path.join(rootDir, relPath).
 * @param {string[]} fileList  Array of target-relative paths. Duplicates de-duplicated.
 * @returns {{
 *   files_hashes:        Object<string, string>,
 *   hash_algorithm:      'sha256',
 *   hash_normalization:  'none',
 * }}
 * @throws {Error} if any file is unreadable (ENOENT, EACCES).
 *         Install-time callers must treat this as fatal.
 */
function computeManifest(rootDir, fileList) {
  const seen = new Set();
  const files_hashes = {};

  for (const relPath of fileList) {
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const absPath = path.join(rootDir, relPath);
    // Let errors propagate — install-time caller handles them as fatal.
    files_hashes[relPath] = _hashFile(absPath);
  }

  return {
    files_hashes,
    hash_algorithm:     'sha256',
    hash_normalization: 'none',
  };
}

/**
 * Verify the installed file tree against the manifest.
 * Never throws. I/O errors become `errors[]` entries.
 *
 * @param {string} rootDir
 * @param {object} manifest   Parsed manifest.json object.
 * @returns {{
 *   ok:         boolean,
 *   schema:     1 | 2 | null,
 *   supported:  boolean,
 *   drifted:    Array<{ path: string, expected: string, actual: string }>,
 *   missing:    string[],
 *   unexpected: string[],
 *   errors:     Array<{ path: string, code: string }>,
 * }}
 */
function verifyManifest(rootDir, manifest) {
  const drifted    = [];
  const missing    = [];
  const unexpected = [];  // always [] in v2.1.3 (reserved for future tree-walk)
  const errors     = [];

  // Determine schema version.
  let schema = null;
  try {
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      if (typeof manifest.manifest_schema === 'number') {
        schema = manifest.manifest_schema;
      } else if (manifest.files && !manifest.files_hashes) {
        schema = 1;
      }
    }
  } catch (_e) {
    schema = null;
  }

  // Only schema 2 manifests with files_hashes can be verified.
  const supported = schema === 2 &&
    manifest != null &&
    manifest.files_hashes != null &&
    typeof manifest.files_hashes === 'object' &&
    !Array.isArray(manifest.files_hashes);

  if (!supported) {
    return { ok: false, schema, supported, drifted, missing, unexpected, errors };
  }

  const filesHashes = manifest.files_hashes;

  for (const [relPath, expectedHash] of Object.entries(filesHashes)) {
    const absPath = path.join(rootDir, relPath);
    let actualHash;
    try {
      actualHash = _hashFile(absPath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        missing.push(relPath);
      } else {
        errors.push({ path: relPath, code: e.code || 'UNKNOWN' });
      }
      continue;
    }

    if (actualHash !== expectedHash) {
      drifted.push({ path: relPath, expected: expectedHash, actual: actualHash });
    }
  }

  const ok = drifted.length === 0 && missing.length === 0 && errors.length === 0;
  return { ok, schema, supported, drifted, missing, unexpected, errors };
}

/**
 * Boot-time convenience wrapper. Reads manifest.json from rootDir, verifies,
 * journals any non-ok result. Never throws. Return value is informational.
 *
 * @param {{ rootDir: string, projectRoot?: string }} opts
 * @returns {object}  Same shape as verifyManifest, plus { journaled: boolean, kind: string|null }
 */
function verifyManifestOnBoot(opts) {
  const noopResult = {
    ok: false, schema: null, supported: false,
    drifted: [], missing: [], unexpected: [], errors: [],
    journaled: false, kind: null,
  };

  try {
    const rootDir     = (opts && opts.rootDir)     || '';
    const projectRoot = (opts && opts.projectRoot) || process.cwd();

    // Read the server version for dedup keys.
    let VERSION = 'unknown';
    try {
      VERSION = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8').trim() || 'unknown';
    } catch (_e) { /* non-fatal */ }

    const startMs = Date.now();

    // Read manifest.
    const { manifest, error: readError } = _readManifest(rootDir);

    if (readError) {
      // Missing or unparseable manifest — treat as legacy v1.
      const dedupKey = 'manifest_v1_legacy|' + VERSION;
      const result = Object.assign({}, noopResult, { kind: 'manifest_v1_legacy' });
      _journalOnce(dedupKey, () => {
        _getDegradedJournal().recordDegradation({
          kind:        'manifest_v1_legacy',
          severity:    'info',
          projectRoot,
          detail: {
            version:   VERSION,
            reason:    readError === 'absent' ? 'absent' : 'unparseable',
            dedup_key: dedupKey,
          },
        });
      });
      result.journaled = _bootSeen.has(dedupKey);
      return result;
    }

    // Verify.
    const result = verifyManifest(rootDir, manifest);

    const elapsedMs = Date.now() - startMs;

    // Slow verify: journal a warning and continue.
    if (elapsedMs > 2000) {
      const slowKey = 'install_integrity_verify_slow|' + VERSION;
      _journalOnce(slowKey, () => {
        _getDegradedJournal().recordDegradation({
          kind:        'install_integrity_verify_slow',
          severity:    'warn',
          projectRoot,
          detail: {
            version:       VERSION,
            elapsed_ms:    elapsedMs,
            dedup_key:     slowKey,
          },
        });
      });
    }

    // Legacy v1 manifest.
    if (!result.supported) {
      const dedupKey = 'manifest_v1_legacy|' + VERSION;
      _journalOnce(dedupKey, () => {
        _getDegradedJournal().recordDegradation({
          kind:        'manifest_v1_legacy',
          severity:    'info',
          projectRoot,
          detail: {
            version:   VERSION,
            reason:    'no_files_hashes',
            dedup_key: dedupKey,
          },
        });
      });
      return Object.assign({}, result, {
        journaled: _bootSeen.has(dedupKey),
        kind:      'manifest_v1_legacy',
      });
    }

    // Clean install.
    if (result.ok) {
      return Object.assign({}, result, { journaled: false, kind: null });
    }

    // Drift detected.
    const dedupKey = 'install_integrity_drift|' + VERSION;
    const allBad = [...result.drifted.map(d => d.path), ...result.missing, ...result.errors.map(e => e.path)];
    const firstPaths = allBad.slice(0, 5);

    _journalOnce(dedupKey, () => {
      _getDegradedJournal().recordDegradation({
        kind:        'install_integrity_drift',
        severity:    'warn',
        projectRoot,
        detail: {
          version:        VERSION,
          drifted_count:  result.drifted.length,
          missing_count:  result.missing.length,
          errors_count:   result.errors.length,
          first_paths:    firstPaths,
          dedup_key:      dedupKey,
        },
      });
    });

    return Object.assign({}, result, {
      journaled: true,
      kind:      'install_integrity_drift',
    });

  } catch (_e) {
    // MUST NEVER throw to caller. Return a safe no-op result.
    return noopResult;
  }
}

/**
 * Run fn() exactly once per dedupKey per process lifetime.
 * @param {string}   dedupKey
 * @param {Function} fn
 */
function _journalOnce(dedupKey, fn) {
  if (_bootSeen.has(dedupKey)) return;
  _bootSeen.add(dedupKey);
  try { fn(); } catch (_e) { /* swallow — journal failure must not block boot */ }
}

module.exports = {
  computeManifest,
  verifyManifest,
  verifyManifestOnBoot,
  // Exported for tests only:
  _hashFile,
  _readManifest,
};
