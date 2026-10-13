import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {speechSampleRate} from '../src/speech.js';
import {StateCoordinator} from '../src/state-coordinator.js';
import {VoiceNotifier, type VoiceNotificationMode} from '../src/voice-notifications.js';

function packet(text: string, durationMs = 100): Buffer {
  const frames = speechSampleRate * durationMs / 1000;
  const audio = Buffer.alloc(16 + frames * 2);
  audio.write('ACSP');
  audio.writeUInt8(1, 4);
  audio.writeUInt8(1, 5);
  audio.writeUInt16LE(speechSampleRate, 6);
  audio.writeUInt32LE(frames, 8);
  audio.write(text, 16);
  return audio;
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function deferredPacket() {
  let resolve!: (audio: Buffer) => void;
  const promise = new Promise<Buffer>(done => { resolve = done; });
  return {promise, resolve};
}

function notifier(t: TestContext, mode: VoiceNotificationMode, options: {
  available?: () => boolean;
  synthesize?: (text: string) => Promise<Buffer>;
  speak?: () => Promise<void>;
} = {}) {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 100_000});
  const spoken: string[] = [];
  const synthesized: string[] = [];
  const errors: string[] = [];
  const voice = new VoiceNotifier({
    async speak(audio: Buffer) {
      await options.speak?.();
      spoken.push(audio.subarray(16).toString().replace(/\0+$/, ''));
    },
  }, mode, {
    available: options.available,
    random: () => 0,
    synthesizer: {
      async synthesize(text: string) {
        synthesized.push(text);
        return options.synthesize ? options.synthesize(text) : packet(text);
      },
    },
    log: () => undefined,
    error: message => errors.push(message),
  });
  async function advance(ms: number) {
    t.mock.timers.tick(ms);
    await flush();
  }
  return {voice, spoken, synthesized, errors, advance};
}

test('attention waits three seconds and a self-resolving question stays silent', async t => {
  const {voice, spoken, synthesized, advance} = notifier(t, 'milestones');
  voice.stateChanged('attention');
  await advance(2999);
  assert.deepEqual(synthesized, []);
  voice.stateChanged('working');
  await advance(1);
  assert.deepEqual(spoken, []);
  voice.stateChanged('attention');
  await advance(2999);
  assert.deepEqual(spoken, []);
  voice.stateChanged('attention'); // Duplicate state does not restart the delay.
  await advance(1);
  assert.deepEqual(spoken, ['I need your attention.']);
});

test('sustained attention varies phrases and bypasses routine cooldown', async t => {
  const {voice, spoken, advance} = notifier(t, 'chatty');
  voice.stateChanged('working');
  await advance(3000);
  voice.stateChanged('attention');
  await advance(3000);
  voice.stateChanged('working');
  voice.stateChanged('attention');
  await advance(3000);
  assert.deepEqual(spoken, ['On it.', 'I need your attention.', 'I have a question for you.']);
});

test('completion needs two quiet seconds and a restart cancels it', async t => {
  const {voice, spoken, advance} = notifier(t, 'milestones');
  voice.stateChanged('working');
  voice.stateChanged('complete');
  await advance(1999);
  assert.deepEqual(spoken, []);
  voice.stateChanged('working');
  await advance(1);
  assert.deepEqual(spoken, []);
  voice.stateChanged('complete');
  await advance(2000);
  assert.deepEqual(spoken, ['All done.']);
  voice.stateChanged('idle');
  await advance(20_000);
  assert.deepEqual(spoken, ['All done.']);
});

test('coordinator animations remain immediate and completion precedes its four-second idle reset', async t => {
  const {voice, spoken, advance} = notifier(t, 'milestones');
  const states: string[] = [];
  const coordinator = new StateCoordinator(state => {
    states.push(state);
    voice.stateChanged(state);
  }, {sweepMs: 0});
  t.after(() => coordinator.close());
  coordinator.handle('preToolUse', {sessionId: 'one'});
  coordinator.handle('agentStop', {sessionId: 'one'});
  assert.deepEqual(states, ['working', 'complete']);
  assert.deepEqual(spoken, []);
  await advance(2000);
  assert.deepEqual(spoken, ['All done.']);
  assert.equal(coordinator.state, 'complete');
  await advance(2000);
  assert.equal(coordinator.state, 'idle');
  await advance(20_000);
  assert.deepEqual(spoken, ['All done.']);
});

