import {agents, type AgentId, type State} from './client.js';
import {defaultIcons} from '../../daemon/src/agent-badge-art.js';

export type KeyState = State | 'offline' | 'setup' | 'connecting';
const colors: Record<KeyState, string> = {
  idle: '#a0a5b4', working: '#2997ff', attention: '#ffb547',
  complete: '#5ee0a0', offline: '#a0a5b4', setup: '#a0a5b4', connecting: '#a0a5b4',
};
const labels: Record<KeyState, string> = {
  idle: 'Idle', working: 'Working', attention: 'Needs you',
  complete: 'Complete', offline: 'Offline', setup: 'Set up', connecting: 'Connecting',
};

function agentGlyph(agent: AgentId): string {
  const paths = defaultIcons[agent].art.flatMap((line, y) => {
    const runs = [...line.matchAll(/#+/g)];
    return runs.map(run => `M${run.index} ${y}h${run[0].length}v1h-${run[0].length}z`);
  }).join('');
  return `<path d="${paths}" transform="translate(25 31) scale(3)" shape-rendering="crispEdges"/>`;
}

const buddyGlyph = `<path d="M72 32 101 49v34l-29 17-29-17V49z" fill="#14254a" stroke="#6eb8ff" stroke-width="3"/>
<rect x="51" y="49" width="42" height="35" rx="12" fill="#0c0f18" stroke="#8f9bff" stroke-width="2"/>
<path d="M62 59v7m20-7v7m-20 9q10 7 20 0" fill="none" stroke="#d7e9ff" stroke-width="4" stroke-linecap="round"/>
<path d="m99 28 3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#8f9bff"/>`;

const symbols: Record<KeyState, string> = {
  idle: '<circle cx="0" cy="0" r="4" fill="currentColor" stroke="none"/>',
  working: '<path d="M-7 4v-6m7 6V-7m7 11v-9" stroke-width="4"/>',
  attention: '<path d="M0-8v9" stroke-width="4"/><circle cy="7" r="2.5" fill="currentColor" stroke="none"/>',
  complete: '<path d="m-8 0 5 5L8-6" stroke-width="4"/>',
  offline: '<path d="m-6-9 3 3m6-3 3 3M-7-4l6 6 5-5-6-6m4 9 5 5m-17 4L10-10" stroke-width="2.5"/>',
  setup: '<path d="M-9-5H9M-9 5H9" stroke-width="2.5"/><circle cx="-3" cy="-5" r="3" fill="#0c0f18" stroke-width="2.5"/><circle cx="4" cy="5" r="3" fill="#0c0f18" stroke-width="2.5"/>',
  connecting: '<circle cx="-7" r="2" fill="currentColor" stroke="none"/><circle r="2" fill="currentColor" stroke="none"/><circle cx="7" r="2" fill="currentColor" stroke="none"/>',
};

export function keySvg(state: KeyState, agent: AgentId | 'all', pulse = false): string {
  const color = colors[state];
  const needsYou = state === 'attention';
  const ink = needsYou ? '#ffcf79' : color;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="14" fill="${needsYou && pulse ? '#302415' : '#0c0f18'}"/>
<rect x="3" y="3" width="138" height="138" rx="11" fill="none" stroke="${needsYou ? color : '#343e53'}" stroke-width="${needsYou ? 4 : 2}"/>
<text x="72" y="23" text-anchor="middle" fill="#f5f5f7" font-family="Arial,sans-serif" font-size="16" font-weight="bold">${agent === 'all' ? 'Agent Buddy' : agents[agent]}</text>
<g fill="${agent === 'all' ? '#8f9bff' : defaultIcons[agent].color}">${agent === 'all' ? `<g transform="translate(-11 0)">${buddyGlyph}</g>` : agentGlyph(agent)}</g>
<g transform="translate(120 85)" color="${needsYou ? '#211607' : color}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
<circle r="18" fill="${needsYou ? color : '#0c0f18'}" stroke="#0c0f18" stroke-width="5"/>
${symbols[state]}</g>
<path d="M17 105h110" stroke="${needsYou ? '#61431e' : '#283044'}"/>
<text x="72" y="128" text-anchor="middle" fill="${ink}" font-family="Arial,sans-serif" font-size="${state === 'connecting' ? 17 : 20}" font-weight="bold">${labels[state]}</text>
</svg>\n`;
}

export function keyImage(state: KeyState, agent: AgentId | 'all', pulse = false): string {
  return `data:image/svg+xml;base64,${Buffer.from(keySvg(state, agent, pulse)).toString('base64')}`;
}
