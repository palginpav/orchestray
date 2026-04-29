'use strict';

/**
 * `specialist_save` MCP tool.
 *
 * Atomically writes a saved-specialist agent definition file AND upserts its
 * metadata entry in `.orchestray/specialists/registry.json`, both under a
 * single exclusive advisory lock on `registry.json.lock`. Fixes the race
 * conditions in the PM's 8-step manual save sequence
 * (specialist-protocol.md §"Save Process (Section 20)").
 *
 * Lock strategy: reuses the `<filePath>.lock` advisory primitive from
 * bin/_lib/atomic-append.js (O_EXCL + stale-lock recovery). The lock is
 * acquired on the registry.json path so both the agent-file write and the
 * registry update are serialised under one mutex.
 *
 * Per CLAUDE.md recommended stack §"Persistent Specialist Registry".
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

// ---------------------------------------------------------------------------
// Lock primitive (inlined from atomic-append.js — no circular dependency)
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
// Reserved core agent names
// These must stay in sync with the list in specialist-protocol.md §"Save Process".
// ---------------------------------------------------------------------------

const RESERVED_AGENT_NAMES = deepFreeze([
  'pm',
  'architect',
  'developer',
  'refactorer',
  'inventor',
  'reviewer',
  'debugger',
  'tester',
  'documenter',
  'security-engineer',
  'release-manager',
  'ux-critic',
  'platform-oracle',
]);

/**
 * Normalize a specialist name for reserved-name comparison.
 * Per specialist-protocol.md §1.5: NFKD normalization then strip non-ASCII.
 * This prevents bypass via capital letters or homoglyph attacks
 * (e.g. "Reviewer" or "reviewеr" with Cyrillic е).
 */
function _normalizeName(name) {
  return name.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase();
}

/**
 * Returns true if `name` collides with any reserved core agent name.
 */
function _isReservedName(name) {
  const normalized = _normalizeName(name);
  return RESERVED_AGENT_NAMES.some((r) => _normalizeName(r) === normalized);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['name', 'description', 'agent_md_content', 'source'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    agent_md_content: { type: 'string', minLength: 1, maxLength: 524288 },
    source: { type: 'string', enum: ['auto', 'user'] },
  },
});

