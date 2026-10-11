import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createContext, runInContext} from 'node:vm';

function fixture() {
  let now = 0;
  let nextFrame = 1;
  const frames = new Map<number, (time: number) => void>();
  const loaded: number[] = [];
  const modes: Array<[number, number]> = [];
  const draws: Array<{x: number; width: number; data: number[]}> = [];
  const messages: Array<[string, string]> = [];
  const requests: Array<{id: string; signal: AbortSignal}> = [];
  const engine = {
    HEAPU8: new Uint8Array(1024),
    _ac_reserve: () => 128,
    _ac_load_reserved: () => { loaded.push(engine.HEAPU8[128]!); return 1; },
    _ac_error: () => 0,
    UTF8ToString: () => 'Invalid test pack.',
    _ac_display: () => 4,
    _ac_width: () => 2,
    _ac_height: () => 2,
    _ac_frame_x: () => 1,
    _ac_mode: (mode: number, touch: number) => { modes.push([mode, touch]); },
    _ac_frame: () => { engine.HEAPU8.fill(draws.length + 1, 64, 80); return 64; },
    _ac_changed: () => 1,
  };
  const canvas = {
    hidden: true, dataset: {} as Record<string, string>, width: 0, height: 0,
    getContext: () => ({
      createImageData: (width: number, height: number) => ({width, height, data: new Uint8ClampedArray(width * height * 4)}),
      putImageData: (image: {width: number; data: Uint8ClampedArray}, x: number) => {
        draws.push({x, width: image.width, data: [...image.data]});
      },
    }),
  };
  const context = createContext({
    AbortController, Uint8Array, performance: {now: () => now},
    requestAnimationFrame: (callback: (time: number) => void) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    canvas, engine,
    notify: (message: string, kind: string) => { messages.push([message, kind]); },
    loadPack: async (id: string, signal: AbortSignal) => {
      requests.push({id, signal});
      return Uint8Array.of(id === 'copilot' ? 1 : 2);
    },
  });
  const source = readFileSync(new URL('../../web/character-preview.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^export /gm, ''), context);
  runInContext(`const preview = new CharacterPreview(canvas, {
    loadPack, notify, changed: () => {}, engineFactory: async () => engine,
  });`, context);
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(now);
    }
  };
  return {context, canvas, engine, frames, loaded, modes, draws, messages, requests, advance};
}

test('a selected pack animates locally at a bounded frame rate and pauses without another download', async () => {
  const {context, canvas, frames, requests, draws, modes, advance} = fixture();
  await runInContext("preview.update('copilot', false)", context);
  assert.equal(requests.length, 0);
  assert.equal(frames.size, 0);
  assert.equal(canvas.hidden, true);
  assert.equal(await runInContext("preview.update('copilot', true)", context), true);
  assert.deepEqual(modes, [[0, 0]]);
  assert.equal(canvas.dataset.previewState, 'playing');
  assert.equal(canvas.width, 4);
  assert.equal(canvas.height, 4);
  assert.equal(draws[0]!.width, 2);
  assert.equal(draws[0]!.x, 1);
  assert.equal(frames.size, 1);
  advance(10);
  assert.equal(draws.length, 1);
  advance(24);
  assert.equal(draws.length, 2);
  await runInContext("preview.update('copilot', false)", context);
  assert.equal(canvas.hidden, true);
  assert.equal(canvas.dataset.previewState, 'paused');
  assert.equal(frames.size, 0);
  advance(1000);
  assert.equal(draws.length, 2);
  await runInContext("preview.update('copilot', true)", context);
  assert.equal(requests.length, 1);
  assert.equal(canvas.hidden, false);
  await runInContext("preview.update('custom', true)", context);
  assert.deepEqual(requests.map(request => request.id), ['copilot', 'custom']);
});

test('a slow previous pack cannot replace a newly selected character', async () => {
  const {context, loaded, canvas} = fixture();
  runInContext(`let oldSignal;
    let finishOld;
    preview.loadPack = (id, signal) => id === 'copilot'
      ? new Promise(resolve => { oldSignal = signal; finishOld = resolve; })
      : Promise.resolve(Uint8Array.of(2));
    const old = preview.update('copilot', true);`, context);
  await runInContext("preview.update('custom', true)", context);
  assert.equal(runInContext('oldSignal.aborted', context), true);
  runInContext('finishOld(Uint8Array.of(1))', context);
  assert.equal(await runInContext('old', context), false);
  assert.deepEqual(loaded, [2]);
  assert.equal(runInContext('preview.loaded', context), 'custom');
  assert.equal(canvas.dataset.previewState, 'playing');
});

