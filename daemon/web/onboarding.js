import {CharacterPreview} from './character-preview.js';

const $ = id => document.getElementById(id);
const steps = ['welcome', 'agents', 'character', 'display', 'firmware', 'complete'];
const displayNames = {desktop: 'Desktop only', device: 'Device only', both: 'Desktop and device'};
const connectionScenes = [
  {prefix: 'ob-display', art: 'ob-connection-art', step: 'display'},
  {prefix: 'ob-firmware', art: 'ob-firmware-connection-art', step: 'firmware'},
  {prefix: 'ob-ready', art: 'ob-ready-connection-art', step: 'complete'},
];
const choiceScenes = ['desktop', 'device', 'both'].map(display =>
  ({prefix: `ob-choice-${display}`, art: `ob-choice-${display}-connection-art`, display}));

export function canVisitStep(state, step) {
  return Boolean(state && !state.completed && state.visitedSteps?.includes(step)
    && (step !== 'firmware' || (state.display !== 'desktop' && !state.deviceDeferred)));
}

export function isHookCurrent(status) {
  return status === 'installed' || status === 'needs-approval';
}

export function isAgentReady(agent) {
  return Boolean(agent?.enabled && agent.installed && agent.hookStatus === 'installed' && !agent.action);
}

export function isDeviceConnected(status, state) {
  return Boolean(status?.connected && (status.transport === 'wifi' || !state.port || status.port === state.port));
}

// The board a device that answers on the selected USB port reports, when releases have firmware for it.
export function reportedBoard(status, state) {
  const board = isDeviceConnected(status, state) && status.transport === 'usb' ? status.firmware?.board : null;
  return status?.firmware?.usb?.boards?.some(entry => entry.id === board) ? board : null;
}

export function isDeviceReady(status, state) {
  return isDeviceConnected(status, state) && status.character === state.character;
}

export class Onboarding {
  constructor({api, confirm, drawAgentIcon, thumbnail, loadPreview, refresh, reloadCharacters, notify}) {
    this.api = api;
    this.confirm = confirm;
    this.drawAgentIcon = drawAgentIcon;
    this.thumbnail = thumbnail;
    this.refresh = refresh;
    this.reloadCharacters = reloadCharacters;
    this.notify = notify;
    this.root = $('onboarding');
    const source = $('ob-ready-scene');
    for (const scene of [...connectionScenes.slice(0, 2), ...choiceScenes]) {
      const copy = source.cloneNode(true);
      for (const node of copy.querySelectorAll('[id], [fill], [clip-path]')) {
        for (const attribute of ['id', 'fill', 'clip-path']) {
          const value = node.getAttribute(attribute);
          if (value) node.setAttribute(attribute, value.replaceAll('ob-ready-', `${scene.prefix}-`));
        }
      }
      copy.querySelector('.connection-art').id = scene.art;
      $(`${scene.prefix}-scene`).replaceChildren(...copy.children);
    }
    this.state = null;
    this.status = null;
    this.characters = [];
    this.busy = false;
    this.offline = false;
    this.guideId = null;
    this.ports = [];
    this.portKey = '';
    // The board chosen for a device that does not answer, so it cannot report it.
    this.board = null;
    this.boardKey = '';
    this.hookErrors = new Map();
    this.error = '';
    this.agentKey = '';
    this.characterKey = '';
    this.guideKey = '';
    this.summaryAgentKey = '';
    this.failedSummaryPreviews = new Set();
    this.focusHeading = false;
    this.welcomeVideo = $('ob-welcome-animation');
    this.welcomeMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.welcomeBlocked = false;
    this.welcomeStarting = false;
    this.preview = new CharacterPreview($('ob-ready-device-animation'), {
      loadPack: loadPreview, notify,
      changed: () => {
        const scene = connectionScenes.find(entry => entry.step === this.state?.step);
        if (scene) this.renderConnectionScene(scene);
      },
    });
    this.welcomeVideo.muted = true;
    this.welcomeVideo.addEventListener('playing', () => {
      if (!this.welcomeMotion.matches && !document.hidden && this.state?.step === 'welcome' && !this.state.completed)
        this.welcomeVideo.classList.add('playing');
    });
    this.welcomeVideo.addEventListener('error', () => {
      this.welcomeBlocked = true;
      this.welcomeVideo.classList.remove('playing');
      this.notify('The welcome animation is unavailable. The still image remains visible.', 'error');
    });
    this.welcomeMotion.addEventListener('change', () => this.syncWelcomeAnimation());
    document.addEventListener('visibilitychange', () => this.syncWelcomeAnimation());
    $('ob-welcome-play').addEventListener('click', () => {
      this.welcomeBlocked = false;
      this.syncWelcomeAnimation();
    });
    for (const scene of [...connectionScenes, ...choiceScenes]) {
      $(`${scene.prefix}-device-shell`).addEventListener('error', () => {
        if (this.shellPreviewErrorShown) return;
        this.shellPreviewErrorShown = true;
        this.notify('The device shell preview could not be loaded. Your setup is unchanged.', 'error');
      });
      for (const [suffix, attribute] of [['desktop-character', 'href'], ['device-character', 'src']]) {
        const image = $(`${scene.prefix}-${suffix}`);
        image.addEventListener('error', () => {
          const source = image.getAttribute(attribute);
          if (!source || this.failedSummaryPreviews.has(source)) return;
          this.failedSummaryPreviews.add(source);
          if (this.state && !this.state.completed) this.render();
          this.notify('The still character preview could not be loaded. Your character choice is unchanged.', 'error');
        });
      }
    }
    this.root.addEventListener('click', event => {
      const button = event.target.closest('button[data-action], button[data-copy]');
      if (!button) return;
      void this.run(async () => {
        if (button.dataset.copy) {
          if (!navigator.clipboard) throw new Error('Clipboard access is unavailable. Select and copy the displayed text.');
          await navigator.clipboard.writeText(button.dataset.copy);
          this.notify('Copied.', 'success');
        } else if (button.dataset.action === 'navigate-step') {
          await this.goTo(button.dataset.targetStep);
        } else if (button.dataset.action === 'rescan-agents') {
          await this.api('/api/onboarding/rescan', {method: 'POST'});
          await this.refresh();
          this.notify('Agent detection refreshed.');
        } else if (button.dataset.action === 'refresh-characters') {
          await this.reloadCharacters();
        } else if (button.dataset.action === 'detect-device') {
          await this.detect();
        } else if (button.dataset.action === 'retry-hooks') {
          await this.installHooks();
        } else if (button.dataset.action === 'install-character') {
          await this.setupDevice(false);
        } else if (button.dataset.action === 'install-firmware') {
          await this.setupDevice(true);
        }
      });
    });
    this.root.addEventListener('change', event => {
      const input = event.target;
      const checked = input.checked;
      const value = input.value;
      void this.run(async () => {
        if (input.dataset.agent) {
          await this.selectAgent(input.dataset.agent, checked);
        } else if (input.name === 'onboarding-character') {
          await this.save({character: value});
        } else if (input.name === 'companion-display') {
          await this.save({display: value, deviceDeferred: false});
        } else if (input.id === 'ob-port') {
          this.board = null;
          await this.save({port: value || null});
        } else if (input.id === 'ob-board') {
          this.board = value || null;
        }
      });
    });
    $('ob-next').addEventListener('click', () => void this.run(() => this.next()));
    $('ob-back').addEventListener('click', () => void this.run(() => this.back()));
    $('ob-skip').addEventListener('click', () => void this.run(() => this.skip()));
    $('ob-exit').addEventListener('click', () => void this.run(() => this.exit()));
  }

