# Agent Buddy for Stream Deck

A local Stream Deck key that tells you when a coding agent needs you. It uses
Agent Buddy's existing hooks and companion service, not a second hook installer.
It supports GitHub Copilot, Claude Code, Codex, Grok Build, Hermes Agent, and
OpenClaw.

## Build and install

You need Node.js 20.11+ to build the plugin and Stream Deck 6.6+ on macOS or
Windows to run it. Stream Deck supplies the plugin's Node.js runtime. Building
the companion service itself still requires the repository's Node.js 24.11+.

From the repository root:

```bash
npm ci --prefix streamdeck
npm --prefix streamdeck run pack
```

Open the `.streamDeckPlugin` file in `build/streamdeck/` to install it through
Stream Deck. Add **Agent Buddy > Agent status** to a key. Leave **Watch** set to
**All agents** for an overview, or add more keys and choose an agent for each.
This is a source-build integration, not a published Marketplace plugin.

Run an Agent Buddy companion service built from this checkout (see the
[development guide](../docs/development.md)). Older installed releases do not
expose the concurrent roles required by this plugin and show an update message
instead of a misleading idle key. Hook configuration stays in Agent Buddy
Settings and requires your approval as before.

## What the key means

| Display | Meaning |
| --- | --- |
| Needs you, amber `!` | An agent is waiting for input/approval or reported an error. |
| Working, blue activity bars | An agent is working. |
| Complete, green check | The companion service's brief completion state. |
| Idle, gray dot | No current work or attention for the selected agent. |
| Offline, disconnected plug | The service or connection file is unavailable, invalid, or incompatible. |
| Set up, sliders | Select a supported agent in key settings. |

Each agent key keeps the same pixel-art logo and color as Agent Buddy's built-in
badges, with a separate status symbol. The overview uses Agent Buddy's hexagonal
companion mark. Logos remain visible while attention pulses.

Attention wins over work, which wins over completion. An overview key considers
all sessions. Agent-filtered keys aggregate that agent's sessions, so a Claude
key can still show work while a Copilot key needs you. The optional pulse changes
the attention background once per second; turn it off for a steady indicator.

Pressing a key opens the authenticated local Agent Buddy Settings page in your
default browser. It never approves a request, focuses an agent session, or clears
an attention state. Attention clears when the existing hooks report a response
or the companion service's attention lease expires.

## Connection and privacy

The plugin automatically reads the installed service's private `settings.json`:

- macOS: `~/Library/Application Support/ESP32 Agent Companion/settings.json`
- Windows: `%LOCALAPPDATA%\ESP32 Agent Companion\settings.json`

For an isolated development daemon, expand **Custom companion service** and
enter the full path to its settings file, for example
`/absolute/path/to/agent-buddy/build/dev/companion/settings.json` for the Aspire
contributor loop. Polls are shared among visible keys using the same file.
The file is reread on every poll so restarts, port changes, and new tokens recover
automatically. No polling continues when none of the plugin's keys is visible.

Only local HTTP loopback URLs are accepted. API requests carry
`X-Companion-Token` in a header, never a query parameter, and redirects are
refused. Tokens are read from the companion's file, not persisted in key
settings or included in exported Stream Deck profiles. The Settings browser
link uses the existing token fragment. Do not share that link or the companion's
settings file. The plugin sends nothing to a cloud service.

If the key is offline, select it in Stream Deck to read the error and recovery
instructions. Check that the companion is running, the path is correct, and
the companion version supports this plugin.

## Develop

```bash
npm --prefix streamdeck test
npm --prefix streamdeck run validate
```

`src/` contains the typed SDK action, local client, shared poller, and SVG key
renderer. `com.agentbuddy.status.sdPlugin/` contains the manifest, icons, and
offline property inspector. The build bundles the SDK into `bin/plugin.js`;
end users need neither npm nor node_modules. Tests use isolated files and fake
or loopback services, never the user's installed service or hooks.

Build from the full repository checkout: the renderer imports the companion's
built-in artwork from `../daemon/src/agent-badge-art.ts`. Custom badge PNG
overrides in the companion's data folder do not change the plugin's default logos.
