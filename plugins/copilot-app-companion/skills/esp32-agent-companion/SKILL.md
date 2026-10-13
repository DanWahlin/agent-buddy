---
name: esp32-agent-companion
description: Coordinate visible activity states on an installed ESP32 Agent Companion. Use when the user asks to use, test, connect, or reflect Copilot activity on the companion, and during sessions where companion state reporting is already active.
compatibility: >
  Requires the local ESP32 Agent Companion daemon and a supported device connected
  over USB or Wi-Fi. Uses only the esp32-agent-companion MCP server.
---

# ESP32 Agent Companion

Use the MCP tools from the `esp32-agent-companion` server. Tool names may be
prefixed by the host; select the available tools whose names end in `status`,
`test_connection`, `set_state`, and `narrate`.

## Activity protocol

When this skill is active:

1. Call `set_state` with `working` before substantive tool use.
2. Refresh `working` after a long-running operation or before more work if the
   session may have exceeded the daemon lease.
3. Call `set_state` with `attention` immediately before an explicit user-input,
   approval, or decision gate.
4. Call `set_state` with `complete` only after the requested work is complete and
   verified.
5. Call `set_state` with `idle` when work is cancelled, abandoned, or ends
   without completion.
6. Use `surprise` only for an explicit user request or a genuinely exceptional,
   positive result; it is transient and does not replace the persistent lease.

## Contextual narration

When the daemon reports Voice notifications mode `contextual`, use `narrate`
occasionally before a meaningful, user-visible action where a short line adds
personality or clarity. Prefer specific natural lines such as “Let me send that
message to Paul for you” or “I’ll check the calendar.”

Do not narrate routine file reads, searches, builds, tests, or every tool call.
Never include secrets, tokens, code, commands, URLs, email addresses, file
names, opaque identifiers, or quoted prompt/message contents. Paraphrase the
purpose only. Keep narration to one sentence and under 180 characters. If the
tool reports that contextual mode is disabled, continue silently and do not
retry.

Do not retry state calls repeatedly. If a tool reports that the daemon or device
is unavailable, report the error once and continue the user's primary task
without opening the serial port or running arbitrary recovery commands.

Use `status` for inspection. Use `test_connection` only when the user asks to
test the device or when diagnosing a reported connection problem.
