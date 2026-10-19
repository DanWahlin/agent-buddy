import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createContext, runInContext} from 'node:vm';

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  type = '';
  value = '';
  name = '';
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  style = {width: ''};
  replacements = 0;
  classList = {
    toggle: (name: string, on: boolean) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (on) classes.add(name);
      else classes.delete(name);
      this.className = [...classes].join(' ');
    },
  };
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  toggleAttribute(name: string, on: boolean) {
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
  }
  get firstElementChild() { return this.children[0]; }
  focus() {}
  append(...items: Element[]) {
    for (const item of items) { item.parent = this; this.children.push(item); }
  }
  replaceChildren(...items: Element[]) {
    this.replacements++;
    this.children = [];
    this.append(...items);
  }
  add(item: Element) { this.append(item); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector === 'input' && child.type ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): Element | null {
    const match = /\[data-(agent|summary-agent)="([^"]+)"\]/.exec(selector);
    const key = match?.[1] === 'summary-agent' ? 'summaryAgent' : 'agent';
    for (const child of this.children) {
      if (match && child.dataset[key] === match[2]) return child;
      if (selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  closest(): Element | null { return this.parent; }
}

class TestOption extends Element {
  constructor(text: string, value: string) {
    super();
    this.textContent = text;
    this.value = value;
  }
}

test('agent selection and save state update existing cards without replacing or redrawing them', () => {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: {getElementById: element, activeElement: null, createElement: () => new Element()},
  });

  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {agentStage: 'select', agents: []};
    controller.status = {agents: [
      {id: 'copilot', name: 'GitHub Copilot', detected: true},
      {id: 'codex', name: 'Codex CLI', detected: true}
    ], badges: {icons: []}};
    controller.agentKey = '';
    controller.draws = 0;
    controller.drawAgentIcon = () => { controller.draws++; };
    controller.renderAgents(false);
  `, context);
  const list = element('ob-agents');
  const originalCards = [...list.children];
  const originalInput = list.querySelector('[data-agent="copilot"]')!;
  runInContext(`
    controller.state.agents = ['copilot'];
    controller.renderAgents(true);
    controller.renderAgents(false);
    controller.status = JSON.parse(JSON.stringify(controller.status));
    controller.renderAgents(false);
  `, context);
  assert.equal(list.replacements, 1);
  assert.equal(list.children[0], originalCards[0]);
  assert.equal(list.children[1], originalCards[1]);
  assert.equal(list.querySelector('[data-agent="copilot"]'), originalInput);
  assert.equal(originalInput.checked, true);
  assert.equal(originalInput.disabled, false);
  assert.match(originalCards[0]!.className, /selected/);
  assert.equal(runInContext('controller.draws', context), 2);
  runInContext(`
    controller.state.agentStage = 'connect';
    controller.guideId = null;
    controller.renderGuide = () => {};
    Object.assign(controller.status.agents[0], {installed: true, hookStatus: 'installed', enabled: true});
    controller.renderAgents(false);
  `, context);
  assert.equal(element('ob-agent-selection').hidden, false);
  assert.equal(element('ob-agent-guide').hidden, true);
  assert.equal(element('ob-agent-result').hidden, false);
  assert.match(element('ob-agent-result').textContent, /agents are connected/);
  assert.equal(originalInput.checked, true);
  assert.equal(list.children[0], originalCards[0]);
  runInContext('controller.renderAgents(true);', context);
  assert.equal(element('ob-agent-result').hidden, true);
  runInContext("controller.guideId = 'copilot'; controller.renderAgents(false);", context);
  assert.equal(element('ob-agent-selection').hidden, false);
  assert.equal(element('ob-agent-guide').hidden, false);
  assert.equal(element('ob-agent-result').hidden, true);
  assert.equal(list.replacements, 1);
  runInContext("controller.state.agentStage = 'select';", context);
  runInContext("controller.state.agents = []; controller.renderAgents(false);", context);
  assert.equal(originalInput.checked, false);
  assert.doesNotMatch(originalCards[0]!.className, /selected/);
  assert.equal(list.replacements, 1);
});

test('navigation opens only visited visible steps and does not reinstall agents or characters', async () => {
  const context = createContext({});
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {step: 'firmware', agentStage: 'connect', agents: ['copilot'],
      character: 'claude', display: 'both', completed: false,
      visitedSteps: ['welcome', 'agents', 'character', 'display', 'firmware']};
    const calls = [];
    controller.api = async (path, options) => {
      const {step} = JSON.parse(options.body);
      calls.push({path, step});
      return {...controller.state, step, ...(step === 'agents' ? {agentStage: 'select'} : {})};
    };
    controller.refresh = async () => {};
    controller.guideId = 'copilot';
  `, context);
  await runInContext("controller.goTo('agents')", context);
  assert.equal(runInContext('controller.state.agentStage', context), 'select');
  assert.equal(runInContext('controller.guideId', context), null);
  assert.equal(runInContext('controller.focusHeading', context), true);
  await runInContext("controller.goTo('firmware')", context);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(calls)', context)), [
    {path: '/api/onboarding/navigate', step: 'agents'}, {path: '/api/onboarding/navigate', step: 'firmware'},
  ]);
  assert.equal(runInContext('controller.state.character', context), 'claude');
  await assert.rejects(runInContext("controller.goTo('complete')", context), /not been reached/);
  runInContext("controller.state.display = 'desktop'", context);
  assert.equal(runInContext("canVisitStep(controller.state, 'firmware')", context), false);
});

