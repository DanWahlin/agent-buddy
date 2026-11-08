let socket;
let context;
let settings = {};
const agent = document.getElementById('agent');
const pulse = document.getElementById('pulse');
const settingsFile = document.getElementById('settingsFile');
const status = document.getElementById('status');

function hydrate(value) {
  settings = value ?? {};
  agent.value = settings.agent ?? 'all';
  pulse.checked = settings.pulse !== false;
  settingsFile.value = settings.settingsFile ?? '';
}

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
  const action = JSON.parse(actionInfo);
  context = action.context;
  hydrate(action.payload.settings);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => {
    socket.send(JSON.stringify({event: registerEvent, uuid}));
    status.textContent = 'Waiting for Agent Buddy status...';
    socket.send(JSON.stringify({event: 'sendToPlugin', action: action.action, context, payload: {event: 'getStatus'}}));
  };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.context !== context) return;
    if (message.event === 'didReceiveSettings') hydrate(message.payload.settings);
    if (message.event === 'sendToPropertyInspector' && message.payload.event === 'status')
      status.textContent = message.payload.message;
  };
  socket.onerror = () => { status.textContent = 'Cannot connect to Stream Deck. Reopen the key settings.'; };
  socket.onclose = () => { status.textContent = 'Disconnected from Stream Deck. Reopen the key settings.'; };
};

function save() {
  if (socket?.readyState !== WebSocket.OPEN) {
    status.textContent = 'Not connected to Stream Deck. Reopen the key settings to save changes.';
    return;
  }
  settings = {...settings, agent: agent.value, pulse: pulse.checked, settingsFile: settingsFile.value.trim()};
  socket.send(JSON.stringify({event: 'setSettings', context, payload: settings}));
}

agent.addEventListener('change', save);
pulse.addEventListener('change', save);
settingsFile.addEventListener('change', save);
