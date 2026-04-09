#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook — fast complexity pre-check.
 *
 * Analyzes the user's prompt for complexity signals BEFORE the model
 * sees it. If signals indicate medium+ complexity, prepends an
 * orchestration instruction so PM's auto-trigger takes priority
 * over other skills (like superpowers:brainstorming).
 *
 * Must be fast (<3s). No external dependencies.
 *
 * Input: JSON on stdin with { prompt: string }
 * Output: JSON on stdout:
 *   - { "continue": true } — pass through unchanged (simple task)
 *   - { "continue": true, "modifications": { "message": "..." } } — prepend orchestration hint
 */

const fs = require('fs');
const path = require('path');

// Complexity signals (mirrors PM Section 12 heuristics)
const COMPLEXITY_KEYWORDS = [
  'refactor', 'redesign', 'migrate', 'rewrite', 'overhaul',
  'restructure', 'rebuild', 'rearchitect', 'implement', 'build',
  'create', 'develop', 'set up', 'configure', 'integrate',
  'add authentication', 'add auth', 'api', 'database', 'deploy',
  'ci/cd', 'pipeline', 'testing', 'test suite'
];

const CROSS_CUTTING_TERMS = [
  'frontend', 'backend', 'database', 'api', 'auth', 'ui',
  'server', 'client', 'middleware', 'schema', 'migration',
  'deployment', 'docker', 'config', 'security', 'logging'
];

// Patterns that strongly signal "build a project from a spec/description"
// These get an automatic high score regardless of other signals
const PROJECT_CREATION_PATTERNS = [
  /make\s+(a\s+)?project/i,
  /build\s+(a\s+)?project/i,
  /create\s+(a\s+)?project/i,
  /make\s+(it|this)\s+(into|from)/i,
  /build\s+(it|this)\s+(from|based)/i,
  /implement\s+(it|this|the)/i,
  /read\s+\S+\s+and\s+(make|build|create|implement|develop)/i,
  /from\s+(this|the)\s+(spec|description|doc|prd|requirements)/i,
  /make\s+.+\s+of\s+(it|this)/i,
  /build\s+.+\s+of\s+(it|this)/i,
];

function scoreComplexity(prompt) {
  const lower = prompt.toLowerCase();
  const words = lower.split(/\s+/);
  let score = 0;

  // Signal 0: Project creation patterns — automatic high score
  // These are short prompts that reference files + action verbs
  // The complexity lives in the file, not the prompt
  const isProjectCreation = PROJECT_CREATION_PATTERNS.some(p => p.test(lower));
  if (isProjectCreation) {
    return 8; // Force orchestration — file content determines actual complexity
  }

  // Signal 1: Description length (0-3)
  if (words.length > 50) score += 3;
  else if (words.length > 25) score += 2;
  else if (words.length > 12) score += 1;

  // Signal 2: Complexity keywords (0-3)
  const keywordHits = COMPLEXITY_KEYWORDS.filter(k => lower.includes(k)).length;
  if (keywordHits >= 4) score += 3;
  else if (keywordHits >= 2) score += 2;
  else if (keywordHits >= 1) score += 1;

  // Signal 3: Cross-cutting concerns (0-3)
  const domainHits = CROSS_CUTTING_TERMS.filter(t => lower.includes(t)).length;
  if (domainHits >= 4) score += 3;
  else if (domainHits >= 2) score += 2;
  else if (domainHits >= 1) score += 1;

  // Signal 4: Multi-file indicators (0-3)
  const filePatterns = (lower.match(/\.\w{1,4}\b/g) || []).length; // file extensions
  const multiFileWords = ['files', 'modules', 'components', 'pages', 'routes', 'endpoints'];
  const multiHits = multiFileWords.filter(w => lower.includes(w)).length;
  const fileScore = filePatterns + multiHits;
  if (fileScore >= 4) score += 3;
  else if (fileScore >= 2) score += 2;
  else if (fileScore >= 1) score += 1;

  return score;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => { process.stdout.write(JSON.stringify({ continue: true })); process.exit(0); });
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    const debugLog = `/tmp/orchestray-hook-debug.log`;

    try {
      const data = JSON.parse(input);
      const prompt = data.message || data.prompt || '';

      // Read config once — used for force_solo, threshold, and verbose
      let config = {};
      try {
        const configPath = path.join(data.cwd || process.cwd(), '.orchestray', 'config.json');
        if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
      } catch (_e) { /* ignore config errors */ }

      const forceSolo = config.force_solo || false;
      const threshold = config.complexity_threshold || 4;
      const verbose = config.verbose || false;

      // Debug: log what we received and scoring result
      if (verbose) {
        try { fs.appendFileSync(debugLog, `  Keys: ${Object.keys(data).join(', ')}\n  Prompt (first 200): ${prompt.substring(0, 200)}\n`); } catch(e) {}
      }

      // Skip internal Claude Code framework messages
      if (prompt.trim().startsWith('<task-notification>') ||
          prompt.trim().startsWith('<task-id>') ||
          prompt.trim().startsWith('<tool-use-id>') ||
          prompt.includes('<command-name>') ||
          prompt.includes('<command-message>')) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      // Skip if prompt is a slash command (already routed)
      if (prompt.trim().startsWith('/')) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      // Skip very short prompts (questions, chat)
      if (prompt.trim().split(/\s+/).length < 5) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      // Check if config has force_solo
      if (forceSolo) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const score = scoreComplexity(prompt);
      if (verbose) {
        try { fs.appendFileSync(debugLog, `  Score: ${score}\n`); } catch(e) {}
      }

      if (score >= threshold) {
        // Write marker file — PM's Section 0 checks for this and triggers orchestration
        if (verbose) {
          try { fs.appendFileSync(debugLog, `  Action: writing orchestrate marker\n`); } catch(e) {}
        }

        const cwd = data.cwd || process.cwd();
        const markerDir = path.join(cwd, '.orchestray');
        const markerPath = path.join(markerDir, 'auto-trigger.json');

        // Before writing new marker, check for stale ones
        try {
          if (fs.existsSync(markerPath)) {
            const stat = fs.statSync(markerPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs > 5 * 60 * 1000) { // 5 minutes
              fs.unlinkSync(markerPath); // Delete stale marker
            }
          }
        } catch (_e) { /* ignore */ }

        try {
          fs.mkdirSync(markerDir, { recursive: true });
          fs.writeFileSync(markerPath, JSON.stringify({
            score: score,
            threshold: threshold,
            prompt: prompt,
            timestamp: new Date().toISOString(),
            session_id: data.session_id || null
          }));
        } catch(e) {
          if (verbose) {
            try { fs.appendFileSync(debugLog, `  Marker write error: ${e.message}\n`); } catch(e2) {}
          }
        }

        // Let the prompt through — PM will detect the marker and orchestrate
        process.stdout.write(JSON.stringify({
          continue: true,
          additionalContext: `ORCHESTRAY: Complex task detected (score ${score}/12). Check .orchestray/auto-trigger.json and follow Section 0 Medium+ Task Path. Orchestrate this task — do NOT handle it directly.`
        }));
      } else {
        if (verbose) {
          try { fs.appendFileSync(debugLog, `  Action: pass-through (below threshold)\n`); } catch(e) {}
        }
        // Simple task — pass through unchanged
        process.stdout.write(JSON.stringify({ continue: true }));
      }
    } catch (e) {
      // On any error, pass through unchanged
      process.stdout.write(JSON.stringify({ continue: true }));
    }
  });
}

main();