function hookController() {
  const context = createContext({});
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {step: 'agents', agents: ['copilot', 'codex', 'claude'], agentStage: 'select'};
    controller.status = {onboarding: controller.state, agents: [
      {id: 'copilot', name: 'GitHub Copilot', installed: true, hookStatus: 'installed'},
      {id: 'codex', name: 'Codex CLI', installed: true, hookStatus: 'needs-approval'},
      {id: 'claude', name: 'Claude Code', installed: true, hookStatus: 'installed'}
    ]};
    const calls = [], prompts = [];
    let confirmResult = true;
    controller.api = async (path, options) => {
      calls.push({path, body: options.body ? JSON.parse(options.body) : null});
      if (path === '/api/onboarding/hooks') {
        controller.status.onboarding = {...controller.state, agentStage: 'connect'};
        return {results: controller.state.agents.map(id => ({id, ok: true}))};
      }
      if (path === '/api/onboarding') {
        controller.status.onboarding = {...controller.status.onboarding, ...JSON.parse(options.body)};
        return controller.status.onboarding;
      }
    };
    controller.refresh = async () => {};
    controller.confirm = async (...args) => { prompts.push(args); return confirmResult; };
  `, context);
  return context;
}

test('current hooks and agent-side approval do not show installation consent', async () => {
  const context = hookController();
  await runInContext('controller.installHooks()', context);
  assert.equal(runInContext('prompts.length', context), 0);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(calls)', context)), [
    {path: '/api/onboarding/rescan', body: null},
    {path: '/api/onboarding/hooks', body: {confirmed: false, agents: ['copilot', 'codex', 'claude'], installAgents: []}},
  ]);
  assert.equal(runInContext('controller.state.agentStage', context), 'connect');
  assert.equal(runInContext('controller.state.step', context), 'agents');
});

test('all connected agents move directly to Character after the hook check without an extra confirmation', async () => {
  const context = hookController();
  runInContext(`
    controller.status.agents.forEach(agent => {
      agent.enabled = true;
      agent.hookStatus = 'installed';
    });
  `, context);
  await runInContext('controller.installHooks()', context);
  assert.equal(runInContext('controller.state.step', context), 'character');
  assert.equal(runInContext('prompts.length', context), 0);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(calls)', context)), [
    {path: '/api/onboarding/rescan', body: null},
    {path: '/api/onboarding/hooks', body: {confirmed: false, agents: ['copilot', 'codex', 'claude'], installAgents: []}},
    {path: '/api/onboarding', body: {step: 'character'}},
  ]);
});

test('waiting for real activity or an installation warning keeps the agent setup visible', async () => {
  for (const problem of ['waiting', 'warning']) {
    const context = hookController();
    runInContext(`
      controller.status.agents.forEach(agent => {
        agent.enabled = true;
        agent.hookStatus = 'installed';
      });
    `, context);
    runInContext(problem === 'waiting'
      ? "controller.status.agents[0].action = {kind: 'restart'}"
      : "controller.status.agents[0].warning = 'Review this hook change.'", context);
    await runInContext('controller.installHooks()', context);
    assert.equal(runInContext('controller.state.step', context), 'agents');
    assert.equal(runInContext('controller.state.agentStage', context), 'connect');
    assert.equal(runInContext('calls.length', context), 2);
  }
});

test('hook consent lists only changed locations and Cancel performs no hook operation', async () => {
  const context = hookController();
  runInContext(`
    controller.status.agents[2].hookStatus = 'outdated';
    controller.status.agents[2].locations = [
      {id: 'host', name: 'Windows', running: true, detected: true, hookStatus: 'installed', configPath: 'current.json'},
      {id: 'wsl:Ubuntu', name: 'WSL: Ubuntu', running: true, detected: true, hookStatus: 'missing', configPath: '/home/test/.claude/settings.json'}
    ];
    confirmResult = false;
  `, context);
  await runInContext('controller.installHooks()', context);
  const prompt = JSON.parse(runInContext('JSON.stringify(prompts[0])', context));
  assert.match(prompt[0], /Update hooks for Claude Code/);
  assert.doesNotMatch(prompt[0], /GitHub Copilot|Codex CLI/);
  assert.equal(prompt[1], 'Update hooks');
  assert.equal(prompt[2], 'Claude Code (WSL: Ubuntu): /home/test/.claude/settings.json');
  assert.equal(runInContext('calls.length', context), 1);
  assert.equal(runInContext('controller.state.agentStage', context), 'select');
  runInContext('confirmResult = true', context);
  await runInContext('controller.installHooks()', context);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(calls.at(-1).body)', context)),
    {confirmed: true, agents: ['copilot', 'codex', 'claude'], installAgents: ['claude']});
});

test('Wi-Fi detection clears an old USB selection and uses the live connection', async () => {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: {getElementById: element},
    Option: class { constructor(readonly text: string, readonly value: string) {} },
  });
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {port: '/dev/old-usb', step: 'display', character: 'copilot', display: 'both'};
    controller.characters = [];
    controller.status = {connected: false, transport: null};
    controller.busy = true;
    let saved;
    controller.api = async () => ({ports: [], connected: null});
    controller.refresh = async () => {
      controller.status = {connected: true, transport: 'wifi', port: 'http://192.0.2.7', character: 'copilot'};
    };
    controller.save = async change => { saved = change; controller.state = {...controller.state, ...change}; };
  `, context);
  await runInContext('controller.detect()', context);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(saved)', context)), {port: null, deviceDeferred: false});
  assert.match(element('ob-detection-message').textContent, /connected over Wi-Fi/);
  assert.match(element('ob-detection-message').className, /ready/);
  assert.match(element('ob-connection-art').className, /wifi/);
  assert.match(element('ob-firmware-connection-art').className, /wifi/);
  assert.match(element('ob-firmware-connection-art').attributes['aria-label']!, /Device connected over Wi-Fi/);
  assert.equal(element('ob-port-label').hidden, true);
  assert.equal(runInContext('isDeviceReady(controller.status, controller.state)', context), true);
  runInContext('controller.status.connected = false; controller.status.wifiPaired = true; controller.renderDeviceDetection(false);', context);
  assert.equal(runInContext('isDeviceReady(controller.status, controller.state)', context), false);
  assert.match(element('ob-detection-message').textContent, /Waiting for your paired Wi-Fi device/);
  assert.doesNotMatch(element('ob-detection-message').className, /ready/);
  assert.doesNotMatch(element('ob-firmware-connection-art').className, /wifi/);
  runInContext(`controller.status = {connected: true, transport: 'usb', port: '/dev/usb'};
    controller.state.port = '/dev/usb'; controller.renderDeviceDetection(false);`, context);
  for (const id of ['ob-connection-art', 'ob-firmware-connection-art']) {
    assert.doesNotMatch(element(id).className, /wifi/);
    assert.match(element(id).attributes['aria-label']!, /Device connected over USB/);
  }
});

