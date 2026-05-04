---
name: plugin
description: Manage Orchestray plugins — list, approve, disable, reload, status
disable-model-invocation: true
argument-hint: "list | approve <name> | disable <name> | reload <name> | status [<name>]"
---

# Orchestray Plugin Management

The user invoked `/orchestray:plugin`. Delegate to the CLI handler.

## Protocol

Run the following command, passing `$ARGUMENTS` verbatim:

```
node bin/orchestray-plugin-cli.js $ARGUMENTS
```

Do not interpret or modify `$ARGUMENTS`. The CLI handles all subcommand parsing.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | Show all discovered plugins with name, version, fingerprint, and consent state |
| `approve <name>` | Render consent prompt (capabilities + tools + warning) and record approval interactively |
| `disable <name>` | Revoke consent for a plugin — plugin will not load until re-approved |
| `reload <name>` | Re-scan plugin and verify fingerprint against stored consent; refuses on fingerprint change |
| `status [<name>]` | Show lifecycle state, consent record, audit event count for one or all plugins |

## Security Note

Plugins run **unsandboxed** with the same filesystem and network access as Orchestray.
Always review plugin source code before approving. The `approve` subcommand will show
the plugin's declared capabilities and tools alongside a warning before asking for
confirmation.

`approve` requires an interactive terminal (TTY). It cannot be run from piped input.

## Examples

```
/orchestray:plugin list
/orchestray:plugin approve my-plugin
/orchestray:plugin disable my-plugin
/orchestray:plugin reload  my-plugin
/orchestray:plugin status
/orchestray:plugin status  my-plugin
```
