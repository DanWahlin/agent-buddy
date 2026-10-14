# ESP32 Agent Companion Copilot plugin

This Agent Plugins 1.0 package connects GitHub Copilot to the existing local
ESP32 Agent Companion daemon. Its stdio MCP server never opens a serial port.
The daemon remains the single USB owner and aggregates app leases with existing
Copilot CLI sessions.

## Supported behavior

The plugin provides:

- `status` for daemon and device status.
- `test_connection` for an acknowledged daemon-to-device round trip.
- `set_state` for validated `working`, `attention`, `complete`, `surprise`, and
  `idle` state changes.
- `narrate` for a short purpose-written action line when Voice notifications
  are in Contextual mode.
- A focused skill that uses those tools around work, user-attention gates, and
  verified completion, and privacy-safe contextual narration when enabled.

Persistent app states use expiring daemon leases. If the MCP process or app
stops without releasing its lease, the daemon watchdog returns the display to
the next valid aggregate state. `surprise` is transient.

## Install

Install and start the shared daemon first:

```bash
npm config set registry "https://packagefeedproxy.microsoft.io/npm/"
npm ci --prefix daemon
npm --prefix daemon run install:daemon
npm --prefix daemon run status
```

For the app UI, open **Customize** > **Plugins**, use the marketplace settings
to add `bradygaster/esp32-agent-companion`, then install
`esp32-agent-companion`.

The equivalent CLI marketplace flow is:

```bash
copilot plugin marketplace add bradygaster/esp32-agent-companion
copilot plugin install esp32-agent-companion@esp32-agent-companion
```

Restart the GitHub Copilot app, open **Customize**, then verify the plugin, skill,
and `esp32-agent-companion` MCP server appear under **Installed**. The app shares
plugins, skills, and MCP servers configured for Copilot CLI.

Direct CLI installation from the repository subdirectory is also supported:

```bash
copilot plugin install bradygaster/esp32-agent-companion:plugins/copilot-app-companion
```

Uninstall only the plugin with:

```bash
copilot plugin uninstall esp32-agent-companion
```

The daemon is intentionally left installed because Copilot CLI hooks may still
use it.

## Local development

Run the plugin without installing or caching it:

```bash
copilot --plugin-dir ./plugins/copilot-app-companion
```

Run its dependency-free tests:

```bash
npm --prefix plugins/copilot-app-companion test
```

After changing an installed copy, install it again or start a new session so the
host reloads the plugin.

## Automation limitation

As of September 19, 2026, GitHub documents hooks as supported in **Copilot CLI**
and **Copilot cloud agent**. The hooks reference does not list the GitHub Copilot
app as a hook execution surface. This plugin therefore does not claim
deterministic app-wide lifecycle hooks.

App activity is driven by explicit MCP calls guided by the included skill, with
expiring leases as crash recovery. Existing Copilot CLI lifecycle hooks remain
the deterministic integration for CLI sessions and continue to aggregate with
app leases. Do not start another serial monitor or MCP process that opens the
ESP32 port while the daemon is running.

References:

- [About GitHub Copilot plugins](https://docs.github.com/en/copilot/concepts/agents/about-plugins)
- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Customizing the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)