test('character setup names the installation and keeps Wi-Fi graphics during restart without firmware controls', () => {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  element('ob-device-bar').append(new Element());
  const context = createContext({document: {getElementById: element}, Option: class extends Element {
    constructor(text: string, value: string) { super(); this.textContent = text; this.value = value; }
  }});
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {character: 'claude', port: null, display: 'both'};
    controller.characters = [{id: 'claude', name: 'Claude'}];
    controller.ports = [];
    controller.status = {connected: true, transport: 'wifi', port: 'http://192.0.2.7', character: 'copilot',
      installing: null, firmware: {usb: {release: '1.0.0', flasher: true}},
      onboarding: {busy: false, deviceSetup: null, phase: null}};
    controller.renderFirmware(false);
  `, context);
  assert.equal(element('ob-install-character').textContent, 'Install Claude character');
  assert.equal(element('ob-install-character').hidden, false);
  assert.match(element('ob-character-install-note').textContent, /existing firmware stays unchanged/);
  assert.equal(element('ob-character-install-note').hidden, false);
  assert.equal(element('ob-firmware-options').hidden, true);
  assert.equal(element('ob-device-progress').hidden, true);
  runInContext(`
    controller.status.connected = false;
    controller.status.transport = null;
    controller.status.character = null;
    controller.status.installing = {name: 'Claude', percent: 67};
    controller.status.onboarding = {busy: true, phase: 'Installing the selected character',
      deviceSetup: {flash: false, transport: 'wifi'}};
    controller.renderFirmware(true);
  `, context);
  assert.equal(element('ob-firmware-state').textContent, 'Installing the Claude character.');
  assert.equal(element('ob-device-phase').textContent, 'Installing Claude character');
  assert.equal(element('ob-device-bar').attributes['aria-valuenow'], '67');
  assert.equal(element('ob-device-progress').hidden, false);
  assert.equal(element('ob-device-actions').hidden, true);
  assert.equal(element('ob-firmware-options').hidden, true);
  assert.equal(element('ob-device-help').hidden, true);
  assert.match(element('ob-character-install-note').textContent, /firmware stays unchanged/);
  assert.equal(element('ob-firmware-lede').textContent, 'Keep your device on and connected to Wi-Fi during setup.');
  assert.doesNotMatch(element('ob-firmware-lede').textContent, /USB/);
  assert.match(element('ob-firmware-connection-art').className, /wifi/);
  runInContext(`
    controller.status.installing = null;
    controller.status.onboarding.phase = 'Waiting for the character to start';
    controller.renderFirmware(true);
  `, context);
  assert.match(element('ob-firmware-state').textContent, /Waiting for the character/);
  assert.match(element('ob-firmware-connection-art').className, /wifi/);
  assert.equal(element('ob-device-bar').attributes['aria-valuenow'], undefined);
  assert.equal(element('ob-firmware-options').hidden, true);
  runInContext(`
    controller.status.connected = true;
    controller.status.transport = 'wifi';
    controller.status.character = 'claude';
    controller.status.onboarding = {busy: false, phase: null, deviceSetup: null};
    controller.renderFirmware(false);
  `, context);
  assert.match(element('ob-firmware-state').textContent, /selected character are ready/);
  assert.equal(element('ob-install-character').hidden, true);
  assert.equal(element('ob-device-progress').hidden, true);
  assert.equal(element('ob-character-install-note').hidden, true);
  assert.equal(element('ob-device-actions').hidden, false);

  runInContext(`
    controller.status.transport = 'usb';
    controller.status.port = controller.state.port = '/dev/test';
    controller.status.character = 'copilot';
    controller.renderFirmware(false);
  `, context);
  assert.equal(element('ob-firmware-options').hidden, false);
  assert.equal(element('ob-firmware-options').open, false);
  assert.equal(element('ob-firmware-options-title').textContent, 'Replace firmware (optional)');
  element('ob-firmware-options').open = true;
  runInContext('controller.renderFirmware(false)', context);
  assert.equal(element('ob-firmware-options').open, true);
  runInContext('controller.status.connected = false; controller.renderFirmware(false);', context);
  assert.equal(element('ob-firmware-options').open, true);
  assert.equal(element('ob-firmware-options-title').textContent, 'Install firmware');
  assert.match(element('ob-firmware-plan').textContent, /firmware v1.0.0, then the Claude character/);
  // A connected device of another board keeps its firmware.
  runInContext(`
    controller.status.connected = true;
    controller.status.firmware = {...controller.status.firmware, board: 'waveshare-lcd-154'};
    controller.status.firmware.usb = {...controller.status.firmware.usb, releaseBoard: 'waveshare-amoled-175'};
    controller.renderFirmware(false);
  `, context);
  assert.equal(element('ob-firmware-options-title').textContent, 'Replace firmware (optional)');
  assert.match(element('ob-firmware-plan').textContent, /waveshare-lcd-154 board.*BOARD=waveshare-lcd-154/);
  assert.equal(element('ob-install-firmware').disabled, true);
});

test('firmware replacement confirms the board and both stages, while character installation does not flash', async () => {
  const context = createContext({});
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {port: '/dev/test', character: 'claude', display: 'both'};
    controller.characters = [{id: 'claude', name: 'Claude'}];
    controller.status = {firmware: {usb: {release: '1.0.0'}}};
    const calls = [], prompts = [];
    let approved = false;
    controller.api = async (path, options) => { calls.push({path, body: JSON.parse(options.body)}); };
    controller.confirm = async (...args) => { prompts.push(args); return approved; };
    controller.refresh = async () => {};
  `, context);
  await runInContext('controller.setupDevice(true)', context);
  assert.equal(runInContext('calls.length', context), 0);
  const prompt = JSON.parse(runInContext('JSON.stringify(prompts[0])', context));
  assert.match(prompt[0], /Waveshare ESP32-S3-Touch-AMOLED-1.75-B or -C/);
  assert.match(prompt[0], /firmware v1.0.0, then the Claude character/);
  assert.equal(prompt[1], 'Confirm and install');
  assert.equal(prompt[3].title, 'Install firmware and character?');
  runInContext('approved = true', context);
  await runInContext('controller.setupDevice(true)', context);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(calls[0].body)', context)),
    {flash: true, confirmed: true, port: '/dev/test', character: 'claude', display: 'both'});
  await runInContext('controller.setupDevice(false)', context);
  assert.equal(runInContext('prompts.length', context), 2);
  assert.equal(runInContext('calls[1].body.flash', context), false);
});