const definition = deepFreeze({
  name: 'specialist_save',
  description:
    'Atomically write a specialist agent definition file and upsert its entry ' +
    'in .orchestray/specialists/registry.json under a single exclusive lock. ' +
    'Prevents index drift and race conditions in the PM\'s manual save sequence. ' +
    'Rejects names that collide with the 13 reserved core agent names. ' +
    'source must be "auto" or "user".',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('specialist_save', context);
  // ------------------------------------------------------------------
  // 1. Validate inputs against schema.
  // ------------------------------------------------------------------
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('specialist_save: ' + validation.errors.join('; '));
  }

  // name must match safe-segment pattern (letter start, then [a-zA-Z0-9_-])
  if (!NAME_RE.test(input.name)) {
    return toolError(
      'specialist_save: name must match ^[a-zA-Z][a-zA-Z0-9_-]*$ — got "' + input.name + '"'
    );
  }

  // Reserved-name collision check (hard reject per specialist-protocol.md §1.5).
  if (_isReservedName(input.name)) {
    return toolError(
      'specialist_save: name "' + input.name + '" is reserved. Pick a non-colliding name ' +
      '(e.g., "data-engineer", "perf-auditor"). ' +
      'Reserved names (' + RESERVED_AGENT_NAMES.length + '): ' + RESERVED_AGENT_NAMES.join(', ') + '.'
    );
  }

  // ------------------------------------------------------------------
  // 2. Resolve specialists directory from context or project walk.
  // ------------------------------------------------------------------
  let specialistsDir;
  try {
    if (context && context.projectRoot) {
      specialistsDir = path.join(context.projectRoot, '.orchestray', 'specialists');
    } else {
      specialistsDir = path.join(paths.getProjectRoot(), '.orchestray', 'specialists');
    }
  } catch (err) {
    return toolError('specialist_save: cannot resolve project root: ' + (err && err.message));
  }

  const registryPath = path.join(specialistsDir, 'registry.json');
  const lockPath = registryPath + '.lock';
  const agentFilePath = path.join(specialistsDir, input.name + '.md');

  // Ensure the specialists directory exists before attempting the lock.
  // This handles the FIRST-EVER write case where the directory doesn't exist.
  try {
    fs.mkdirSync(specialistsDir, { recursive: true });
  } catch (err) {
    return toolError('specialist_save: mkdir failed: ' + (err && err.message));
  }

  // ------------------------------------------------------------------
  // 3. Acquire the exclusive lock on registry.json.
  // ------------------------------------------------------------------
  const lockFd = _acquireLock(lockPath);
  if (lockFd === null) {
    return toolError(
      'specialist_save: lock acquisition timeout after ' +
      (MAX_LOCK_ATTEMPTS * LOCK_BACKOFF_MS) + 'ms — another writer may be active'
    );
  }

  // Everything inside here executes while the lock is held.
  try {
    // ----------------------------------------------------------------
    // 4. Read + parse current registry.json (or initialize skeleton).
    // ----------------------------------------------------------------
    let registry;
    try {
      const raw = fs.readFileSync(registryPath, 'utf8');
      registry = JSON.parse(raw);
      if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
        throw new Error('registry.json root is not an object');
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Brand-new registry: initialize minimal skeleton.
        registry = { version: 1, specialists: [] };
      } else {
        // Parse error or structural corruption — reject rather than silently clobber.
        return toolError(
          'specialist_save: registry.json is corrupt or unreadable — repair manually. ' +
          'Error: ' + (err && err.message)
        );
      }
    }

    if (!Array.isArray(registry.specialists)) {
      registry.specialists = [];
    }

    // ----------------------------------------------------------------
    // 5. Check for existing entry (upsert vs. create).
    // ----------------------------------------------------------------
    const existingIdx = registry.specialists.findIndex(
      (e) => e && typeof e.name === 'string' && _normalizeName(e.name) === _normalizeName(input.name)
    );
    const isUpdate = existingIdx !== -1;
    const now = new Date().toISOString();

    // ----------------------------------------------------------------
    // 5b. Case-rename scan: before writing <name>.md, remove any existing
    //     .md file whose name matches <name> case-insensitively but differs
    //     in case (e.g. "Foo.md" when writing "foo.md"). This prevents stale
    //     case-variant files from accumulating on case-sensitive filesystems.
    //
    //     macOS APFS inode check (R2-B-2): on case-insensitive filesystems
    //     (APFS, HFS+), a rename() of "Foo.md" -> "foo.md" results in both
    //     names pointing to the same physical file. If we unlink the old path
    //     AFTER renaming the new content to the canonical path, we would delete
    //     the just-written content. Guard: if stat(existingPath).ino ===
    //     stat(newPath).ino, the two names are the same physical inode -- SKIP
    //     the unlink; the rename already "moved" the name.
    // ----------------------------------------------------------------
    try {
      const nameLower = input.name.toLowerCase();
      const existing = fs.readdirSync(specialistsDir);
      for (const entry of existing) {
        if (!entry.endsWith('.md')) continue;
        const stem = entry.slice(0, -3);
        if (stem.toLowerCase() !== nameLower) continue;
        // Same case-insensitive name but potentially different case.
        const existingPath = path.join(specialistsDir, entry);
        if (existingPath === agentFilePath) continue; // exact match -- no action needed

        // Check if the existing path and the target path are the same inode.
        // This happens on case-insensitive filesystems (macOS APFS) where
        // "Foo.md" and "foo.md" are the same physical file.
        let sameInode = false;
        try {
          const existingIno = fs.statSync(existingPath).ino;
          const newIno = fs.statSync(agentFilePath).ino;
          sameInode = (existingIno === newIno);
        } catch (_e) {
          // Target file not yet written, or existingPath unreadable; proceed with unlink.
        }

        if (!sameInode) {
          try { fs.unlinkSync(existingPath); } catch (_e) { /* best-effort */ }
        }
        // If sameInode: both names back the same physical file -- skip unlink.
      }
    } catch (_e) {
      // Case-rename scan is best-effort; never block the save.
    }

    // ----------------------------------------------------------------
    // 6. Snapshot prior agent file for rollback on index-write failure.
    // ----------------------------------------------------------------
    const agentFileExists = fs.existsSync(agentFilePath);
    let priorAgentSnapshot = null;
    if (agentFileExists) {
      try {
        priorAgentSnapshot = fs.readFileSync(agentFilePath);
      } catch (_e) {
        // Snapshot failed — rollback degrades to best-effort unlink.
        priorAgentSnapshot = null;
      }
    }

    // ----------------------------------------------------------------
    // 7. Write the agent .md file atomically (tmp + rename).
    // ----------------------------------------------------------------
    const tmpAgentFile = agentFilePath + '.specialist_save_tmp';
    try {
      fs.writeFileSync(tmpAgentFile, input.agent_md_content, 'utf8');
      fs.renameSync(tmpAgentFile, agentFilePath);
    } catch (err) {
      try { fs.unlinkSync(tmpAgentFile); } catch (_e) {}
      return toolError('specialist_save: agent file write failed: ' + (err && err.message));
    }

    // ----------------------------------------------------------------
    // 8. Build the registry entry (create or upsert).
    // ----------------------------------------------------------------
    let newEntry;
    if (isUpdate) {
      // Preserve created_at and times_used; update description and last_used.
      const existing = registry.specialists[existingIdx];
      newEntry = {
        name: input.name,
        description: input.description,
        source: input.source,
        file: input.name + '.md',
        times_used: (typeof existing.times_used === 'number') ? existing.times_used : 0,
        last_used: now,
        created_at: existing.created_at || now,
      };
      registry.specialists[existingIdx] = newEntry;
    } else {
      newEntry = {
        name: input.name,
        description: input.description,
        source: input.source,
        file: input.name + '.md',
        times_used: 0,
        last_used: null,
        created_at: now,
      };
      registry.specialists.push(newEntry);
    }

    const registrySize = registry.specialists.length;

    // ----------------------------------------------------------------
    // 9. Write the updated registry.json atomically (tmp + rename).
    // ----------------------------------------------------------------
    const tmpRegistry = registryPath + '.specialist_save_tmp';
    try {
      fs.writeFileSync(tmpRegistry, JSON.stringify(registry, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpRegistry, registryPath);
    } catch (err) {
      try { fs.unlinkSync(tmpRegistry); } catch (_e) {}
      // Roll back step-7 agent file write so we don't leave an orphaned file
      // on disk with no registry entry.
      let rolledBack = 'unknown';
      if (priorAgentSnapshot !== null) {
        try {
          fs.writeFileSync(agentFilePath, priorAgentSnapshot);
          rolledBack = 'restored_prior';
        } catch (_e) {
          rolledBack = 'restore_failed';
        }
      } else if (!agentFileExists) {
        try {
          fs.unlinkSync(agentFilePath);
          rolledBack = 'unlinked_new';
        } catch (_e) {
          rolledBack = 'unlink_failed';
        }
      }
      return toolError(
        'specialist_save: registry.json write failed (agent file rollback=' + rolledBack + '): ' +
        (err && err.message)
      );
    }

    // ----------------------------------------------------------------
    // 10. Return success.
    // ----------------------------------------------------------------
    return toolSuccess({
      name: input.name,
      file_path: '.orchestray/specialists/' + input.name + '.md',
      registry_size: registrySize,
      was_create_or_update: isUpdate ? 'update' : 'create',
    });

  } finally {
    _releaseLock(lockFd, lockPath);
  }
}

module.exports = { definition, handle };
