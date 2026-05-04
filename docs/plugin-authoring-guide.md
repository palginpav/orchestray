# Plugin Authoring Guide

Orchestray's plugin loader (v2.3.0+) lets external MCP servers extend Orchestray's tool surface. This guide covers what you need to build, install, and test a plugin.

**Security disclosure first:** plugins run as unsandboxed child processes with access to the same filesystem, network, and credentials as the Orchestray host process. Read [README §No sandbox security model](../README.md#no-sandbox-security-model) before shipping a plugin to users.

---

## Manifest reference

Every plugin must include an `orchestray-plugin.json` file at its root. The loader validates this against `bin/_lib/plugin-manifest-schema.js` (zod). Unknown top-level keys are rejected (`.strict()`).

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | `1` (literal) | Required | Schema version. Must be exactly `1`. |
| `name` | `string` | Required | Kebab-case, 2–48 chars, lowercase letter start. Reserved prefixes (`plugin_`, `orchestray`, `mcp`, `core`, `__`) and exact reserved names (`orchestray`, `core`, `plugin`, `system`) are rejected. No bidi/zero-width unicode. |
| `version` | `string` | Required | Semver (e.g. `"1.2.3"`, `"1.0.0-beta.1"`). |
| `description` | `string` | Required | 1–500 chars. No bidi/zero-width unicode. Shown in consent UI. |
| `entrypoint` | `string` | Required | Relative path to the server executable from the plugin root. Must not start with `/` or contain `..`. |
| `transport` | `"stdio"` | Required | Only `stdio` is supported in v2.3.0. |
| `runtime` | `"node" | "python" | "any"` | Required | Declares the runtime. `"any"` means the entrypoint is a self-contained executable. |
| `tools` | `ToolDecl[]` | Required | At least one tool. Each entry: `name` (same kebab-case rules), `description` (≤500 chars), `inputSchema` (JSON Schema object). |
| `capabilities` | `object` | Optional | Free-form capability hints. Not validated beyond prototype-pollution scrub. |
| `signature` | `object` | Optional | Reserved for future fingerprint/signing (W-SEC-7, Wave 3+). |

**Name validation rules (enforced by schema):**
- Pattern: `/^[a-z][a-z0-9-]{1,47}$/`
- Rejected prefixes: `plugin_`, `orchestray`, `mcp`, `core`, `__`
- Rejected exact names: `orchestray`, `core`, `plugin`, `system`
- Bidi/zero-width unicode rejected in `name` and `description` (W-SEC-11)

---

## MCP server contract

Plugins communicate with the loader over **stdin/stdout NDJSON JSON-RPC 2.0**. One JSON object per line, no pretty-printing.

The loader runs a two-step handshake immediately after spawning the process:

### Step 1 — initialize

Loader sends:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"orchestray-broker","version":"2.3.0"}}}
```

Plugin must respond with `capabilities` and `serverInfo`:
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"my-plugin","version":"1.0.0"}}}
```

### Step 2 — tools/list

Loader sends:
```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Plugin must respond with exactly the tools declared in the manifest — same names, same count. Divergence transitions plugin to `dead` state (reason: `manifest_divergence`).

### Step 3 — tools/call (normal operation)

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"my-tool","arguments":{"input":"hello"}}}
```

Response:
```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hello back"}]}}
```

**Limits enforced by the loader:**
- Per-line stdout cap: 1 MB. Overflow kills the plugin (`protocol_dos`).
- Total backlog cap: 16 MB. Overflow kills the plugin.
- Per-call timeout: 60 seconds.
- Arguments validated against `inputSchema` before forwarding (W-SEC-9).

