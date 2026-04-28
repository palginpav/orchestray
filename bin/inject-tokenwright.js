#!/usr/bin/env node
'use strict';

/**
 * inject-tokenwright.js — PreToolUse:Agent hook (v2.2.5, tokenwright L1).
 *
 * Compresses delegation prompts before Agent() spawns via MinHash dedup (L1).
 * Layer 2 (Haiku block-scoring) is reserved for W4 — no-op placeholder here.
 *
 * Kill switches: ORCHESTRAY_DISABLE_COMPRESSION=1, cfg.compression.enabled===false,
 * level 'off', level 'debug-passthrough'.
 * Levels: off | safe (default) | aggressive | experimental | debug-passthrough.
 *
 * Fail-safe: any exception → original tool_input unchanged, spawn always allowed.
 * routing.jsonl is never opened, read, or written by this hook.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { parseSections, reassembleSections } = require('./_lib/tokenwright/parse-sections');
const { classifySection }             = require('./_lib/tokenwright/classify-section');
const { applyMinHashDedup }           = require('./_lib/tokenwright/dedup-minhash');
const { emitPromptCompression }       = require('./_lib/tokenwright/emit');

function emitPassthrough(toolInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', modifiedToolInput: toolInput },
    continue: true,
  }));
}

function loadConfig(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8')); }
  catch (_e) { return {}; }
}

function resolveLevel(cfg) {
  const env = process.env.ORCHESTRAY_COMPRESSION_LEVEL;
  if (env) return env;
  return (cfg.compression && cfg.compression.level) || 'safe';
}

function isDisabled(cfg, level) {
  if (process.env.ORCHESTRAY_DISABLE_COMPRESSION === '1') return true;
  if (cfg.compression && cfg.compression.enabled === false) return true;
  return level === 'off' || level === 'debug-passthrough';
}

function resolveOrchestrationId(cwd) {
  try {
    const d = JSON.parse(fs.readFileSync(getCurrentOrchestrationFile(cwd), 'utf8'));
    return (d && typeof d.orchestration_id === 'string') ? d.orchestration_id : null;
  } catch (_e) { return null; }
}

function spawnKey(agentType, prompt) {
  return (agentType || 'unknown') + ':' +
    crypto.createHash('sha256').update(prompt || '').digest('hex').slice(0, 32);
}

function writePendingEntry(cwd, entry) {
  try {
    const dir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tokenwright-pending.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_e) {
    try { process.stderr.write('[inject-tokenwright] pending journal write failed: ' + String(_e) + '\n'); }
    catch (_i) { /* swallow */ }
  }
}

function runL1(prompt) {
  const sections = parseSections(prompt);
  for (const s of sections) s.kind = classifySection(s).kind;
  const { dropped: droppedCount } = applyMinHashDedup(sections);
  const droppedSections = sections.filter(s => s.dropped).map(s => s.heading || '(preamble)');
  return { compressed: reassembleSections(sections), droppedSections, droppedCount };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[inject-tokenwright] stdin exceeded limit; failing open\n');
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  let toolInput;
  try {
    let event;
    try { event = JSON.parse(input || '{}'); }
    catch (_e) { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); return; }

    if ((event.tool_name || '') !== 'Agent') {
      process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); return;
    }

    toolInput = event.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
      process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); return;
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

    const cfg   = loadConfig(cwd);
    const level = resolveLevel(cfg);
    if (isDisabled(cfg, level)) { emitPassthrough(toolInput); process.exit(0); return; }

    const prompt    = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    const agentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : 'unknown';
    const inBytes   = Buffer.byteLength(prompt, 'utf8');

    const { compressed, droppedSections, droppedCount } = runL1(prompt);

    // Layer 2 (Haiku block-scoring) — W4 placeholder. When W4 ships, feed
    // score-eligible sections through a Haiku subagent; technique_tag becomes
    // 'aggressive-l1l2' / 'experimental-l1l2l3'.

    const outBytes    = Buffer.byteLength(compressed, 'utf8');
    const ratio       = inBytes > 0 ? outBytes / inBytes : 1;
    const inTokEst    = Math.round(inBytes / 4);
    const outTokEst   = Math.round(outBytes / 4);
    const tag         = level === 'aggressive' ? 'aggressive-l1' : level === 'experimental' ? 'experimental-l1' : 'safe-l1';
    const orchId      = resolveOrchestrationId(cwd);

    emitPromptCompression({
      orchestration_id: orchId, task_id: null, agent_type: agentType,
      input_bytes: inBytes, output_bytes: outBytes, ratio, technique_tag: tag,
      input_token_estimate: inTokEst, output_token_estimate: outTokEst,
      dropped_sections: droppedSections, layer1_dedup_blocks_dropped: droppedCount,
    });

    writePendingEntry(cwd, {
      spawn_key: spawnKey(agentType, prompt), orchestration_id: orchId, task_id: null,
      agent_type: agentType, technique_tag: tag, input_token_estimate: inTokEst,
      timestamp: new Date().toISOString(),
    });

    emitPassthrough(Object.assign({}, toolInput, { prompt: compressed }));
    process.exit(0);

  } catch (_err) {
    try { process.stderr.write('[inject-tokenwright] compression_skipped: ' + String(_err && _err.message ? _err.message : _err) + '\n'); }
    catch (_e) { /* swallow */ }
    if (toolInput && typeof toolInput === 'object') emitPassthrough(toolInput);
    else process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