function summaryController() {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: {getElementById: element, createElement: () => new Element()}, Option: TestOption,
  });

  element('ob-ready-device-animation').hidden = true;
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {step: 'complete', completed: false, agents: ['copilot', 'codex'],
      character: 'dog', display: 'both', port: null, agentsDeferred: false, deferredAgents: [], deviceDeferred: false};
    controller.characters = [{id: 'dog', name: 'Biscuit', thumbnail: true}];
    controller.status = {connected: true, transport: 'wifi', port: 'http://192.0.2.7', character: 'dog',
      desktop: {app: {state: 'running'}}, agents: [
        {id: 'copilot', name: 'GitHub Copilot', enabled: true, installed: true, hookStatus: 'installed'},
        {id: 'codex', name: 'Codex CLI', enabled: true, installed: true, hookStatus: 'needs-approval'},
        {id: 'claude', name: 'Claude Code', enabled: true, installed: true, hookStatus: 'installed'}
      ], badges: {icons: []}};
    controller.summaryAgentKey = '';
    controller.failedSummaryPreviews = new Set();
    controller.thumbnail = id => '/preview/' + encodeURIComponent(id) + '.png';
    controller.draws = 0;
    controller.drawAgentIcon = (_canvas, _icon, size) => {
      if (size !== 40) throw new Error('Summary icons must use the compact size.');
      controller.draws++;
    };
    controller.renderSummary();
  `, context);
  return {context, element};
}

test('character cards remain stable while saving, and missing characters have a recovery message', () => {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: {getElementById: element, activeElement: null, createElement: () => new Element()},
  });
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {character: 'copilot'};
    controller.characters = [
      {id: 'copilot', name: 'Copilot', bytes: 100, thumbnail: true},
      {id: 'claude', name: 'Claude', bytes: 200, thumbnail: true}
    ];
    controller.characterKey = '';
    controller.thumbnail = id => '/preview/' + id;
    controller.renderCharacters(false);
  `, context);
  const list = element('ob-characters');
  const cards = [...list.children];
  runInContext(`
    controller.state.character = 'claude';
    controller.renderCharacters(true);
    controller.characters = JSON.parse(JSON.stringify(controller.characters));
    controller.renderCharacters(false);
  `, context);
  assert.equal(list.replacements, 1);
  assert.deepEqual(list.children, cards);
  assert.equal(cards[1]!.children[0]!.checked, true);
  assert.equal(cards[1]!.children[0]!.disabled, false);
  assert.match(cards[1]!.className, /selected/);
  runInContext("controller.characters = controller.characters.filter(entry => entry.id !== 'claude'); controller.renderCharacters(false);", context);
  assert.equal(element('ob-character-result').hidden, false);
  assert.match(element('ob-character-result').textContent, /unavailable.*Choose another/);
  assert.equal(runInContext('controller.state.character', context), 'claude');
  runInContext("controller.characters = []; controller.renderCharacters(false);", context);
  assert.match(element('ob-character-result').textContent, /Refresh characters/);
});

