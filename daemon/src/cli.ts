#!/usr/bin/env node
import {agentHookTimeoutMs, runDaemon} from './daemon.js';
import {requestDaemon, streamDaemon} from './client.js';
import {characterStates, hookEvents, type HookEvent, type HookPayload} from './protocol.js';
import {characterRequestValue} from './character-pack.js';
import {isConnectionMode} from './connection-mode.js';
import {pairWifi} from './wifi-config.js';
import {defaultAgentContext, normalizeAgentHook, shouldIgnoreGrokClaudeHook, type AgentId} from './agents/index.js';
import {isAgentId} from './agents/types.js';

async function main(): Promise<void> {
  const [command, argument, file, ...options] = process.argv.slice(2);
  if (command === 'daemon') {
    await runDaemon();
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await requestDaemon({type: 'status'}), null, 2));
    return;
  }
  if (command === 'send' && characterStates.includes(argument as never)) {
    console.log(JSON.stringify(await requestDaemon({type: 'send', state: argument as typeof characterStates[number]})));
    return;
  }
  if (command === 'hook') {
    try {
      const parsed = parseHookArguments(argument, file);
      if (!parsed) return;
      const input = await readStdin(4 * 1024 * 1024);
      const payload = input.trim() ? parseHookPayload(input) : {};
      if (parsed.agent === 'claude' && shouldIgnoreGrokClaudeHook(process.env, payload, defaultAgentContext().home)) return;
      const hooks = normalizeAgentHook(parsed.agent, parsed.nativeEvent, payload);
      for (const hook of hooks) await requestDaemon({type: 'hook', agent: parsed.agent, event: hook.event, payload: hook.payload}, 300);
    } catch {
      // Hooks are notifications only; a missing device or daemon must never block Copilot.
    }
    return;
  }
  if (command === 'agents') {
    if (!argument) {
      console.log(JSON.stringify(await requestDaemon({type: 'agents'}, 2000), null, 2));
      return;
    }
    if ((argument === 'enable' || argument === 'disable') && isAgentId(file)) {
      console.log(JSON.stringify(checked(await requestDaemon(
        {type: 'agentEnable', agent: file, enabled: argument === 'enable'}, 5000)), null, 2));
      return;
    }
    if ((argument === 'install' || argument === 'uninstall') && isAgentId(file)) {
      console.log(JSON.stringify(checked(await requestDaemon({
        type: argument === 'install' ? 'agentInstall' : 'agentUninstall',
        agent: file,
      }, agentHookTimeoutMs + 1000)), null, 2));
      return;
    }
    throw new Error('Usage: agent-companion agents [enable|disable|install|uninstall AGENT]');
  }
  if (command === 'settings') {
    console.log(JSON.stringify(await requestDaemon({type: 'settings'})));
    return;
  }
  if (command === 'badges') {
    if (argument !== 'on' && argument !== 'off') throw new Error('Usage: agent-companion badges on|off');
    const enabled = argument === 'on';
    console.log(JSON.stringify(checked(await requestDaemon({type: 'badges', enabled}, 2000))));
    return;
  }
  if (command === 'list-characters') {
    console.log(JSON.stringify(await requestDaemon({type: 'listCharacters'}, 2000)));
    return;
  }
  if (command === 'connection') {
    if (!argument) {
      const status = await requestDaemon({type: 'status'}) as {mode?: string};
      console.log(status.mode ?? 'auto');
      return;
    }
    if (!isConnectionMode(argument)) throw new Error('Connection mode must be auto, usb, or wifi.');
    const response = await requestDaemon({type: 'setConnection', mode: argument}, 5000) as {
      ok?: boolean; error?: string};
    if (!response.ok) throw new Error(response.error ?? 'Could not change the connection mode.');
    return;
  }
  if (command === 'setup-character' && argument) {
    // npm runs scripts from daemon/, so resolve relative pack paths from the caller's directory.
    const character = characterRequestValue(argument, process.env.INIT_CWD ?? process.cwd());
    let shown = -1;
    const response = await streamDaemon({type: 'installCharacter', character}, message => {
      const progress = (message as {progress?: unknown}).progress;
      if (typeof progress !== 'number' || (progress < shown + 5 && progress !== 100)) return;
      shown = progress;
      process.stderr.write(`\rInstalling character: ${progress}%`);
    }, 10 * 60 * 1000) as {ok?: boolean; name?: string; transport?: string; error?: string};
    if (shown >= 0) process.stderr.write('\n');
    if (!response.ok) throw new Error(response.error ?? 'Character installation failed.');
    console.log(`Installed ${response.name} over ${response.transport === 'wifi' ? 'Wi-Fi' : 'USB'}. `
        + 'The device is restarting.');
    return;
  }
  if (command === 'pair-wifi' && argument) {
    const hostIndex = [file, ...options].indexOf('--host');
    const values = [file, ...options];
    const host = hostIndex >= 0 ? values[hostIndex + 1] : process.env.AGENT_COMPANION_HOST;
    if (hostIndex >= 0 && !host) throw new Error('--host requires an IP address or hostname.');
    const paired = await pairWifi(argument, host);
    try {
      await requestDaemon({type: 'reloadWifi'});
    } catch {
      // Pairing also works before daemon installation; it will load the file at startup.
    }
    console.log(`Paired Wi-Fi device ${paired.deviceId}.`);
    return;
  }
  if (command === 'setup-wifi' && argument) {
    const password = process.env.AGENT_COMPANION_WIFI_PASSWORD ?? await readSecret('Wi-Fi password: ');
    const response = await requestDaemon(
      {type: 'configureWifi', ssid: argument, password}, 10000) as {
        ok?: boolean;
        deviceId?: string;
        error?: string;
      };
    if (!response.ok) throw new Error(response.error ?? 'Wi-Fi setup failed.');
    console.log(`Configured and paired Wi-Fi device ${response.deviceId}.`);
    return;
  }
  throw new Error(
    'Usage: agent-companion {daemon|status|send STATE|hook [AGENT] EVENT|agents [enable|disable|install|uninstall AGENT]|setup-wifi SSID|pair-wifi CODE [--host ADDRESS]|setup-character NAME|PATH|connection [auto|usb|wifi]|badges on|off}');
}

