'use strict';

/**
 * config-defaults.js — Single-source-of-truth for tokenwright config defaults.
 *
 * Centralises all kill-switch defaults so `/orchestray:config` and runtime
 * inspection can surface them without reading inject-tokenwright.js source.
 *
 * v2.2.20 audit verdict: l1_compression_enabled stays false.
 * See .orchestray/kb/artifacts/v2220-l1-revival-design.md §Executive Verdict
 * (0/477 production prompts matched the dedup-eligible heading list; do not revive).
 */

const defaults = Object.freeze({
  tokenwright: Object.freeze({
    // Kill-switch: L1 MinHash intra-prompt dedup. Default: false (do NOT flip).
    // Audit v2.2.20 found 0/477 production prompts matched any dedup-eligible heading.
    // See .orchestray/kb/artifacts/v2220-l1-revival-design.md §Executive Verdict.
    l1_compression_enabled: false,
    // F-23: consumed by bootstrap-estimator.js to enable token-count bootstrapping.
    bootstrap_enabled: true,
  }),

  /**
   * plugin_loader — Runtime MCP plugin lifecycle defaults.
   *
   * W-CFG-1 (Wave 4 plugin-loader config): mirrors DEFAULT_OPTS in
   * bin/_lib/plugin-loader.js so .orchestray/config.json is the single
   * source of truth for plugin lifecycle tuning.
   *
   * Env override resolution table (consumed by plugin-loader.js at init):
   *   ORCHESTRAY_PLUGIN_LOADER_DISABLED=1   → plugin_loader.enabled = false
   *   ORCHESTRAY_PLUGIN_DISCOVERY_DISABLED=1 → plugin_loader.discovery.enabled = false
   *   ORCHESTRAY_PLUGIN_LOADER_DRY_RUN=1    → plugin_loader.dry_run = true
   *   ORCHESTRAY_PLUGIN_DISABLE=<csv>       → comma-separated plugin ids to disable
   *     (applied at consumer; not stored in the defaults object itself)
   */
  plugin_loader: Object.freeze({
    // Master on/off switch for the plugin loader subsystem.
    enabled: true,

    discovery: Object.freeze({
      // Enable automatic plugin discovery on startup.
      enabled: true,
      // Additional scan paths beyond the built-in defaults. null = use built-ins only.
      scan_paths: null,
    }),

    consent: Object.freeze({
      // Require explicit user grant before activating a plugin.
      require_explicit_grant: true,
      // Auto-approve plugins that lack a signature (unsigned). Keep false in prod.
      // v2.3.0: future flag, not consumed by plugin-loader.js yet.
      auto_approve_unsigned: false,
    }),

    lifecycle: Object.freeze({
      // Max restart attempts before the loader marks a plugin as failed-permanent.
      max_restart_attempts: 3,
      // Backoff delays (ms) between successive restart attempts.
      restart_backoff_ms: Object.freeze([1000, 5000, 30000]),
      // Window (ms) after which restart counter resets if no crash occurs.
      restart_reset_window_ms: 300000,
      // Timeout (ms) for a single MCP tool call routed through the plugin.
      tool_call_timeout_ms: 60000,
      // Timeout (ms) for spawning the plugin subprocess.
      spawn_timeout_ms: 10000,
      // Maximum byte size of a tool call response payload.
      tools_response_max_bytes: 1048576,
    }),

    telemetry: Object.freeze({
      // Emit orchestray events for each tool invocation through the plugin.
      emit_tool_invocation_events: true,
      // Redact tool arguments before emitting events (prevents secret leakage).
      redact_args: true,
    }),

    // Emit an event when the active plugin list changes (plugin added/removed/failed).
    notify_list_changed: true,
    // Check for a restart-required flag file on each plugin tool call.
    restart_flag_check: true,
    // Run in dry-run mode: discover and validate plugins but do not activate them.
    dry_run: false,
  }),
});

module.exports = { defaults };
