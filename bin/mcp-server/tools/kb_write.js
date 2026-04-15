'use strict';

/**
 * `kb_write` MCP tool.
 *
 * Atomically writes a KB artifact file AND appends/updates its metadata entry
 * in `.orchestray/kb/index.json`, both under a single exclusive advisory lock.
 * Fixes the observed index drift (≥20 on-disk files, 4 index entries) by
 * guaranteeing that every successful file write is reflected in the index.
 *
 * Lock strategy: reuses the `<filePath>.lock` advisory primitive from
 * bin/_lib/atomic-append.js (O_EXCL + stale-lock recovery). The lock is
 * acquired on the index.json path so both the artifact write and the index
 * update are serialised under one mutex.
 *
 * Per v2015-architect-mcp-design.md §W6.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');

// ---------------------------------------------------------------------------
// Lock primitive (extracted from atomic-append.js — no circular dependency)
// ---------------------------------------------------------------------------

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MS = 50;
const LOCK_STALE_MS = 10_000;

function _sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin */ }
  }
}

/**
 * Acquire an advisory lock on `lockPath` using O_EXCL.
 * Returns the open fd on success, or null on exhausted retries.
 * Caller must close + unlink in a finally block.
 */
function _acquireLock(lockPath) {
  let fd = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      return fd;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Stale-lock recovery: if the lockfile is older than LOCK_STALE_MS,
        // treat the prior holder as crashed and reclaim the lock.
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch (_e) {}
            continue;
          }
        } catch (_e) {
          continue;
        }
        if (attempt < MAX_LOCK_ATTEMPTS - 1) {
          _sleepMs(LOCK_BACKOFF_MS);
        }
      } else {
        // Non-EEXIST error (e.g. EACCES) — give up.
        return null;
      }
    }
  }
  return null;
}

function _releaseLock(fd, lockPath) {
  try { fs.closeSync(fd); } catch (_e) {}
  try { fs.unlinkSync(lockPath); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const KB_BUCKETS = ['artifacts', 'facts', 'decisions'];

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['id', 'bucket', 'path', 'author', 'topic', 'content'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    bucket: { type: 'string', enum: KB_BUCKETS },
    path: { type: 'string', minLength: 1, maxLength: 500 },
    author: { type: 'string', minLength: 1, maxLength: 100 },
    task: { type: 'string', maxLength: 100 },
    topic: { type: 'string', minLength: 1, maxLength: 200 },
    content: { type: 'string', minLength: 1, maxLength: 1048576 },
    orchestration_id: { type: 'string' },
    overwrite: { type: 'boolean' },
  },
});