function parseHookArguments(first: string | undefined, second: string | undefined):
    {agent: AgentId; nativeEvent: string | undefined} | null {
  if (!first) return null;
  if (hookEvents.includes(first as never)) return {agent: 'copilot', nativeEvent: first};
  if (isAgentId(first)) return {agent: first, nativeEvent: second};
  return null;
}

async function readStdin(limit = Number.POSITIVE_INFINITY): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (input.length < limit) input += chunk.slice(0, Math.max(0, limit - input.length));
  }
  return input;
}

function parseHookPayload(input: string): HookPayload {
  try {
    return JSON.parse(input) as HookPayload;
  } catch {
    const payload: HookPayload = {};
    for (const key of ['session_id', 'sessionId', 'hook_event_name', 'hookEventName', 'tool_name',
      'toolName', 'tool_use_id', 'toolCallId', 'agent_id', 'agentId', 'agent_type', 'agentName',
      'notification_type', 'notificationType']) {
      const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,512})"`).exec(input);
      if (match?.[1]) payload[key] = match[1];
    }
    return payload;
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return (await readStdin()).replace(/\r?\n$/, '');
  process.stdout.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Wi-Fi setup cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

// The daemon reports failures as {ok: false, error}; surface them as a non-zero exit.
function checked(response: unknown): unknown {
  const result = response as {ok?: unknown; error?: unknown} | null;
  if (!result || typeof result !== 'object' || Object.keys(result).length === 0)
    throw new Error('The daemon closed the connection without a result. Check the daemon log for details.');
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'The daemon reported an error.');
  return response;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