test('selection handlers capture changed values before the busy render restores saved form values', async () => {
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  const start = source.indexOf("this.root.addEventListener('change', event =>");
  const end = source.indexOf("    $('ob-next').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  for (const [name, id, value, saved] of [
    ['onboarding-character', '', 'claude', {character: 'claude'}],
    ['companion-display', '', 'both', {display: 'both', deviceDeferred: false}],
    ['', 'ob-port', '/dev/new-port', {port: '/dev/new-port'}],
  ] as const) {
    const input = {name, id, value: String(value), checked: true, dataset: {}};
    let listener!: (event: {target: typeof input}) => void;
    let pending: Promise<void> | undefined;
    let change: unknown;
    const controller = {
      root: {addEventListener: (_type: string, callback: typeof listener) => { listener = callback; }},
      run: (work: () => Promise<void>) => { input.value = ''; pending = work(); return pending; },
      save: async (next: unknown) => { change = next; },
    };
    const context = createContext({controller});
    runInContext(`(function () { ${source.slice(start, end)} }).call(controller);`, context);
    listener({target: input});
    await pending;
    assert.deepEqual(JSON.parse(JSON.stringify(change)), saved);
  }
});

test('Ready shows the selected character and compact selected agents without replacing them on status updates', () => {
  const {context, element} = summaryController();
  assert.match(element('ob-ready-connection-art').attributes['aria-label']!, /Preview of Biscuit/);
  assert.equal(element('ob-ready-desktop-character').attributes.href, '/preview/dog.png');
  assert.equal(element('ob-ready-device-character').attributes.src, '/preview/dog.png');
  assert.equal(element('ob-ready-preview-fallback').hidden, true);
  assert.equal(element('ob-ready-display-title').textContent, 'Desktop and device');
  assert.equal(element('ob-ready-device-state').textContent, 'Wi-Fi connected');
  const list = element('ob-ready-agents');
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0]!.dataset.summaryAgent, 'copilot');
  assert.equal(list.children[1]!.dataset.summaryAgent, 'codex');
  assert.equal(list.querySelector('[data-summary-agent="claude"]'), null);
  assert.equal(list.children[0]!.querySelector('.ready-agent-state')!.textContent, 'Connected');
  assert.equal(list.children[1]!.querySelector('.ready-agent-state')!.textContent, 'Approval needed');
  assert.match(list.children[0]!.className, /connected/);
  assert.doesNotMatch(list.children[1]!.className, /connected/);
  assert.equal(element('ob-ready-agents-state').textContent, '1 connected; 1 still to set up');
  const cards = [...list.children];
  runInContext(`
    controller.status.agents[1].hookStatus = 'installed';
    controller.renderSummary();
    controller.status = JSON.parse(JSON.stringify(controller.status));
    controller.renderSummary();
  `, context);
  assert.equal(element('ob-ready-agents-state').textContent, '2 connected');
  assert.deepEqual(list.children, cards);
  assert.equal(list.replacements, 1);
  assert.equal(runInContext('controller.draws', context), 2);
  assert.equal(list.children[1]!.querySelector('.ready-agent-state')!.textContent, 'Connected');
});