  update(status, characters) {
    if (this.status && this.status.charactersRevision !== status.charactersRevision) {
      this.preview.update(null, false);
      this.failedSummaryPreviews.clear();
      this.characterKey = '';
    }
    this.offline = false;
    this.status = status;
    this.characters = characters;
    if (!this.busy || !this.state) this.state = status.onboarding;
    this.syncWelcomeAnimation();
    if (this.state && !this.state.completed) this.render();
  }

  isBusy() {
    return Boolean(this.busy || this.offline || this.status?.onboarding?.busy || this.status?.installing
      || this.status?.firmware?.updating || this.status?.firmware?.usb?.installing);
  }

  async run(work) {
    if (this.isBusy()) return;
    const previousStep = this.state?.step;
    const previousStage = this.state?.agentStage;
    const focused = document.activeElement;
    const focus = focused?.dataset.agent ? {agent: focused.dataset.agent}
      : focused?.name === 'onboarding-character' ? {character: focused.value}
      : focused?.dataset.copy ? {copy: focused.dataset.copy}
      : focused?.id ? {id: focused.id} : null;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      await work();
    } catch (error) {
      this.error = error.message;
    } finally {
      this.busy = false;
      if (this.status?.onboarding) this.state = this.status.onboarding;
      this.render();
      if (focus && previousStep === this.state?.step && (previousStage === this.state?.agentStage || focus.agent)) {
        const target = focus.agent ? this.root.querySelector(`[data-agent="${focus.agent}"]`)
          : focus.character ? [...this.root.querySelectorAll('[name="onboarding-character"]')]
            .find(input => input.value === focus.character)
          : focus.copy ? [...this.root.querySelectorAll('[data-copy]')].find(button => button.dataset.copy === focus.copy)
          : $(focus.id);
        if (target && !target.disabled) target.focus();
      }
    }
  }

  setOffline() {
    this.offline = true;
    this.render();
  }

  async save(change) {
    const previous = this.state.step;
    if (change.step === undefined) {
      this.state = {...this.state, ...change};
      this.render();
    }
    const saved = await this.api('/api/onboarding', {method: 'POST', type: 'application/json', body: JSON.stringify(change)});
    this.state = {...this.state, ...saved};
    this.focusHeading ||= previous !== this.state.step;
    await this.refresh();
  }

  async selectAgent(id, checked) {
    const agent = this.status.agents.find(entry => entry.id === id);
    if (!checked && agent?.installed) {
      const approvedAgents = [...this.state.agents];
      const windows = /Win/i.test(navigator.platform) || agent.locations?.some(location => location.id.startsWith('wsl:'));
      const locations = agent.locations?.filter(location =>
        !['missing', 'unsupported'].includes(location.hookStatus))
        .map(location => `${location.name}: ${location.configPath ?? 'agent configuration'}`).join('\n');
      const message = `Agent Buddy will remove its hooks and stop receiving activity from ${agent.name}. `
        + `${agent.name} will remain installed.`
        + (windows ? '\n\nWindows and WSL hooks are included. Stopped WSL distributions may start for removal.' : '');
      if (!await this.confirm(message, 'Remove hooks', locations || agent.configPath, {
        title: `Disconnect ${agent.name}?`, context: 'Agent connection', danger: true,
        note: `Restart open ${agent.name} sessions after removal to apply this change.`,
        icon: this.status.badges?.icons?.find(icon => icon.id === id),
      })) return;
      const result = await this.api('/api/onboarding/remove-agent', {
        method: 'POST', type: 'application/json',
        body: JSON.stringify({agent: id, confirmed: true, agents: approvedAgents}),
      });
      this.state = {...this.state, ...result.state};
      this.guideId = null;
      await this.refresh();
      if (result.warning) {
        this.error = result.warning;
        this.notify(result.warning, 'error');
      }
      return;
    }
    const agents = new Set(this.state.agents);
    if (checked) agents.add(id);
    else agents.delete(id);
    this.guideId = null;
    await this.save({agents: [...agents], agentStage: 'select', agentsDeferred: false, deferredAgents: []});
  }

  async next() {
    const step = this.state.step;
    if (step === 'welcome') return this.save({step: 'agents'});
    if (step === 'agents') {
      if (this.state.agentStage === 'select') return this.installHooks();
      if (this.guideId) {
        const agent = this.status.agents.find(entry => entry.id === this.guideId);
        if (!isAgentReady(agent)) throw new Error('Wait for this agent to connect, or choose Set up later.');
      }
      this.guideId = this.pendingAgents().find(agent => agent.id !== this.guideId)?.id ?? null;
      if (this.guideId) {
        this.guideKey = '';
        this.focusHeading = true;
        return;
      }
      return this.save({step: 'character'});
    }
    if (step === 'character') return this.save({step: 'display'});
    if (step === 'display') {
      await this.api('/api/onboarding/display', {method: 'POST'});
      return this.save({step: this.state.display === 'desktop' || this.state.deviceDeferred ? 'complete' : 'firmware'});
    }
    if (step === 'firmware') return this.save({step: 'complete'});
    await this.api('/api/onboarding/finish', {method: 'POST'});
    await this.refresh();
    await this.reloadCharacters();
  }

  // Setup that runs again after it was finished can be left: the choices already applied stay.
  async exit() {
    await this.api('/api/onboarding/exit', {method: 'POST'});
    await this.refresh();
  }

  async goTo(step) {
    if (!canVisitStep(this.state, step)) throw new Error('This setup step has not been reached yet.');
    if (step === this.state.step && (step !== 'agents' || this.state.agentStage === 'select')) return;
    const saved = await this.api('/api/onboarding/navigate', {
      method: 'POST', type: 'application/json', body: JSON.stringify({step}),
    });
    this.state = {...this.state, ...saved};
    this.guideId = null;
    this.focusHeading = true;
    await this.refresh();
  }

  async back() {
    if (this.state.step === 'agents' && this.state.agentStage === 'connect') {
      this.guideId = null;
      return this.save({agentStage: 'select'});
    }
    const visible = steps.filter(step => step !== 'firmware'
      || (this.state.display !== 'desktop' && !this.state.deviceDeferred));
    const previous = visible[visible.indexOf(this.state.step) - 1];
    if (previous) await this.save({step: previous, ...(previous === 'agents' ? {agentStage: 'select'} : {})});
  }

  async skip() {
    if (this.state.step === 'agents') {
      if (this.state.agentStage === 'select') return this.save({agentsDeferred: true, step: 'character'});
      if (this.guideId) {
        const deferredAgents = [...new Set([...this.state.deferredAgents, this.guideId])];
        this.guideId = null;
        await this.save({deferredAgents});
        if (this.pendingAgents().length) return;
      }
      return this.save({step: 'character'});
    }
    await this.save({deviceDeferred: true});
    await this.api('/api/onboarding/display', {method: 'POST'});
    await this.save({step: 'complete'});
  }

  pendingAgents() {
    return this.state.agents.map(id => this.status.agents.find(agent => agent.id === id))
      .filter(agent => agent && !this.state.deferredAgents.includes(agent.id) && !isAgentReady(agent));
  }

  async installHooks() {
    await this.api('/api/onboarding/rescan', {method: 'POST'});
    await this.refresh();
    const selected = this.status.agents.filter(agent => this.state.agents.includes(agent.id));
    const changes = selected.filter(agent => !agent.installed || !isHookCurrent(agent.hookStatus));
    if (changes.length) {
      const names = changes.map(agent => agent.name).join(', ');
      const operation = changes.every(agent => agent.installed) ? 'Update'
        : changes.every(agent => !agent.installed) ? 'Install' : 'Install or update';
      const files = changes.flatMap(agent => agent.locations?.length
        ? agent.locations.filter(location => location.running && location.hookStatus !== 'unsupported'
          && !isHookCurrent(location.hookStatus)
          && (location.detected || location.hookStatus !== 'missing' || (location.id === 'host' && agent.id === 'copilot')))
          .map(location => `${agent.name} (${location.name}): ${location.configPath ?? 'agent configuration'}`)
        : agent.configPath ? [`${agent.name}: ${agent.configPath}`] : []);
      if (!await this.confirm(`${operation} hooks for ${names}.\n\n`
        + 'These hooks report agent activity to Agent Buddy. Existing hook entries are preserved, and changed files have backups. '
        + 'Some agents need a separate approval inside the agent.', `${operation} hooks`, files.join('\n'), {
          title: `${operation} agent hooks?`, context: 'Agent connections',
          note: changes.length < selected.length ? 'Current hooks for your other selected agents will stay unchanged.' : '',
        })) return;
    }
    const {results} = await this.api('/api/onboarding/hooks', {
      method: 'POST', type: 'application/json', body: JSON.stringify({
        confirmed: changes.length > 0, agents: selected.map(agent => agent.id), installAgents: changes.map(agent => agent.id),
      }),
    });
    this.hookErrors = new Map(results.filter(result => !result.ok).map(result => [result.id, result.error]));
    this.guideId = null;
    await this.refresh();
    this.state = this.status.onboarding;
    // Set only now: the render during the refresh above still shows the agent list, and would
    // focus its heading instead of the guide that appears below it.
    this.focusHeading = true;
    const ready = this.state.agents.length > 0 && this.state.agents.every(id => {
      const agent = this.status.agents.find(entry => entry.id === id);
      return isAgentReady(agent) && !agent.warning;
    });
    if (ready && results.every(result => result.ok && !result.warning))
      await this.save({step: 'character'});
  }

  async detect() {
    const detection = await this.api('/api/devices');
    await this.refresh();
    this.ports = detection.ports;
    const present = this.ports.some(port => port.path === this.state.port);
    const wifi = this.status.connected && this.status.transport === 'wifi';
    const port = wifi ? null : present ? this.state.port : this.ports.length === 1 ? this.ports[0].path : null;
    await this.save({port, deviceDeferred: false});
    this.renderDeviceDetection(this.busy);
    if (this.state.step === 'firmware') this.notify($('ob-detection-message').textContent,
      isDeviceConnected(this.status, this.state) || this.ports.length ? 'info' : 'error');
  }

  async setupDevice(flash) {
    const choice = {port: this.state.port, character: this.state.character, display: this.state.display};
    let board = null;
    if (flash) {
      if (!choice.port) throw new Error('Detect and select the USB device first.');
      board = reportedBoard(this.status, this.state) ?? this.board;
      const info = this.status.firmware?.usb?.boards?.find(entry => entry.id === board);
      if (!info) throw new Error('Select the board of the device first.');
      const name = this.characters.find(entry => entry.id === choice.character)?.name ?? choice.character;
      const version = this.status.firmware?.usb?.release;
      if (!await this.confirm(`Confirm that ${choice.port} is your ${info.models}.\n\n`
        + `This installs firmware${version ? ` v${version}` : ''} for the ${info.name}, then the ${name} character. `
        + 'Firmware for a different board can stop the device. '
        + 'It replaces the existing firmware and partition table.', 'Confirm and install', null, {
          title: 'Install firmware and character?', context: 'Device setup',
          note: 'Back up other firmware first. Keep the USB data cable connected until setup finishes.',
        })) return;
    }
    await this.api('/api/onboarding/device', {
      method: 'POST', type: 'application/json', body: JSON.stringify({flash, confirmed: true, ...choice, board}),
    });
    await this.refresh();
  }

  render() {
    if (!this.state || this.state.completed) return;
    this.syncWelcomeAnimation();
    const busy = this.isBusy();
    this.root.setAttribute('aria-busy', String(Boolean(busy)));
    for (const element of this.root.querySelectorAll('button, input, select'))
      element.disabled = Boolean(busy || element.dataset.unavailable === 'true');
    for (const section of this.root.querySelectorAll('[data-screen]'))
      section.hidden = section.dataset.screen !== this.state.step;
    for (const item of this.root.querySelectorAll('[data-step]')) {
      item.hidden = item.dataset.step === 'firmware' && (this.state.display === 'desktop' || this.state.deviceDeferred);
      if (item.dataset.step === this.state.step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
      const reached = this.state.visitedSteps?.includes(item.dataset.step);
      item.classList.toggle('passed', reached && item.dataset.step !== this.state.step);
      const button = item.querySelector('button');
      button.disabled = Boolean(busy || !canVisitStep(this.state, item.dataset.step));
      button.title = reached ? '' : 'Complete earlier steps to unlock this step.';
      if (item.dataset.step === this.state.step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    if (this.state.step === 'agents') this.renderAgents(busy);
    if (this.state.step === 'character') this.renderCharacters(busy);
    if (this.state.step === 'display') this.renderDisplay(busy);
    if (this.state.step === 'firmware') this.renderFirmware(busy);
    if (this.state.step === 'complete') this.renderSummary();
    this.renderFooter(busy);
    const missingCharacter = !this.characters.some(entry => entry.id === this.state.character)
      && ['display', 'firmware', 'complete'].includes(this.state.step)
      ? 'The selected character is unavailable. Return to Character and choose an available pack.' : '';
    const error = this.offline ? 'The companion service is not available. Setup will resume when it reconnects.'
      : this.error || this.status?.onboarding?.error || missingCharacter;
    $('ob-error').hidden = !error;
    $('ob-error').textContent = error ?? '';
    if (this.focusHeading) this.focusStep();
  }

  // Moves focus to the heading of what changed. The agent guide (the steps and the test prompt)
  // appears below the agent list, so it scrolls to the top where it is seen.
  focusStep() {
    this.focusHeading = false;
    const guide = this.state.step === 'agents' && this.state.agentStage === 'connect' && this.guideId;
    const heading = this.root.querySelector(guide ? '#ob-guide-title' : `[data-screen="${this.state.step}"] h2`);
    if (!heading) return;
    heading.focus({preventScroll: Boolean(guide)});
    if (guide) $('ob-agent-guide').scrollIntoView({
      block: 'start', behavior: this.welcomeMotion?.matches ? 'auto' : 'smooth'});
  }

  syncWelcomeAnimation() {
    const scene = connectionScenes.find(entry => entry.step === this.state?.step);
    if (scene) this.preview?.setCanvas($(`${scene.prefix}-device-animation`));
    this.preview?.update(this.state?.character, Boolean(this.state && !this.state.completed
      && this.status?.onboarding?.completed !== true
      && scene && this.state.display !== 'desktop' && !(scene.step === 'complete' && this.state.deviceDeferred)
      && !this.welcomeMotion.matches && !document.hidden && !this.offline));
    const active = this.state && !this.state.completed && this.state.step === 'welcome'
      && this.status?.onboarding?.completed !== true
      && !this.welcomeMotion.matches && !document.hidden;
    $('ob-welcome-play').hidden = !active || !this.welcomeBlocked;
    if (!active) {
      this.welcomeVideo.pause();
      this.welcomeVideo.classList.remove('playing');
      return;
    }
    if (!this.welcomeVideo.paused || this.welcomeStarting || this.welcomeBlocked) return;
    this.welcomeStarting = true;
    this.welcomeVideo.play().catch(error => {
      if (error.name === 'AbortError') return;
      this.welcomeBlocked = true;
      this.welcomeVideo.classList.remove('playing');
      $('ob-welcome-play').hidden = false;
      this.notify('Select Play animation to start the welcome animation.', 'info');
    }).finally(() => { this.welcomeStarting = false; });
  }

  renderAgents(busy) {
    const connect = this.state.agentStage === 'connect';
    $('ob-agent-selection').hidden = false;
    if (!connect) {
      $('ob-agent-guide').hidden = true;
      $('ob-agent-result').hidden = true;
    }
    const key = JSON.stringify([
      this.status.agents.map(agent => [agent.id, agent.name, agent.clients, agent.detected]), this.status.badges?.icons]);
    const list = $('ob-agents');
    if (key !== this.agentKey) {
      this.agentKey = key;
      const focused = document.activeElement?.dataset.agent;
      const cards = [];
      for (const agent of this.status.agents) {
        const card = document.createElement('label');
        card.className = 'choice-card agent-choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.agent = agent.id;
        const icon = document.createElement('canvas');
        icon.setAttribute('aria-hidden', 'true');
        this.drawAgentIcon(icon, this.status.badges?.icons?.find(entry => entry.id === agent.id), 64);
        const body = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = agent.name;
        body.append(name);
        if (!agent.detected || agent.clients) {
          const note = document.createElement('span');
          note.className = 'availability';
          note.textContent = agent.detected || agent.id === 'copilot' ? agent.clients ?? '' : 'Not detected';
          body.append(note);
        }
        const mark = document.createElement('span');
        mark.className = 'selection-mark';
        mark.setAttribute('aria-hidden', 'true');
        card.append(input, icon, body, mark);
        cards.push(card);
      }
      list.replaceChildren(...cards);
      if (focused) list.querySelector(`[data-agent="${focused}"]`)?.focus();
    }
    for (const agent of this.status.agents) {
      const input = list.querySelector(`[data-agent="${agent.id}"]`);
      const selected = this.state.agents.includes(agent.id);
      const unavailable = !agent.detected && agent.id !== 'copilot' && !selected;
      input.checked = selected;
      input.disabled = busy || unavailable;
      input.dataset.unavailable = String(unavailable);
      const card = input.closest('.agent-choice');
      card.classList.toggle('selected', selected);
      card.classList.toggle('unavailable', unavailable);
    }
    if (connect) {
      this.renderGuide();
      $('ob-agent-guide').hidden = !this.guideId;
      const result = $('ob-agent-result');
      result.hidden = Boolean(this.guideId || busy);
      const selected = this.status.agents.filter(agent => this.state.agents.includes(agent.id));
      const ready = selected.length > 0 && selected.every(isAgentReady);
      result.textContent = ready ? 'Your selected agents are connected. You can change them above.'
        : 'Your agent choices are saved. You can change them above or continue setup later.';
      result.className = `guide-state ${ready ? 'ready' : 'waiting'}`;
    }
  }

  renderGuide() {
    const selected = this.state.agents.filter(id => !this.state.deferredAgents.includes(id));
    if (!this.guideId || !selected.includes(this.guideId)) this.guideId = this.pendingAgents()[0]?.id ?? null;
    const agent = this.status.agents.find(entry => entry.id === this.guideId);
    const ready = agent ? isAgentReady(agent) : !this.pendingAgents().length;
    $('ob-guide-progress').textContent = agent
      ? `Agent ${this.state.agents.indexOf(agent.id) + 1} of ${this.state.agents.length}` : 'Your selected agents';
    $('ob-guide-title').textContent = agent ? `Connect ${agent.name}.`
      : this.state.deferredAgents.length ? 'Agent setup saved.' : 'Your agents are connected.';
    const state = $('ob-guide-state');
    state.textContent = !agent ? 'Continue to choose your character.' : ready ? 'Activity received. Connected.'
      : !agent.enabled ? 'This agent is disabled. Select Agents in the navigation, then Next to enable it.'
      : !agent.installed || !['installed', 'needs-approval'].includes(agent.hookStatus) ? 'Hook installation needs attention.'
      : agent.hookStatus === 'needs-approval' ? 'Hooks installed. Approval is needed inside the agent.'
      : 'Hooks installed. Waiting for the first event.';
    state.className = `guide-state ${ready ? 'ready' : 'waiting'}`;
    const instructions = ready || !agent ? [] : agent.action?.steps
      ?? ['Install the hooks, then start a new agent session.'];
    const command = ready || !agent ? undefined : agent.action?.command;
    const key = JSON.stringify([agent?.id, instructions, command]);
    if (key !== this.guideKey) {
      this.guideKey = key;
      const list = $('ob-guide-steps');
      list.replaceChildren();
      for (const text of instructions) {
        const item = document.createElement('li');
        item.textContent = text;
        const copied = text.includes('/hooks') ? ['/hooks', 'Copy /hooks']
          : command && text.includes(command) ? [command, 'Copy command'] : undefined;
        if (copied) {
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'secondary';
          copy.dataset.copy = copied[0];
          copy.textContent = copied[1];
          item.append(copy);
        }
        list.append(item);
      }
    }
    $('ob-test-prompt').hidden = ready || !agent;
    const locationHints = agent?.locations?.filter(location => location.hint)
      .map(location => `${location.name}: ${location.hint}`).join(' ');
    $('ob-guide-note').textContent = locationHints || (agent?.id === 'hermes'
      ? 'Hermes may request approval again when each event type first runs. One received event does not approve every hook.'
      : agent?.locations?.length ? 'Follow the guide where this agent runs: Windows or the listed WSL distribution.'
      : 'Agent Buddy checks for real agent activity. A demo animation is not a connection test.');
    const failure = agent && ((!ready && this.hookErrors.get(agent.id)) || agent.warning);
    $('ob-hook-error').hidden = !failure;
    $('ob-hook-error').textContent = failure ?? '';
    $('ob-retry-hooks').hidden = !agent || (agent.installed && agent.hookStatus !== 'outdated');
  }

  renderCharacters(busy) {
    const key = JSON.stringify(this.characters.map(entry => [entry.id, entry.name, entry.thumbnail, entry.bytes]));
    const list = $('ob-characters');
    if (key !== this.characterKey) {
      this.characterKey = key;
      const focused = document.activeElement?.value;
      const cards = this.characters.map(entry => {
        const card = document.createElement('label');
        card.className = 'choice-card character-choice';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'onboarding-character';
        input.value = entry.id;
        const image = document.createElement('img');
        image.alt = `${entry.name} character`;
        if (entry.thumbnail) image.src = this.thumbnail(entry.id);
        else image.hidden = true;
        const name = document.createElement('strong');
        name.textContent = entry.name;
        const mark = document.createElement('span');
        mark.className = 'selection-mark';
        mark.setAttribute('aria-hidden', 'true');
        card.append(input, image, name, mark);
        return card;
      });
      list.replaceChildren(...cards);
      if (focused) [...list.querySelectorAll('input')].find(input => input.value === focused)?.focus();
    }
    for (const input of list.querySelectorAll('input')) {
      const selected = input.value === this.state.character;
      input.checked = selected;
      input.disabled = busy;
      input.closest('.character-choice').classList.toggle('selected', selected);
    }
    const missing = !this.characters.some(entry => entry.id === this.state.character);
    $('ob-character-result').hidden = !missing;
    $('ob-character-result').textContent = this.characters.length
      ? 'Your selected character is unavailable. Choose another character.'
      : 'No characters are available. Select Refresh characters to try again.';
  }

  renderDisplay(busy) {
    for (const card of this.root.querySelectorAll('[data-display]')) {
      const selected = card.dataset.display === this.state.display;
      card.classList.toggle('selected', selected);
      card.querySelector('input').checked = selected;
    }
    for (const scene of choiceScenes) this.renderConnectionScene(scene);
    $('ob-device-detection').hidden = this.state.display === 'desktop';
    $('ob-detection-message').hidden = this.state.display === 'desktop';
    this.renderDeviceDetection(busy);
  }

  renderDeviceDetection(busy) {
    const connected = isDeviceConnected(this.status, this.state);
    const setup = this.status.onboarding?.deviceSetup;
    const wifi = (connected ? this.status.transport : setup?.transport) === 'wifi';
    const ports = [...this.ports];
    if (this.state.port && !ports.some(port => port.path === this.state.port))
      ports.unshift({path: this.state.port, saved: true});
    const key = JSON.stringify(ports.map(port => [port.path, Boolean(port.saved)]));
    const select = $('ob-port');
    if (key !== this.portKey) {
      this.portKey = key;
      select.replaceChildren();
      select.add(new Option('Select your Waveshare device', ''));
      for (const port of ports) select.add(new Option(`${port.path}${port.saved ? ' (saved; detect to check)' : ''}`, port.path));
    }
    select.value = this.state.port ?? '';
    for (const scene of connectionScenes.slice(0, 2)) this.renderConnectionScene(scene);
    $('ob-device-connection-hint').textContent = wifi
      ? 'No USB cable is needed for this connection. First-time firmware installation needs USB.'
      : 'Connect it with a USB data cable. A charge-only cable cannot detect the device.';
    const message = connected ? `Agent Buddy device connected over ${wifi ? 'Wi-Fi' : 'USB'}.`
      : this.state.port && !this.ports.some(port => port.path === this.state.port)
        ? `Saved USB device: ${this.state.port}. Select Detect Device to check the connection.`
      : this.ports.length > 1 ? 'Several USB ports found. Select your Waveshare device.'
      : this.ports.length === 1 ? 'USB device found. Agent Buddy firmware may need installation.'
      : this.status.wifiPaired && this.status.mode !== 'usb'
        ? 'Waiting for your paired Wi-Fi device. Keep it powered on and on the same network as this computer.'
        : 'No USB device found. Check the USB data cable, then try again.';
    $('ob-detection-message').textContent = message;
    $('ob-detection-message').className = `detection-message${connected || this.ports.length ? ' ready' : ''}`;
    $('ob-port-label').hidden = wifi || ports.length < 2;
    select.disabled = busy || wifi || ports.length < 2;
  }

  renderFirmware(busy) {
    const usb = this.status.firmware?.usb;
    const setup = this.status.onboarding?.deviceSetup;
    const character = this.status.installing;
    const installing = usb?.installing;
    const active = Boolean(setup || this.status.onboarding?.busy || character || installing);
    const name = this.characters.find(entry => entry.id === this.state.character)?.name ?? this.state.character;
    const ready = isDeviceReady(this.status, this.state);
    const connected = isDeviceConnected(this.status, this.state);
    const wifi = (connected ? this.status.transport : setup?.transport) === 'wifi';
    this.renderDeviceDetection(busy);
    $('ob-firmware-lede').textContent = wifi
      ? 'Keep your device on and connected to Wi-Fi during setup.'
      : setup?.flash === false || connected ? 'Keep the USB cable connected until character installation finishes.'
      : 'Keep the USB cable connected until firmware and character installation finish.';
    $('ob-firmware-state').textContent = active ? character ? `Installing the ${character.name} character.`
        : this.status.onboarding.phase ?? 'Preparing the device...'
      : ready ? `${wifi ? 'Connected over Wi-Fi. ' : ''}Firmware and selected character are ready.`
      : connected ? `Connected over ${wifi ? 'Wi-Fi' : 'USB'}. Install the ${name} character.`
      : this.state.port ? `USB device selected: ${this.state.port}. Install firmware to connect it.`
      : 'No USB device selected. Go back to detect your device.';
    $('ob-firmware-state').className = `guide-state ${ready && !active ? 'ready' : 'waiting'}`;
    const note = $('ob-character-install-note');
    note.hidden = !(setup?.flash === false || (connected && !ready && !active) || (setup?.flash && character));
    note.textContent = setup?.flash && character
      ? 'The firmware install is complete. Your selected character is being installed next.'
      : `This installs only the ${name} character. Your existing firmware stays unchanged.`;
    $('ob-device-actions').hidden = active;
    $('ob-install-character').hidden = active || !connected || ready;
    $('ob-install-character').disabled = busy || active;
    $('ob-install-character').textContent = `Install ${name} character`;
    const firmware = $('ob-firmware-options');
    firmware.hidden = active || wifi || !this.state.port;
    if (!active && firmware.dataset.required !== String(!connected)) {
      firmware.dataset.required = String(!connected);
      firmware.open = !connected;
    }
    $('ob-firmware-options-title').textContent = connected ? 'Replace firmware (optional)' : 'Install firmware';
    // Each board has its own firmware. A device that answers names its board; for one that does not,
    // the person chooses it. A connected device of a board without release firmware keeps its own.
    const boards = usb?.boards ?? [];
    const board = this.status.firmware?.board;
    const reported = reportedBoard(this.status, this.state);
    const otherBoard = connected && board && !reported && !boards.some(entry => entry.id === board);
    const chosen = boards.find(entry => entry.id === (reported ?? this.board));
    const boardSelect = $('ob-board');
    const key = JSON.stringify(boards.map(entry => entry.id));
    if (key !== this.boardKey) {
      this.boardKey = key;
      boardSelect.replaceChildren(new Option('Select the board', ''));
      for (const entry of boards) boardSelect.add(new Option(entry.models, entry.id));
    }
    boardSelect.value = chosen && !reported ? chosen.id : '';
    $('ob-board-label').hidden = Boolean(reported || otherBoard);
    $('ob-firmware-plan').textContent = otherBoard
      ? `This device is a ${board} board, and releases have no firmware for it, so setup does not install one. `
        + `Build and upload this board's firmware from source: BOARD=${board} bash tools/arduino.sh upload <port>.`
      : reported ? `Installs firmware${usb?.release ? ` v${usb.release}` : ''} for the ${chosen.name}, which the device `
        + `reports, then the ${name} character.`
      : 'The device does not report its board. Select its board, then install firmware and the '
        + `${name} character. Firmware for a different board can stop the device.`;
    $('ob-install-firmware').disabled = busy || active || !this.state.port || !usb?.flasher || !usb?.release
      || Boolean(otherBoard) || !chosen;
    $('ob-install-firmware').textContent = usb?.release ? `Install firmware v${usb.release}` : 'Install firmware';
    $('ob-device-help').hidden = active;
    $('ob-firmware-retry-hint').textContent = wifi
      ? 'Check device power and keep it on the same network as this computer. Wait for it to reconnect, then retry.'
      : 'Check your internet connection and USB data cable. Close serial monitors. If the board does not respond, hold BOOT while you reconnect USB, then release BOOT and detect it again.';
    const percent = character?.percent ?? installing?.percent ?? null;
    $('ob-device-progress').hidden = !active;
    $('ob-device-phase').textContent = character ? `Installing ${character.name} character` : installing
      ? {downloading: 'Downloading firmware', checking: 'Checking firmware', connecting: 'Connecting to install firmware', writing: 'Installing firmware'}[installing.stage]
      : this.status.onboarding.phase ?? 'Preparing the device';
    $('ob-device-percent').textContent = percent === null || percent === undefined ? '' : `${percent}%`;
    const bar = $('ob-device-bar');
    if (percent === null || percent === undefined) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(percent));
    bar.firstElementChild.style.width = `${percent ?? 0}%`;
  }

  renderSummaryImage(id, character, attribute = 'href') {
    const image = $(id);
    const source = character?.thumbnail ? this.thumbnail(character.id) : null;
    const available = Boolean(source && !this.failedSummaryPreviews.has(source));
    if (available) {
      if (image.getAttribute(attribute) !== source) image.setAttribute(attribute, source);
      image.removeAttribute('hidden');
    } else {
      image.setAttribute('hidden', '');
      image.removeAttribute(attribute);
    }
    return available;
  }

  renderConnectionScene(scene) {
    const character = this.characters.find(entry => entry.id === this.state.character);
    const name = character?.name ?? this.state.character;
    const display = scene.display ?? this.state.display;
    const deferred = scene.step === 'complete' && this.state.deviceDeferred;
    const desktop = display !== 'device' || deferred;
    const device = display !== 'desktop' && !deferred;
    const connected = device && !this.offline && isDeviceConnected(this.status, this.state);
    const operation = scene.step === 'firmware' ? this.status.onboarding?.deviceSetup?.transport : null;
    const transport = connected ? this.status.transport : operation;
    const wifi = transport === 'wifi';
    const guidedUsb = scene.step !== 'complete' && !scene.display
      && !(this.status.wifiPaired && this.status.mode !== 'usb');
    const link = device && !scene.display && !this.offline && (connected || operation || guidedUsb);
    const deviceSymbol = scene.display === 'device';
    const art = $(scene.art);
    art.classList.toggle('desktop-only', !device);
    $(`${scene.prefix}-scene`).classList.toggle('desktop-only', !device);
    $(`${scene.prefix}-scene`).classList.toggle('device-symbol', deviceSymbol);
    art.classList.toggle('wifi', wifi);
    art.classList.toggle('disconnected', !link);
    art.setAttribute('viewBox', deviceSymbol ? '435 10 150 150'
      : device ? '0 0 620 170' : '20 10 280 155');
    const connection = connected ? `connected over ${wifi ? 'Wi-Fi' : 'USB'}`
      : operation ? `setup over ${wifi ? 'Wi-Fi' : 'USB'}; waiting for the connection`
      : guidedUsb ? 'not connected. Connect it with a USB data cable' : 'not connected';
    art.setAttribute('aria-label', `Preview of ${name} ${device
      ? `${desktop ? 'on your desktop and device' : 'on your device'}. Device ${connection}.`
      : 'in the Agent Buddy desktop app.'}`);
    $(`${scene.prefix}-desktop-preview`).toggleAttribute('hidden', !desktop);
    $(`${scene.prefix}-device-preview`).toggleAttribute('hidden', !device);
    const desktopPreview = this.renderSummaryImage(`${scene.prefix}-desktop-character`, desktop ? character : null);
    const devicePreview = this.renderSummaryImage(`${scene.prefix}-device-character`, device ? character : null, 'src');
    const fallback = $(`${scene.prefix}-preview-fallback`);
    if (fallback) fallback.hidden = (!desktop || desktopPreview)
      && (!device || devicePreview || !$(`${scene.prefix}-device-animation`).hidden);
  }

  renderSummary() {
    this.renderConnectionScene(connectionScenes[2]);
    const desktop = this.state.display !== 'device' || this.state.deviceDeferred;
    const device = this.state.display !== 'desktop' && !this.state.deviceDeferred;
    const connected = device && !this.offline && isDeviceConnected(this.status, this.state);
    const ready = connected && isDeviceReady(this.status, this.state);
    const wifi = connected && this.status.transport === 'wifi';
    $('ob-ready-display-title').textContent = this.state.deviceDeferred
      ? 'Desktop now; device setup later' : displayNames[this.state.display];
    $('ob-ready-desktop-state').textContent = desktop
      ? this.status.desktop?.app?.state === 'stopped' ? 'Desktop app is not running' : 'Desktop app'
      : 'Your computer';
    $('ob-ready-device-state').hidden = !device;
    $('ob-ready-device-state').textContent = this.offline ? 'Service offline'
      : !connected ? 'Device not connected'
      : !ready ? 'Character setup needed' : `${wifi ? 'Wi-Fi' : 'USB'} connected`;
    $('ob-ready-device-state').className = ready ? 'ready' : 'waiting';

    const icons = this.status.badges?.icons ?? [];
    const selected = this.state.agents.map(id => this.status.agents.find(agent => agent.id === id)
      ?? {id, name: icons.find(icon => icon.id === id)?.name ?? id, detected: false});
    const agentReady = agent => !this.offline && isAgentReady(agent);
    const readyAgents = selected.filter(agentReady);
    const pending = selected.filter(agent => !agentReady(agent));
    $('ob-ready-agents-state').textContent = this.offline ? 'Service offline'
      : selected.length ? `${readyAgents.length} connected${pending.length ? `; ${pending.length} still to set up` : ''}`
      : 'No agents selected';
    $('ob-ready-agents-empty').hidden = selected.length > 0;
    const key = JSON.stringify([selected.map(agent => [agent.id, agent.name]), icons]);
    const list = $('ob-ready-agents');
    if (key !== this.summaryAgentKey) {
      this.summaryAgentKey = key;
      const cards = selected.map(agent => {
        const card = document.createElement('li');
        card.className = 'choice-card ready-agent';
        card.dataset.summaryAgent = agent.id;
        const icon = document.createElement('canvas');
        icon.setAttribute('aria-hidden', 'true');
        this.drawAgentIcon(icon, icons.find(entry => entry.id === agent.id), 40);
        const body = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = agent.name;
        const state = document.createElement('span');
        state.className = 'ready-agent-state';
        body.append(title, state);
        const mark = document.createElement('span');
        mark.className = 'selection-mark';
        mark.setAttribute('aria-hidden', 'true');
        card.append(icon, body, mark);
        return card;
      });
      list.replaceChildren(...cards);
    }
    for (const agent of selected) {
      const card = list.querySelector(`[data-summary-agent="${agent.id}"]`);
      const ready = agentReady(agent);
      card.classList.toggle('connected', ready);
      card.classList.toggle('pending', !ready);
      card.querySelector('.ready-agent-state').textContent = this.offline ? 'Service offline' : ready ? 'Connected'
        : this.state.agentsDeferred || this.state.deferredAgents.includes(agent.id) ? 'Setup later'
        : agent.hookStatus === 'needs-approval' ? 'Approval needed'
        : !agent.installed ? 'Hooks needed'
        : !isHookCurrent(agent.hookStatus) ? 'Hook update needed'
        : !agent.enabled ? 'Disabled' : 'Waiting for activity';
    }
    const notes = [];
    if (this.state.deviceDeferred) notes.push('Device setup is saved for later.');
    else if (device && !ready) notes.push(connected
      ? 'Return to Device to install your character.' : 'Reconnect your device before selecting Finish.');
    if (pending.length) notes.push('Continue agent setup in Settings.');
    $('ob-pending-summary').textContent = notes.length ? notes.join(' ')
      : 'Start a new agent session and watch your buddy react.';
  }

  renderFooter(busy) {
    const step = this.state.step;
    const next = $('ob-next');
    const exit = $('ob-exit');
    exit.hidden = !this.state.rerun;
    exit.disabled = Boolean(busy);
    $('ob-back').hidden = step === 'welcome';
    const skip = $('ob-skip');
    skip.hidden = !['agents', 'display', 'firmware'].includes(step)
      || (step === 'display' && this.state.display === 'desktop');
    skip.textContent = step === 'agents' ? 'Set up later' : 'Use desktop for now';
    next.textContent = step === 'welcome' ? 'Get Started' : step === 'complete' ? 'Finish'
      : step === 'agents' && this.state.agentStage === 'connect' ? 'Continue' : 'Next';
    let allowed = true;
    if (step === 'agents') allowed = this.state.agentStage === 'select' ? this.state.agents.length > 0
      : !this.guideId || isAgentReady(this.status.agents.find(agent => agent.id === this.guideId));
    if (step === 'character') allowed = this.characters.some(entry => entry.id === this.state.character);
    if (step === 'display' && this.state.display !== 'desktop')
      allowed = Boolean(this.state.deviceDeferred || this.state.port || this.status.connected);
    if (step === 'firmware') allowed = isDeviceReady(this.status, this.state);
    if (['display', 'firmware', 'complete'].includes(step))
      allowed &&= this.characters.some(entry => entry.id === this.state.character);
    next.disabled = Boolean(busy || !allowed);
  }
}
