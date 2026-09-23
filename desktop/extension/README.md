# Agent Companion

Put your agent's own avatar in VS Code — animated, looking around, and reacting
to what the agent is doing.

VS Code's built-in chat pet can't be changed: it's part of the workbench, with no
contribution point and no setting for custom art. This extension is the thing it
doesn't have. It renders **any** character from a portable pack, so the face you
see can be your agent's own.

## Getting started

Install it and open the Agent Companion view from the activity bar. It ships
with one character and starts animating straight away.

To sit it beside Chat, drag the view into the secondary sidebar. VS Code only
lets extensions place views in the activity bar, the panel or the explorer, so
that last step is yours — it's a one-off, and the layout sticks.

## Commands

| Command | What it does |
| --- | --- |
| **Agent Companion: Select Character Pack** | Switch character |
| **Agent Companion: Simulate State** | Drive a state by hand, to see the expressions |
| **Agent Companion: Install Agent Hooks** | Connect it to Claude Code or Copilot CLI |
| **Agent Companion: Remove Agent Hooks** | Take only its own hooks back out |
| **Agent Companion: Show Connection Status** | Which window is leading, and how many sessions |
| **Agent Companion: Reload Packs** | Re-read packs from disk after building one |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `agentCompanion.position` | `sidebar` | `sidebar`, `panel` or `explorer` |
| `agentCompanion.pack` | `marvin` | Which pack to show, by id |
| `agentCompanion.packPaths` | `[]` | Extra folders to find packs in |
| `agentCompanion.crossfade` | `true` | Blend between poses |
| `agentCompanion.maxScale` | `3` | Largest multiple of the pack's own size to draw at |
| `agentCompanion.followCaret` | `true` | Look toward where you are editing |
| `agentCompanion.autoSleep` | `true` | Doze off when left alone, and wake again |

## What it does

He looks toward where you are editing, follows your pointer when you mouse onto
him, reacts to being clicked, and dozes off after a couple of idle minutes. With
hooks installed he shows what your agent is doing: working while tools run,
a celebration when a turn finishes, and asking for attention at a permission
prompt.

## Bringing your own character

A character pack is a folder of WebP strips plus a `pack.json`: thirteen tracks,
eight gaze directions and five expressions, each a run of poses with blink levels
stored as eye-sized patches. A whole character is a few hundred kilobytes.

Build one with the `agent-pack` CLI from a rendered rig, put the folder anywhere,
add its parent to `agentCompanion.packPaths`, and pick it from
**Select Character Pack**. Nothing in this extension is specific to the character
that ships with it.

## Credits

The character rig pipeline and the motion engine come from Dan Wahlin's
[esp32-agent-companion](https://github.com/DanWahlin/esp32-agent-companion),
which puts the same idea on a hardware display. The look-around and blink timing
here are his, tuned on that device.