test('Ready display previews distinguish desktop, USB, Wi-Fi, deferred, and disconnected devices', () => {
  const {context, element} = summaryController();
  const art = element('ob-ready-connection-art');
  assert.match(art.className, /wifi/);
  assert.match(art.attributes['aria-label']!, /connected over Wi-Fi/);
  runInContext("controller.status.transport = 'usb'; controller.state.port = controller.status.port = '/dev/test'; controller.renderSummary();", context);
  assert.doesNotMatch(art.className, /wifi/);
  assert.equal(element('ob-ready-device-state').textContent, 'USB connected');
  assert.match(art.attributes['aria-label']!, /connected over USB/);
  runInContext("controller.state.display = 'device'; controller.renderSummary();", context);
  assert.equal(element('ob-ready-desktop-preview').getAttribute('hidden'), '');
  assert.equal(element('ob-ready-desktop-character').getAttribute('href'), null);
  assert.equal(element('ob-ready-display-title').textContent, 'Device only');
  assert.equal(element('ob-ready-desktop-state').textContent, 'Your computer');
  runInContext("controller.state.display = 'desktop'; controller.renderSummary();", context);
  assert.match(art.className, /desktop-only/);
  assert.equal(element('ob-ready-device-state').hidden, true);
  assert.equal(element('ob-ready-device-character').getAttribute('src'), null);
  assert.equal(element('ob-ready-desktop-preview').getAttribute('hidden'), null);
  assert.equal(art.attributes.viewBox, '20 10 280 155');
  runInContext("controller.state.display = 'both'; controller.state.deviceDeferred = true; controller.renderSummary();", context);
  assert.equal(element('ob-ready-display-title').textContent, 'Desktop now; device setup later');
  assert.equal(element('ob-ready-device-state').hidden, true);
  assert.match(element('ob-pending-summary').textContent, /Device setup is saved for later/);
  runInContext("controller.state.deviceDeferred = false; controller.status.connected = false; controller.renderSummary();", context);
  assert.match(art.className, /disconnected/);
  assert.equal(element('ob-ready-device-state').textContent, 'Device not connected');
  assert.doesNotMatch(art.attributes['aria-label']!, /connected over/);
  assert.match(element('ob-pending-summary').textContent, /Reconnect your device/);
  runInContext("controller.status.connected = true; controller.status.port = '/dev/other'; controller.renderSummary();", context);
  assert.equal(element('ob-ready-device-state').textContent, 'Device not connected');
  runInContext("controller.state.port = null; controller.status.character = 'copilot'; controller.renderSummary();", context);
  assert.equal(element('ob-ready-device-state').textContent, 'Character setup needed');
  assert.equal(element('ob-ready-device-character').getAttribute('src'), '/preview/dog.png');
  assert.match(element('ob-pending-summary').textContent, /Return to Device/);
});

