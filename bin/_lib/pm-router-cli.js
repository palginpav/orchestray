#!/usr/bin/env node
'use strict';
/**
 * pm-router-cli.js — CLI wrapper for decideRoute().
 * Usage: node pm-router-cli.js [task-text]
 *        echo "task text" | node pm-router-cli.js
 * Prints one JSON line to stdout. Exit 0 always.
 */
const fs = require('fs');
const path = require('path');
const { decideRoute } = require('./pm-router-rule');

function loadConfig() {
  try {
    const p = path.join(process.cwd(), '.orchestray', 'config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) { return {}; }
}

function run(text) {
  try {
    const result = decideRoute({
      task_text: text,
      config: loadConfig(),
      env: process.env,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (_e) {
    process.stdout.write(JSON.stringify({ decision: 'escalate', reason: 'parse_error_fail_safe', lite_score: 0 }) + '\n');
  }
  process.exit(0);
}

const argText = process.argv[2];
if (typeof argText === 'string' && argText.trim().length > 0) {
  run(argText);
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => { run(buf); });
  process.stdin.on('error', () => { run(''); });
}