test('slow completion synthesis remains relevant after the animation returns to idle', async t => {
  const synthesis = deferredPacket();
  const {voice, spoken, advance} = notifier(t, 'milestones', {
    synthesize: () => synthesis.promise,
  });
  voice.stateChanged('complete');
  await advance(2000);
  await advance(2000);
  voice.stateChanged('idle');
  synthesis.resolve(packet('All done.'));
  await voice.settled();
  assert.deepEqual(spoken, ['All done.']);
});

test('working is announced once per work stretch, not per tool or brief stop/start', async t => {
  const {voice, spoken, advance} = notifier(t, 'chatty');
  voice.stateChanged('working');
  await advance(2999);
  assert.deepEqual(spoken, []);
  await advance(1);
  assert.deepEqual(spoken, ['On it.']);
  await advance(15_000);
  for (const stop of ['complete', 'idle', 'attention', 'surprise'] as const) {
    voice.stateChanged(stop);
    await advance(1000);
    voice.stateChanged('working');
    await advance(3000);
  }
  assert.deepEqual(spoken, ['On it.']);
  voice.stateChanged('complete');
  await advance(2000);
  voice.stateChanged('idle');
  await advance(15_000);
  voice.stateChanged('working');
  await advance(3000);
  assert.deepEqual(spoken, ['On it.', 'All done.', 'Mmmm... let me think.']);
});

test('routine cooldown drops chatter rather than replaying it later', async t => {
  const {voice, spoken, advance} = notifier(t, 'chatty');
  voice.stateChanged('working');
  await advance(3000);
  voice.stateChanged('complete');
  await advance(2000);
  voice.stateChanged('idle');
  await advance(20_000);
  assert.deepEqual(spoken, ['On it.']);
  voice.stateChanged('working');
  await advance(3000);
  assert.deepEqual(spoken, ['On it.', 'Mmmm... let me think.']);
  await advance(12_999);
  voice.stateChanged('idle');
  await advance(2000);
  assert.equal(spoken.length, 2);
  await advance(1);
  assert.equal(spoken.length, 2);
  voice.stateChanged('working');
  voice.stateChanged('idle');
  await advance(2000);
  assert.equal(spoken.at(-1), 'Ready when you are.');
});

test('only the latest pending event survives synthesis, including same-state reentry', async t => {
  const synthesis = deferredPacket();
  const {voice, spoken, synthesized, advance} = notifier(t, 'milestones', {
    synthesize: text => synthesized.length === 1 ? synthesis.promise : Promise.resolve(packet(text)),
  });
  voice.stateChanged('attention');
  await advance(3000);
  assert.equal(synthesized.length, 1);
  for (let i = 0; i < 10; i++) {
    voice.stateChanged('working');
    voice.stateChanged('complete');
    await advance(2000);
    voice.stateChanged('attention');
    await advance(3000);
  }
  assert.equal(synthesized.length, 1);
  synthesis.resolve(packet('stale question'));
  await flush();
  assert.deepEqual(spoken, []);
  await advance(0);
  assert.deepEqual(spoken, ['I need your attention.']);
  assert.equal(synthesized.length, 2);
});

test('replacement events must satisfy their own stability delay', async t => {
  const synthesis = deferredPacket();
  const {voice, spoken, synthesized, advance} = notifier(t, 'milestones', {
    synthesize: text => synthesized.length === 1 ? synthesis.promise : Promise.resolve(packet(text)),
  });
  voice.stateChanged('attention');
  await advance(3000);
  voice.stateChanged('complete');
  synthesis.resolve(packet('stale question'));
  await flush();
  await advance(1999);
  assert.deepEqual(spoken, []);
  await advance(1);
  assert.deepEqual(spoken, ['All done.']);
});