test('Ready keeps pending agents visible and never marks stale offline status as connected', () => {
  const {context, element} = summaryController();
  runInContext("controller.state.deferredAgents = ['codex']; controller.renderSummary();", context);
  const list = element('ob-ready-agents');
  assert.equal(list.children[1]!.querySelector('.ready-agent-state')!.textContent, 'Setup later');
  runInContext("controller.status.agents = controller.status.agents.filter(agent => agent.id !== 'codex'); controller.renderSummary();", context);
  assert.equal(list.children.length, 2);
  assert.equal(element('ob-ready-agents-state').textContent, '1 connected; 1 still to set up');
  runInContext("controller.offline = true; controller.renderSummary();", context);
  assert.equal(element('ob-ready-agents-state').textContent, 'Service offline');
  assert.equal(element('ob-ready-device-state').textContent, 'Service offline');
  assert.ok(list.children.every(card => !card.className.split(' ').includes('connected')));
  assert.match(element('ob-ready-connection-art').className, /disconnected/);
  runInContext("controller.offline = false; controller.state.agents = []; controller.renderSummary();", context);
  assert.equal(list.children.length, 0);
  assert.equal(element('ob-ready-agents-empty').hidden, false);
  assert.equal(element('ob-ready-agents-state').textContent, 'No agents selected');
});

test('Ready uses an explicit preview fallback instead of showing another character', () => {
  const {context, element} = summaryController();
  runInContext("controller.characters[0].thumbnail = false; controller.renderSummary();", context);
  assert.match(element('ob-ready-connection-art').attributes['aria-label']!, /Preview of Biscuit/);
  assert.equal(element('ob-ready-preview-fallback').hidden, false);
  assert.equal(element('ob-ready-desktop-character').getAttribute('href'), null);
  assert.equal(element('ob-ready-device-character').getAttribute('hidden'), '');
  runInContext("controller.characters[0].thumbnail = true; controller.failedSummaryPreviews.add('/preview/dog.png'); controller.renderSummary();", context);
  assert.equal(element('ob-ready-preview-fallback').hidden, false);
  assert.equal(element('ob-ready-device-character').getAttribute('src'), null);
});

test('Ready keeps the selected character inside the display graphic rather than a separate avatar', () => {
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const start = source.indexOf('data-screen="complete"');
  const end = source.indexOf('</section>\n\n    <p id="ob-error"', start);
  assert.ok(start >= 0 && end > start);
  const ready = source.slice(start, end);
  assert.doesNotMatch(ready, /id="ob-ready-character"|class="ready-character"|Your character/);
  assert.match(ready, /id="ob-ready-desktop-character"/);
  assert.match(ready, /id="ob-ready-device-character"/);
  assert.match(ready, /id="ob-ready-device-shell"[^>]+src="\/device-shell.webp"/);
  assert.match(ready, /id="ob-ready-device-animation"/);
  assert.match(ready, /class="ready-desktop-shell"[^>]+href="\/device-shell.webp"/);
  assert.doesNotMatch(source, /class="device-face"|class="device-case"|class="device-glass"/);
});

test('all wizard scenes use the selected character and hide the physical device for desktop-only previews', () => {
  const {context, element} = summaryController();
  for (const display of ['desktop', 'device', 'both']) {
    runInContext(`controller.state.display = '${display}';
      for (const scene of connectionScenes) controller.renderConnectionScene(scene);`, context);
    for (const [prefix, art] of [
      ['ob-display', 'ob-connection-art'], ['ob-firmware', 'ob-firmware-connection-art'], ['ob-ready', 'ob-ready-connection-art'],
    ] as const) {
      assert.equal(element(`${prefix}-desktop-preview`).getAttribute('hidden'), display === 'device' ? '' : null);
      assert.equal(element(`${prefix}-device-preview`).getAttribute('hidden'), display === 'desktop' ? '' : null);
      assert.equal(element(`${prefix}-desktop-character`).getAttribute('href'), display === 'device' ? null : '/preview/dog.png');
      assert.equal(element(`${prefix}-device-character`).getAttribute('src'), display === 'desktop' ? null : '/preview/dog.png');
      assert.equal(element(art).attributes.viewBox, display === 'desktop' ? '20 10 280 155' : '0 0 620 170');
      assert.match(element(art).attributes['aria-label']!, /Preview of Biscuit/);
      if (display === 'desktop') {
        assert.match(element(`${prefix}-scene`).className, /desktop-only/);
        assert.doesNotMatch(element(art).attributes['aria-label']!, /Device connected/);
      } else {
        assert.match(element(art).className, /wifi/);
      }
    }
  }
  runInContext(`controller.characters[0].id = controller.state.character = 'custom';
    for (const scene of connectionScenes) controller.renderConnectionScene(scene);`, context);
  for (const prefix of ['ob-display', 'ob-firmware', 'ob-ready'])
    assert.equal(element(`${prefix}-device-character`).attributes.src, '/preview/custom.png');
});

