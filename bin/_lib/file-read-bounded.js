'use strict';

/**
 * file-read-bounded.js — TOCTOU-safe bounded file read.
 *
 * Replaces the SEC-04 `fs.statSync(path).size > cap → fs.readFileSync(path)`
 * pattern. By opening the file to a single fd and reading at most `maxBytes`
 * bytes from that fd, we eliminate the race window where a concurrent writer
 * can inflate the file between the stat and the read (LOW-R2-01).
 *
 * POSIX guarantee: `read(fd, buf, 0, cap, 0)` returns at most `cap` bytes
 * from the file descriptor as it was opened, regardless of how much data a
 * concurrent writer appends after the open.
 *
 * Usage (from bin/ scripts):
 *   const { readFileBounded } = require('./file-read-bounded');
 *   const result = readFileBounded('/path/to/file', 10 * 1024 * 1024);
 *   if (!result.ok) { /* fail-open … *\/ }
 *   const text = result.content;
 */

const fs = require('node:fs');

/**
 * Read at most `maxBytes` bytes from `filePath` in a single fd-based
 * operation, eliminating the stat→read TOCTOU race.
 *
 * Returns:
 *   { ok: true,  content: string }                       — success
 *   { ok: false, reason: 'file_too_large', size_hint: number } — exceeded cap
 *   { ok: false, reason: 'read_failed',    err: string }       — fs error
 *
 * @param {string} filePath  - Absolute path to the file.
 * @param {number} maxBytes  - Maximum number of bytes to read (inclusive).
 * @returns {{ ok: boolean, content?: string, reason?: string,
 *             size_hint?: number, err?: string }}
 */
function readFileBounded(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    // Allocate one extra byte so we can detect "exactly at cap" vs "over cap".
    const buf = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) {
      return { ok: false, reason: 'file_too_large', size_hint: bytesRead };
    }
    return { ok: true, content: buf.slice(0, bytesRead).toString('utf8') };
  } catch (err) {
    return { ok: false, reason: 'read_failed', err: err.code || String(err) };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

module.exports = { readFileBounded };