test('off, unavailable devices and surprise stay silent', async t => {
  let available = true;
  const {voice, spoken, synthesized, advance} = notifier(t, 'off', {available: () => available});
  voice.stateChanged('attention');
  await advance(3000);
  voice.setMode('chatty');
  voice.stateChanged('working');
  available = false;
  await advance(3000);
  available = true;
  voice.stateChanged('surprise');
  await advance(3000);
  assert.deepEqual(synthesized, []);
  assert.deepEqual(spoken, []);
});

test('mode changes invalidate queued events even when turned back on', async t => {
  const {voice, spoken, advance} = notifier(t, 'chatty');
  voice.stateChanged('working');
  voice.setMode('off');
  voice.setMode('chatty');
  await advance(3000);
  assert.deepEqual(spoken, []);
});

for (const reason of ['mode', 'connection', 'resumed'] as const) {
  test(`automatic speech rechecks ${reason} after synthesis`, async t => {
    const synthesis = deferredPacket();
    let available = true;
    const {voice, spoken, advance} = notifier(t, 'milestones', {
      available: () => available,
      synthesize: () => synthesis.promise,
    });
    voice.stateChanged('complete');
    await advance(2000);
    if (reason === 'mode') voice.setMode('off');
    if (reason === 'connection') available = false;
    if (reason === 'resumed') voice.stateChanged('working');
    synthesis.resolve(packet('stale completion'));
    await voice.settled();
    assert.deepEqual(spoken, []);
  });
}

test('speech failures are reported without rejecting future announcements', async t => {
  let attempts = 0;
  const {voice, spoken, errors, advance} = notifier(t, 'milestones', {
    speak: async () => { if (++attempts === 1) throw new Error('device unavailable'); },
  });
  voice.stateChanged('attention');
  await advance(3000);
  voice.stateChanged('complete');
  await advance(2000);
  assert.equal(attempts, 2);
  assert.deepEqual(spoken, ['All done.']);
  assert.deepEqual(errors, ['[voice] device unavailable']);
});

test('synthesis failures do not block the latest pending event', async t => {
  let fail!: (error: Error) => void;
  const failedSynthesis = new Promise<Buffer>((_resolve, reject) => { fail = reject; });
  const {voice, spoken, synthesized, errors, advance} = notifier(t, 'milestones', {
    synthesize: text => synthesized.length === 1 ? failedSynthesis : Promise.resolve(packet(text)),
  });
  voice.stateChanged('attention');
  await advance(3000);
  voice.stateChanged('complete');
  await advance(2000);
  fail(new Error('synthesizer failed'));
  await flush();
  await advance(0);
  assert.deepEqual(spoken, ['All done.']);
  assert.deepEqual(errors, ['[voice] synthesizer failed']);
});

test('contextual narration suppresses pending and nearby generic working speech', async t => {
  const {voice, spoken, advance} = notifier(t, 'contextual');
  voice.stateChanged('working');
  await voice.narrate('Let me send that message to Paul for you.');
  await advance(3000);
  voice.stateChanged('idle');
  await advance(2000);
  voice.stateChanged('working');
  await advance(3000);
  assert.deepEqual(spoken, ['Let me send that message to Paul for you.']);
  voice.stateChanged('attention');
  await advance(3000);
  assert.equal(spoken.at(-1), 'I need your attention.');
});

test('contextual narration invalidates a generic working clip already in synthesis', async t => {
  const synthesis = deferredPacket();
  const {voice, spoken, synthesized, advance} = notifier(t, 'contextual', {
    synthesize: text => synthesized.length === 1 ? synthesis.promise : Promise.resolve(packet(text)),
  });
  voice.stateChanged('working');
  await advance(3000);
  const narration = voice.narrate('Let me check the calendar.');
  synthesis.resolve(packet('On it.'));
  await narration;
  assert.deepEqual(spoken, ['Let me check the calendar.']);
});