Full protocol specification: [MCP Tools spec (2024-11-05)](https://modelcontextprotocol.io/specification/2024-11-05/server/tools).

---

## Security model

Summary of Orchestray's no-sandbox posture:

- **No process isolation.** Plugins run as direct child processes with the host user's UID/GID. No container, no chroot, no seccomp.
- **Env strip, not inherit.** Spawned process receives only an allowlisted subset of env vars (W-SEC-16), not the full `process.env`.
- **Plugin output is untrusted bytes.** Tool responses must never be quoted into system prompts, shell commands, or audit fields without escaping/redaction.
- **Consent required before load.** Plugins must be approved via `/orchestray:plugin approve <name>`. Symlinks and path-shadow conflicts are rejected at scan time (W-SEC-1, W-SEC-2).

See [README §No sandbox security model](../README.md#no-sandbox-security-model) for the full disclosure.

---

## Lifecycle

Plugins move through 8 states. Canonical FSM: `bin/_lib/plugin-loader.js`.

| State | Meaning | Trigger |
|---|---|---|
| `unknown` | No record of this plugin | — |
| `discovered` | Manifest found and validated at scan | `scan()` — auto on startup or `/orchestray:plugin reload` |
| `consented` | User approved this plugin | `/orchestray:plugin approve <name>` |
| `loading` | Process spawning + MCP handshake in progress | Internal — triggered by `load()` after consent |
| `ready` | Handshake succeeded; tools registered | Successful `initialize` + `tools/list` |
| `degraded` | Running but errors detected; restart backoff active (1s → 5s → 30s, 5-min reset) | Subprocess crash or timeout |
| `dead` | Terminated unrecoverably | Manifest divergence, repeated crash, stdout cap exceeded |
| `unloaded` | Cleanly removed from registry | `/orchestray:plugin disable <name>` |

After `dead`, the loader auto-restarts up to 3 times with backoff (1 s → 5 s → 30 s). After the budget is exhausted, run `/orchestray:plugin reload <name>` to retry manually.

---

## Examples

### Minimal plugin — Node.js

This is the `fake-plugin` fixture from `tests/fixtures/fake-plugin/`. It works as a smoke test against `bin/_lib/__tests__/plugin-loader.smoke.test.js` and is a battle-tested template.

**`orchestray-plugin.json`**

```json
{
  "schema_version": 1,
  "name": "fake-plugin",
  "version": "1.0.0",
  "description": "Test fixture for plugin-loader Wave 2 smoke tests; echoes its argument back as text.",
  "entrypoint": "server.js",
  "transport": "stdio",
  "runtime": "node",
  "tools": [
    {
      "name": "echo",
      "description": "Echoes the input text back unchanged.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": { "type": "string" }
        },
        "required": ["text"]
      }
    }
  ]
}
```

**`server.js`** (fake-plugin fixture — works as smoke test against plugin-loader.smoke.test.js)

```js
#!/usr/bin/env node
'use strict';

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.length) continue;
    let frame;
    try { frame = JSON.parse(line); } catch (_e) { continue; }
    handle(frame);
  }
});

function handle({ id, method, params = {} }) {
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake-plugin', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') {
    return ok(id, { tools: [{
      name: 'echo',
      description: 'Echoes the input text back unchanged.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }] });
  }
  if (method === 'tools/call') {
    const text = String((params.arguments || {}).text ?? '');
    return ok(id, { content: [{ type: 'text', text }] });
  }
}
```

The full fixture also exposes env-mode flags (FAKE_DIVERGE, FAKE_SLEEP_MS, FAKE_FLOOD_MB, FAKE_BACKLOG_MB, FAKE_EXIT_ON_CALL) used by integration tests; production plugins should omit those. The fixture also returns JSON-RPC error -32601 for unknown methods, which a production plugin should also do for protocol compliance.

### Python skeleton

```python
#!/usr/bin/env python3
import json, sys

def send(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()

TOOL = {
    "name": "greet",
    "description": "Returns a greeting.",
    "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}
}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid, method = req.get("id"), req.get("method")
    params = req.get("params", {})
    if method == "initialize":
        send({"jsonrpc":"2.0","id":rid,"result":{"protocolVersion":"2025-03-26",
              "capabilities":{"tools":{"listChanged":False}},"serverInfo":{"name":"greet-plugin","version":"1.0.0"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":rid,"result":{"tools":[TOOL]}})
    elif method == "tools/call":
        name = (params.get("arguments") or {}).get("name", "world")
        send({"jsonrpc":"2.0","id":rid,"result":{"content":[{"type":"text","text":"Hello, " + name + "!"}]}})
```
