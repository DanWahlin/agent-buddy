import assert from 'node:assert/strict';
import test from 'node:test';
import {VoiceNotifier} from '../src/voice-notifications.js';

function notifier(mode: 'off' | 'milestones' | 'chatty', available = true) {
  const spoken: string[] = [];
  const errors: string[] = [];
  const voice = new VoiceNotifier({
    async speak(packet: Buffer) {
      spoken.push(packet.toString());
    },
  }, mode, {
    available: () => available,
    random: () => 0,
    synthesizer: {
      async synthesize(text: string) {
        return Buffer.from(text);
      },
    },
    log: () => undefined,
    error: message => errors.push(message),
  });
  return {voice, spoken, errors};
}

test('milestones speaks varied attention and completion phrases only', async () => {
  const {voice, spoken} = notifier('milestones');
  voice.stateChanged('working');
  voice.stateChanged('attention');
  voice.stateChanged('working');
  voice.stateChanged('attention');
  voice.stateChanged('complete');
  voice.stateChanged('idle');
  await voice.settled();
  assert.equal(spoken.length, 3);
  assert.notEqual(spoken[0], spoken[1]);
  assert.match(spoken[0]!, /attention/);
  assert.match(spoken[2]!, /done|finished|complete|Wrapped/);
});

test('chatty adds work and idle but does not narrate idle after completion', async () => {
  const {voice, spoken} = notifier('chatty');
  voice.stateChanged('working');
  voice.stateChanged('idle');
  voice.stateChanged('working');
  voice.stateChanged('complete');
  voice.stateChanged('idle');
  await voice.settled();
  assert.equal(spoken.length, 4);
  assert.match(spoken[0]!, /On it|Mmmm|Working|gears|poke/);
  assert.match(spoken[1]!, /Ready|standing|quiet|next|void/);
});

test('off, unavailable devices, surprise, and disabled queued work stay silent', async () => {
  const off = notifier('off');
  off.voice.stateChanged('attention');
  await off.voice.settled();
  assert.deepEqual(off.spoken, []);

  const unavailable = notifier('chatty', false);
  unavailable.voice.stateChanged('working');
  await unavailable.voice.settled();
  assert.deepEqual(unavailable.spoken, []);

  const queued = notifier('chatty');
  queued.voice.stateChanged('surprise');
  queued.voice.stateChanged('working');
  queued.voice.setMode('off');
  await queued.voice.settled();
  assert.deepEqual(queued.spoken, []);
});

test('speech failures are reported without rejecting future announcements', async () => {
  let attempts = 0;
  const errors: string[] = [];
  const voice = new VoiceNotifier({
    async speak() {
      if (++attempts === 1) throw new Error('device unavailable');
    },
  }, 'milestones', {
    synthesizer: {async synthesize(text: string) { return Buffer.from(text); }},
    error: message => errors.push(message),
  });
  voice.stateChanged('attention');
  voice.stateChanged('complete');
  await voice.settled();
  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['[voice] device unavailable']);
});