const definition = deepFreeze({
  name: 'kb_write',
  description:
    'Atomically write a KB artifact file and register its metadata in ' +
    '.orchestray/kb/index.json under a single exclusive lock. Fixes index ' +
    'drift by ensuring every on-disk file has a corresponding index entry. ' +
    'Buckets: artifacts | facts | decisions.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('kb_write: ' + validation.errors.join('; '));
  }

  // id must match safe-segment pattern (alphanumeric start, then [a-zA-Z0-9_.-])
  const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
  if (!ID_RE.test(input.id)) {
    return toolError(
      'kb_write: id must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ — got "' + input.id + '"'
    );
  }

  const overwrite = input.overwrite === true;

  // ------------------------------------------------------------------
  // 1. Resolve the KB root from context or project walk.
  // ------------------------------------------------------------------
  let kbDir;
  try {
    if (context && context.projectRoot) {
      kbDir = path.join(context.projectRoot, '.orchestray', 'kb');
    } else {
      kbDir = paths.getKbDir();
    }
  } catch (err) {
    return toolError('kb_write: cannot resolve KB dir: ' + (err && err.message));
  }

  // ------------------------------------------------------------------
  // 2. Validate the caller-supplied path.
  //
  // The path must:
  //   a. be relative (no leading separator)
  //   b. resolve inside .orchestray/kb/<bucket>/
  //   c. not traverse (every segment passes assertSafeSegment)
  // ------------------------------------------------------------------
  const suppliedPath = input.path;

  // Derive what the canonical path under kbDir/bucket should be.
  // We accept two forms:
  //   - bare filename:  "v2015-foo.md"
  //   - relative from project root:  ".orchestray/kb/artifacts/v2015-foo.md"
  // We normalise both to an absolute path and verify containment.
  const bucketDir = path.join(kbDir, input.bucket);
  const bucketDirAbs = path.resolve(bucketDir);

  let artifactAbsPath;
  {
    // Try to resolve relative to project root first, then relative to kbDir bucket.
    // If the supplied path starts with a slash we reject it outright.
    if (path.isAbsolute(suppliedPath)) {
      return toolError('kb_write: path must be relative, got absolute path');
    }

    // Normalise: strip leading ".orchestray/kb/<bucket>/" prefix if present,
    // leaving just the filename/subpath.
    const prefixToStrip = path.join('.orchestray', 'kb', input.bucket) + path.sep;
    // Also handle forward-slash variant for cross-platform callers.
    const prefixFwd = '.orchestray/kb/' + input.bucket + '/';
    let relative = suppliedPath;
    if (relative.startsWith(prefixToStrip)) {
      relative = relative.slice(prefixToStrip.length);
    } else if (relative.startsWith(prefixFwd)) {
      relative = relative.slice(prefixFwd.length);
    }

    // Validate each path segment.
    const segments = relative.split('/').flatMap((s) => s.split(path.sep));
    for (const seg of segments) {
      if (seg === '') continue; // trailing slash artefact
      try {
        paths.assertSafeSegment(seg);
      } catch (err) {
        return toolError('kb_write: unsafe path segment "' + seg + '": ' + (err && err.message));
      }
    }

    artifactAbsPath = path.resolve(path.join(bucketDir, relative));

    // Belt-and-braces containment check.
    if (
      artifactAbsPath !== bucketDirAbs &&
      !artifactAbsPath.startsWith(bucketDirAbs + path.sep)
    ) {
      return toolError('kb_write: path escapes KB bucket root');
    }
  }

  // ------------------------------------------------------------------
  // 3. Acquire the exclusive lock on index.json.
  // ------------------------------------------------------------------
  const indexPath = path.join(kbDir, 'index.json');
  const lockPath = indexPath + '.lock';

  // Ensure parent dirs exist before attempting the lock.
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.mkdirSync(path.dirname(artifactAbsPath), { recursive: true });
  } catch (err) {
    return toolError('kb_write: mkdir failed: ' + (err && err.message));
  }

  const lockFd = _acquireLock(lockPath);
  if (lockFd === null) {
    return toolError(
      'kb_write: lock acquisition timeout after ' +
      (MAX_LOCK_ATTEMPTS * LOCK_BACKOFF_MS) + 'ms — another writer may be active'
    );
  }

  // Everything inside here executes while the lock is held.
  try {
    // ----------------------------------------------------------------
    // 4. Check artifact file existence (overwrite guard).
    // ----------------------------------------------------------------
    const fileExists = fs.existsSync(artifactAbsPath);
    if (fileExists && !overwrite) {
      return toolError(
        'kb_write: file already exists and overwrite=false: ' + artifactAbsPath
      );
    }

    // ----------------------------------------------------------------
    // 5. Read + parse current index.json.
    // ----------------------------------------------------------------
    let indexObj;
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      indexObj = JSON.parse(raw);
      if (!indexObj || typeof indexObj !== 'object' || Array.isArray(indexObj)) {
        throw new Error('index.json root is not an object');
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Brand-new index: initialise a minimal skeleton.
        indexObj = { version: '1.0', created_at: new Date().toISOString(), entries: [] };
      } else {
        // Parse error or structural corruption.
        return toolError(
          'kb_write: index.json is corrupt or unreadable — repair manually. ' +
          'Error: ' + (err && err.message)
        );
      }
    }

    // Ensure the bucket array exists.
    const bucket = input.bucket; // 'artifacts' | 'facts' | 'decisions'
    if (!Array.isArray(indexObj[bucket])) {
      indexObj[bucket] = [];
    }

    // ----------------------------------------------------------------
    // 6. ID collision check.
    // ----------------------------------------------------------------
    const bucketArr = indexObj[bucket];
    const existingIdx = bucketArr.findIndex((e) => e && e.id === input.id);
    if (existingIdx !== -1 && !overwrite) {
      return toolError(
        'kb_write: id "' + input.id + '" already exists in bucket "' +
        bucket + '" and overwrite=false'
      );
    }

    // ----------------------------------------------------------------
    // 7. Write the artifact file (tmp + rename = atomic).
    //    B1 (v2.0.15 preflight): snapshot prior content when overwriting so
    //    step-10 index-write failure can roll back to the prior file state
    //    instead of leaving the caller with a half-committed overwrite.
    // ----------------------------------------------------------------
    let priorArtifactSnapshot = null;
    if (fileExists) {
      try {
        priorArtifactSnapshot = fs.readFileSync(artifactAbsPath);
      } catch (_e) {
        // If we cannot snapshot, roll back on index failure degrades to
        // best-effort unlink (better than orphan but loses prior content).
        priorArtifactSnapshot = null;
      }
    }

    const tmpArtifact = artifactAbsPath + '.kb_write_tmp';
    try {
      fs.writeFileSync(tmpArtifact, input.content, 'utf8');
      fs.renameSync(tmpArtifact, artifactAbsPath);
    } catch (err) {
      try { fs.unlinkSync(tmpArtifact); } catch (_e) {}
      return toolError('kb_write: artifact write failed: ' + (err && err.message));
    }

    const bytesWritten = Buffer.byteLength(input.content, 'utf8');

    // ----------------------------------------------------------------
    // 8. Build the new index entry.
    //    Canonical path is stored relative to the project root.
    // ----------------------------------------------------------------
    let canonicalPath;
    {
      // Compute project root: if context.projectRoot is set, use it;
      // otherwise the kbDir is <projectRoot>/.orchestray/kb.
      const projectRoot = (context && context.projectRoot)
        ? context.projectRoot
        : path.resolve(kbDir, '..', '..');
      canonicalPath = path.relative(projectRoot, artifactAbsPath).replace(/\\/g, '/');
    }

    const newEntry = {
      id: input.id,
      path: canonicalPath,
      author: input.author,
      topic: input.topic,
    };
    if (input.task) newEntry.task = input.task;
    if (input.orchestration_id) newEntry.orchestration_id = input.orchestration_id;

    // ----------------------------------------------------------------
    // 9. Update the bucket array in-place (replace or append).
    // ----------------------------------------------------------------
    if (existingIdx !== -1) {
      bucketArr[existingIdx] = newEntry;
    } else {
      bucketArr.push(newEntry);
    }

    // Count total index entries for reporting.
    const indexEntryTotal =
      (Array.isArray(indexObj.entries) ? indexObj.entries.length : 0) +
      KB_BUCKETS.reduce((sum, b) => sum + (Array.isArray(indexObj[b]) ? indexObj[b].length : 0), 0);

    // ----------------------------------------------------------------
    // 10. Write the updated index.json atomically.
    // ----------------------------------------------------------------
    const tmpIndex = indexPath + '.kb_write_tmp';
    try {
      fs.writeFileSync(tmpIndex, JSON.stringify(indexObj, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpIndex, indexPath);
    } catch (err) {
      try { fs.unlinkSync(tmpIndex); } catch (_e) {}
      // B1 (v2.0.15 preflight): roll back step-7 artifact write so the
      // caller is not left with an orphaned on-disk file and no index entry.
      let rolledBack = 'unknown';
      if (priorArtifactSnapshot !== null) {
        try {
          fs.writeFileSync(artifactAbsPath, priorArtifactSnapshot);
          rolledBack = 'restored_prior';
        } catch (_e) {
          rolledBack = 'restore_failed';
        }
      } else if (!fileExists) {
        try {
          fs.unlinkSync(artifactAbsPath);
          rolledBack = 'unlinked_new';
        } catch (_e) {
          rolledBack = 'unlink_failed';
        }
      }
      return toolError(
        'kb_write: index.json write failed (artifact rollback=' + rolledBack + '): ' +
        (err && err.message)
      );
    }

    // ----------------------------------------------------------------
    // 11. Return success.
    // ----------------------------------------------------------------
    return toolSuccess({
      id: input.id,
      bucket,
      path: canonicalPath,
      bytes_written: bytesWritten,
      index_entry_total: indexEntryTotal,
      warnings: [],
    });

  } finally {
    _releaseLock(lockFd, lockPath);
  }
}

module.exports = { definition, handle };
