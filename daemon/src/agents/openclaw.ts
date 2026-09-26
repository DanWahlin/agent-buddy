import {existsSync} from 'node:fs';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {findExecutable, versionOf} from './commands.js';
import {canonicalEvent, normalized} from './normalize.js';
import type {AgentAdapter, AgentContext} from './types.js';

export const openclawAdapter: AgentAdapter = {
  id: 'openclaw',
  name: 'OpenClaw',
  hint: status => status === 'missing'
    ? 'Install the native plugin. Gateway WebSocket approvals aren’t used yet.' : undefined,
  detect(ctx) {
    const configPath = pluginDirectory(ctx);
    const version = versionOf('openclaw', ctx);
    return {installed: Boolean(version), version, configPath};
  },
  hookStatus(ctx) {
    return existsSync(join(pluginDirectory(ctx), 'package.json')) ? 'installed' : 'missing';
  },
  async install(ctx) {
    if (!findExecutable('openclaw', ctx.env))
      throw new Error('the openclaw command wasn\'t found on PATH. Install OpenClaw, then run npm run setup again.');
    const directory = pluginDirectory(ctx);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({
      name: 'agent-companion-openclaw-plugin',
      private: true,
      type: 'module',
      openclaw: {extensions: ['./index.js']},
    }, null, 2)}\n`, {mode: 0o600});
    await writeFile(join(directory, 'openclaw.plugin.json'), `${JSON.stringify({
      id: 'agent-companion',
      name: 'Agent Companion',
      activation: {onStartup: true},
      configSchema: {type: 'object'},
    }, null, 2)}\n`, {mode: 0o600});
    await writeFile(join(directory, 'index.js'), pluginSource(ctx.socketPath), {mode: 0o600});
    const run = ctx.runCommand;
    if (!run) return;
    try {
      await run('openclaw', ['plugins', 'install', '--link', directory, '--force'], {timeoutMs: 10_000});
      await run('openclaw', ['plugins', 'enable', 'agent-companion'], {timeoutMs: 10_000});
      await run('openclaw', ['config', 'set', 'plugins.entries.agent-companion.hooks.allowConversationAccess', 'true'],
                {timeoutMs: 10_000});
    } catch (error) {
      // Without the plugin registered, leftover files would make the hook look installed.
      await rm(directory, {recursive: true, force: true});
      throw error;
    }
  },
  async uninstall(ctx) {
    if (ctx.runCommand && findExecutable('openclaw', ctx.env)) {
      await ctx.runCommand('openclaw', ['plugins', 'uninstall', 'agent-companion', '--force'], {timeoutMs: 10_000})
        .catch(() => ({stdout: '', status: 1}));
    }
    await rm(pluginDirectory(ctx), {recursive: true, force: true});
  },
  normalize(nativeEvent, payload, receiptTime) {
    const trigger = payload.trigger ?? payload.ctxTrigger;
    if (trigger === 'heartbeat' || trigger === 'cron') return [];
    if (nativeEvent === 'agent_end' && payload.success === false)
      return normalized('openclaw', 'errorOccurred', payload, receiptTime);
    return normalized('openclaw', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function pluginDirectory(ctx: Pick<AgentContext, 'dataDir'>): string {
  return join(ctx.dataDir, 'integrations', 'openclaw-plugin');
}

function pluginSource(socketPath: string): string {
  return `import {createConnection} from 'node:net';
import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';

const socketPath = ${JSON.stringify(socketPath)};
const hooks = ['session_start', 'session_end', 'message_received', 'before_tool_call', 'after_tool_call',
  'subagent_spawned', 'subagent_ended', 'agent_end', 'gateway_stop'];

function forward(nativeEvent, event, ctx) {
  if (ctx?.trigger === 'heartbeat' || ctx?.trigger === 'cron') return;
  const payload = {...(event ?? {}), ...(ctx ?? {})};
  const body = JSON.stringify({type: 'hook', agent: 'openclaw', nativeEvent, payload}) + '\\n';
  const socket = createConnection(socketPath);
  const timer = setTimeout(() => socket.destroy(), 250);
  socket.on('connect', () => socket.end(body));
  socket.on('error', () => undefined);
  socket.on('close', () => clearTimeout(timer));
}

export default definePluginEntry({
  register(api) {
    for (const hook of hooks) api.on(hook, async (event, ctx) => {
      try { forward(hook, event, ctx); } catch {}
    });
  },
});
`;
}