test('a pack that finishes loading while hidden stays paused until its wizard scene is visible', async () => {
  const {context, canvas, draws, frames} = fixture();
  runInContext(`let finish;
    preview.loadPack = () => new Promise(resolve => { finish = resolve; });
    const pending = preview.update('custom', true);`, context);
  await runInContext("preview.update('custom', false)", context);
  runInContext('finish(Uint8Array.of(2))', context);
  await runInContext('pending', context);
  assert.equal(canvas.hidden, true);
  assert.equal(frames.size, 0);
  assert.equal(draws.length, 0);
  await runInContext("preview.update('custom', true)", context);
  assert.equal(canvas.hidden, false);
  assert.equal(draws.length, 1);
});

test('pack, renderer, and drawing failures keep the fallback visible and report an error once', async () => {
  for (const failure of ['download', 'pack', 'frame']) {
    const {context, canvas, engine, frames, messages} = fixture();
    if (failure === 'download') runInContext("preview.loadPack = async () => { throw new Error('Download failed.'); }", context);
    if (failure === 'pack') engine._ac_load_reserved = () => 0;
    if (failure === 'frame') engine._ac_frame = () => 0;
    assert.equal(await runInContext("preview.update('copilot', true)", context), false);
    assert.equal(canvas.hidden, true);
    assert.equal(canvas.dataset.previewState, 'error');
    assert.equal(frames.size, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]![1], 'error');
    assert.match(messages[0]![0], /animation could not start/);
    await runInContext("preview.update('copilot', true)", context);
    assert.equal(messages.length, 1);
  }
});

test('the renderer follows the visible scene and reuses the loaded pack without parallel animation loops', async () => {
  const {context, canvas, frames, requests, draws, advance} = fixture();
  await runInContext("preview.update('copilot', true)", context);
  context.nextCanvas = {...canvas, hidden: true, dataset: {previewState: 'paused'}};
  runInContext('preview.setCanvas(nextCanvas)', context);
  assert.equal(canvas.hidden, true);
  assert.equal(canvas.dataset.previewState, 'paused');
  assert.equal(frames.size, 0);
  await runInContext("preview.update('copilot', true)", context);
  assert.equal(runInContext('nextCanvas.hidden', context), false);
  assert.equal(runInContext('nextCanvas.dataset.previewState', context), 'playing');
  assert.equal(requests.length, 1);
  assert.equal(frames.size, 1);
  advance(34);
  assert.equal(draws.length, 3);
  runInContext('preview.setCanvas(canvas)', context);
  await runInContext("preview.update('copilot', true)", context);
  assert.equal(runInContext('nextCanvas.hidden', context), true);
  assert.equal(canvas.hidden, false);
  assert.equal(requests.length, 1);
  assert.equal(frames.size, 1);
});

test('an in-flight pack loads into the current scene rather than a hidden prior scene', async () => {
  const {context, canvas, frames, requests} = fixture();
  context.nextCanvas = {...canvas, hidden: true, dataset: {previewState: 'paused'}};
  runInContext(`let finish;
    preview.loadPack = (id, signal) => { loadPack(id, signal); return new Promise(resolve => { finish = resolve; }); };
    const pending = preview.update('copilot', true);
    preview.setCanvas(nextCanvas);`, context);
  runInContext('finish(Uint8Array.of(1))', context);
  await runInContext('pending', context);
  assert.equal(canvas.hidden, true);
  assert.equal(runInContext('nextCanvas.hidden', context), false);
  assert.equal(requests.length, 1);
  assert.equal(frames.size, 1);
});

test('changing character reallocates the frame image to match the new pack dimensions', async () => {
  const {context, engine, loaded, draws} = fixture();
  engine._ac_width = () => loaded.at(-1) === 1 ? 2 : 4;
  await runInContext("preview.update('copilot', true)", context);
  await runInContext("preview.update('custom', true)", context);
  assert.deepEqual(draws.map(draw => draw.width), [2, 4]);
});

test('transient pack and engine failures retry after leaving the preview without repeated status retries', async () => {
  for (const failure of ['download', 'engine']) {
    const {context, frames, messages} = fixture();
    runInContext(`
      let attempts = 0;
      ${failure === 'download'
        ? "preview.loadPack = async () => { if (++attempts === 1) throw new Error('Offline.'); return Uint8Array.of(1); };"
        : "preview.engineFactory = async () => { if (++attempts === 1) throw new Error('Engine unavailable.'); return engine; }"}
    `, context);
    assert.equal(await runInContext("preview.update('copilot', true)", context), false);
    assert.equal(await runInContext("preview.update('copilot', true)", context), false);
    assert.equal(runInContext('attempts', context), 1);
    assert.equal(messages.length, 1);
    await runInContext("preview.update('copilot', false)", context);
    assert.equal(await runInContext("preview.update('copilot', true)", context), true);
    assert.equal(runInContext('attempts', context), 2);
    assert.equal(frames.size, 1);
  }
});