test('explicit narration stays ordered and waits for accepted audio to finish', async t => {
  const {voice, spoken, advance} = notifier(t, 'contextual', {
    synthesize: async text => packet(text, 5000),
  });
  await voice.narrate('First line.');
  const second = voice.narrate('Second line.');
  await flush();
  await advance(5249);
  assert.deepEqual(spoken, ['First line.']);
  await advance(1);
  await second;
  assert.deepEqual(spoken, ['First line.', 'Second line.']);
});

test('attention waits for playback, then rechecks relevance instead of sending stale audio', async t => {
  const {voice, spoken, synthesized, advance} = notifier(t, 'contextual', {
    synthesize: async text => packet(text, 5000),
  });
  await voice.narrate('Checking on that.');
  voice.stateChanged('attention');
  await advance(3000);
  assert.equal(synthesized.length, 1);
  voice.stateChanged('working');
  await advance(3000);
  assert.deepEqual(spoken, ['Checking on that.']);
  voice.stateChanged('attention');
  await advance(3000);
  assert.equal(spoken.at(-1), 'I need your attention.');
});

test('latest automatic event is checked when it reaches the explicit narration queue', async t => {
  const synthesis = deferredPacket();
  const {voice, spoken, synthesized, advance} = notifier(t, 'contextual', {
    synthesize: text => synthesized.length === 1 ? synthesis.promise : Promise.resolve(packet(text)),
  });
  const narration = voice.narrate('Thinking this through.');
  await flush();
  voice.stateChanged('attention');
  await advance(3000);
  voice.stateChanged('complete');
  await advance(2000);
  voice.stateChanged('attention');
  synthesis.resolve(packet('Thinking this through.'));
  await narration;
  await flush();
  await advance(2999);
  assert.deepEqual(spoken, ['Thinking this through.']);
  await advance(1);
  assert.deepEqual(spoken, ['Thinking this through.', 'I need your attention.']);
});

test('pending narration suppresses working even after the routine cooldown expires', async t => {
  const synthesis = deferredPacket();
  const {voice, spoken, advance} = notifier(t, 'contextual', {
    synthesize: () => synthesis.promise,
  });
  const narration = voice.narrate('Let me check.');
  await flush();
  voice.stateChanged('complete');
  await advance(2000);
  voice.stateChanged('working');
  await advance(20_000);
  synthesis.resolve(packet('Let me check.'));
  await narration;
  await advance(350);
  assert.deepEqual(spoken, ['Let me check.']);
});

for (const reason of ['mode', 'connection'] as const) {
  test(`contextual narration reports ${reason} changes during synthesis`, async t => {
    const synthesis = deferredPacket();
    let available = true;
    const {voice, spoken, errors} = notifier(t, 'contextual', {
      available: () => available,
      synthesize: () => synthesis.promise,
    });
    const narration = voice.narrate('Let me check.');
    await flush();
    if (reason === 'mode') voice.setMode('off');
    else available = false;
    synthesis.resolve(packet('Let me check.'));
    await assert.rejects(narration, reason === 'mode' ? /disabled/ : /Wi-Fi/);
    assert.deepEqual(spoken, []);
    assert.equal(errors.length, 1);
  });
}

test('contextual narration still validates and requires opt-in plus Wi-Fi', async t => {
  let available = true;
  const {voice} = notifier(t, 'chatty', {available: () => available});
  await assert.rejects(voice.narrate('Let me check.'), /not enabled/);
  voice.setMode('contextual');
  available = false;
  await assert.rejects(voice.narrate('Let me check.'), /Wi-Fi/);
  assert.throws(() => voice.narrate('https://example.com'), /URLs/);
  assert.throws(() => voice.narrate('first line\nsecond line'), /single spoken line/);
  assert.throws(() => voice.narrate('a'.repeat(181)), /180 characters/);
});