test('Display shows its preview without physical-device controls and shares the same artwork for each choice', () => {
  const {context, element} = summaryController();
  runInContext(`
    controller.root = {querySelectorAll: () => []};
    controller.ports = [];
    controller.state.step = 'display';
    controller.state.display = 'desktop';
    controller.renderDisplay(false);
  `, context);
  assert.equal(element('ob-device-detection').hidden, true);
  assert.equal(element('ob-detection-message').hidden, true);
  assert.equal(element('ob-display-desktop-character').getAttribute('href'), '/preview/dog.png');
  assert.equal(element('ob-display-desktop-preview').getAttribute('hidden'), null);
  assert.equal(element('ob-display-device-preview').getAttribute('hidden'), '');
  assert.equal(element('ob-choice-desktop-desktop-character').getAttribute('href'), '/preview/dog.png');
  assert.equal(element('ob-choice-desktop-device-preview').getAttribute('hidden'), '');
  assert.match(element('ob-choice-device-scene').className, /device-symbol/);
  assert.equal(element('ob-choice-device-device-character').getAttribute('src'), '/preview/dog.png');
  assert.equal(element('ob-choice-device-desktop-preview').getAttribute('hidden'), '');
  assert.equal(element('ob-choice-both-desktop-character').getAttribute('href'), '/preview/dog.png');
  assert.equal(element('ob-choice-both-device-character').getAttribute('src'), '/preview/dog.png');
  runInContext("controller.state.display = 'both'; controller.renderDisplay(false);", context);
  assert.equal(element('ob-device-detection').hidden, false);
  assert.equal(element('ob-detection-message').hidden, false);
});

test('the shared device scene keeps an installation transport through reconnect without claiming connection', () => {
  const {context, element} = summaryController();
  runInContext(`
    controller.status.connected = false;
    controller.status.wifiPaired = true;
    controller.status.mode = 'wifi';
    controller.status.onboarding = {deviceSetup: {transport: 'wifi', flash: false}};
    controller.renderConnectionScene(connectionScenes[1]);
    controller.renderConnectionScene(connectionScenes[2]);
  `, context);
  assert.match(element('ob-firmware-connection-art').className, /wifi/);
  assert.doesNotMatch(element('ob-firmware-connection-art').className, /disconnected/);
  assert.match(element('ob-firmware-connection-art').attributes['aria-label']!, /setup over Wi-Fi; waiting/);
  assert.doesNotMatch(element('ob-firmware-connection-art').attributes['aria-label']!, /Device connected/);
  assert.match(element('ob-ready-connection-art').className, /disconnected/);
  runInContext("controller.offline = true; controller.renderConnectionScene(connectionScenes[1]);", context);
  assert.match(element('ob-firmware-connection-art').className, /disconnected/);
});

test('Exit setup shows only when setup runs again, and leaves through the API', async () => {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: {getElementById: element, activeElement: null, createElement: () => new Element()},
  });
  const source = readFileSync(new URL('../../web/onboarding.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''), context);
  runInContext(`
    const controller = Object.create(Onboarding.prototype);
    controller.state = {step: 'welcome', agents: [], rerun: false};
    controller.status = {agents: [], connected: false};
    controller.characters = [];
    const calls = [];
    controller.api = async path => { calls.push(path); return {}; };
    controller.refresh = async () => { calls.push('refresh'); };
    controller.renderFooter(false);
  `, context);
  assert.equal(element('ob-exit').hidden, true);
  runInContext("controller.state.rerun = true; controller.renderFooter(false)", context);
  assert.equal(element('ob-exit').hidden, false);
  assert.equal(element('ob-exit').disabled, false);
  runInContext("controller.renderFooter(true)", context);
  assert.equal(element('ob-exit').disabled, true);
  await runInContext('controller.exit()', context);
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(calls)', context)), ['/api/onboarding/exit', 'refresh']);
});
