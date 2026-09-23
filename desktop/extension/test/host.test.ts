import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { Uri, configuration, fakeWebview, files, logged, reset } from './vscode-stub.js';
import { choosePack, discoverPacks } from '../src/host/pack-discovery.js';
import { CompanionViewProvider } from '../src/host/companion-view.js';

const EXTENSION = Uri.file('/ext');

/** A structurally valid pack, which is all discovery checks. */
function manifest(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 1,
    id,
    name: id[0].toUpperCase() + id.slice(1),
    frame: { width: 120, height: 112 },
    steps: 4,
    blinkLevels: [1, 0.75, 0.5, 0.25, 0],
    tracks: {
      right: {
        base: 'right.webp',
        blinks: 'right.blink.webp',
        patch: { size: [40, 16], cells: [[30, 50], [32, 50], null, [36, 52]] },
      },
      working: { base: 'working.webp' },
      surprise: { base: 'surprise.webp' },
      complete: { base: 'complete.webp' },
      attention: { base: 'attention.webp' },
    },
    states: {
      idle: 'gaze', surprise: 'surprise', working: 'working',
      complete: 'complete', attention: 'attention',
    },
    sleep: { track: 'right', step: 0, blinkLevel: 4 },
    ...extra,
  });
}

function addPack(folder: string, id: string, extra?: Record<string, unknown>) {
  files.set(folder + '/pack.json', manifest(id, extra));
  for (const name of ['right.webp', 'right.blink.webp', 'working.webp',
    'surprise.webp', 'complete.webp', 'attention.webp']) {
    files.set(folder + '/' + name, 'binary');
  }
}

beforeEach(() => {
  reset();
  logged.length = 0;
});

test('finds the pack bundled with the extension', async () => {
  addPack('/ext/packs/marvin', 'marvin');
  const { packs, problems } = await discoverPacks(EXTENSION);

  assert.equal(packs.length, 1);
  assert.equal(packs[0].pack.id, 'marvin');
  assert.equal(packs[0].origin, 'bundled');
  assert.equal(packs[0].folder.path, '/ext/packs/marvin');
  assert.deepEqual(problems, []);
});

test('accepts a configured path that is itself a pack folder', async () => {
  addPack('/ext/packs/marvin', 'marvin');
  addPack('/home/me/zaphod', 'zaphod');
  configuration.set('agentCompanion.packPaths', ['/home/me/zaphod']);

  const { packs } = await discoverPacks(EXTENSION);
  assert.deepEqual(packs.map(p => p.pack.id).sort(), ['marvin', 'zaphod']);
  assert.equal(packs.find(p => p.pack.id === 'zaphod')?.origin, 'configured');
});

test('accepts a configured path that is a folder of packs', async () => {
  addPack('/home/me/packs/zaphod', 'zaphod');
  addPack('/home/me/packs/enigma', 'enigma');
  configuration.set('agentCompanion.packPaths', ['/home/me/packs']);

  const { packs } = await discoverPacks(EXTENSION);
  assert.deepEqual(packs.map(p => p.pack.id).sort(), ['enigma', 'zaphod']);
});

test('a configured pack shadows a bundled one with the same id', async () => {
  addPack('/ext/packs/marvin', 'marvin');
  addPack('/home/me/marvin', 'marvin');
  configuration.set('agentCompanion.packPaths', ['/home/me/marvin']);

  const { packs } = await discoverPacks(EXTENSION);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].origin, 'configured', 'the users own pack should win');
});

test('reports a path that holds nothing usable, without failing the rest', async () => {
  addPack('/ext/packs/marvin', 'marvin');
  files.set('/home/me/notes/readme.txt', 'hello');
  configuration.set('agentCompanion.packPaths', ['/home/me/notes', '/home/me/missing']);

  const { packs, problems } = await discoverPacks(EXTENSION);
  assert.equal(packs.length, 1, 'the good pack is still found');
  assert.equal(problems.length, 2);
  assert.match(problems[0].reason, /contains no pack.json/);
  assert.match(problems[1].reason, /could not be read/);
});

test('rejects a malformed manifest with the reason', async () => {
  files.set('/ext/packs/broken/pack.json', '{ "format": 1, "id": "broken" }');
  const { packs, problems } = await discoverPacks(EXTENSION);

  assert.equal(packs.length, 0);
  assert.match(problems[0].reason, /pack.json is not valid/);
});

test('rejects unparseable JSON with the reason', async () => {
  files.set('/ext/packs/broken/pack.json', '{ not json');
  const { problems } = await discoverPacks(EXTENSION);
  assert.match(problems[0].reason, /pack.json could not be read/);
});

test('de-duplicates and ignores blank configured paths', async () => {
  addPack('/ext/packs/marvin', 'marvin');
  addPack('/home/me/zaphod', 'zaphod');
  configuration.set('agentCompanion.packPaths', ['/home/me/zaphod', '  ', '/home/me/zaphod']);

  const { packs, problems } = await discoverPacks(EXTENSION);
  assert.deepEqual(packs.map(p => p.pack.id).sort(), ['marvin', 'zaphod']);
  assert.deepEqual(problems, [], 'the repeated path should not be reported twice');
});

test('notes a missing bundled packs folder, which would mean a broken install', async () => {
  addPack('/home/me/zaphod', 'zaphod');
  configuration.set('agentCompanion.packPaths', ['/home/me/zaphod']);

  const { packs, problems } = await discoverPacks(EXTENSION);
  assert.deepEqual(packs.map(p => p.pack.id), ['zaphod'], 'still usable');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].folder.path, '/ext/packs');
});

test('a Windows drive letter is read as a path, not a URI scheme', async () => {
  addPack('C:/Users/me/packs/zaphod', 'zaphod');
  configuration.set('agentCompanion.packPaths', ['C:\\Users\\me\\packs']);

  const { packs } = await discoverPacks(EXTENSION);
  assert.deepEqual(packs.map(p => p.pack.id), ['zaphod']);
});

test('choosePack honours the setting, and falls back rather than showing nothing', () => {
  const packs = [
    { pack: { id: 'marvin' }, folder: Uri.file('/a'), origin: 'bundled' },
    { pack: { id: 'zaphod' }, folder: Uri.file('/b'), origin: 'configured' },
  ] as never;

  assert.equal(choosePack(packs, 'zaphod')?.pack.id, 'zaphod');
  assert.equal(choosePack(packs, 'nobody')?.pack.id, 'marvin', 'falls back to the first');
  assert.equal(choosePack(packs, undefined)?.pack.id, 'marvin');
  assert.equal(choosePack([], 'marvin'), null);
});

// --- the view ---------------------------------------------------------------

async function resolvedView() {
  addPack('/ext/packs/marvin', 'marvin');
  const output = { info() {}, warn() {}, error() {} } as never;
  const provider = new CompanionViewProvider(EXTENSION, output);
  const webview = fakeWebview();
  const view = { webview, onDidDispose() { return { dispose() {} }; } } as never;
  await provider.resolveWebviewView(view);
  return { provider, webview, view };
}

test('the page declares a strict policy and a matching nonce', async () => {
  const { webview } = await resolvedView();
  const csp = /content="([^"]*default-src[^"]*)"/.exec(webview.html)?.[1];
  assert.ok(csp, 'no content security policy was emitted');

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src https:\/\/file\+\.vscode-resource\.vscode-cdn\.net/);
  assert.doesNotMatch(csp, /connect-src/, 'the page fetches nothing, so it needs none');
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);

  const nonce = /script-src 'nonce-([a-f0-9]{32})'/.exec(csp)?.[1];
  assert.ok(nonce, 'the script nonce should be long and random');
  // Every inline tag has to carry the same nonce or the policy blocks it.
  const used = [...webview.html.matchAll(/nonce="([a-f0-9]+)"/g)].map(match => match[1]);
  assert.equal(used.length, 2, 'the style and the script tag');
  assert.ok(used.every(value => value === nonce));
});

test('a fresh nonce is minted per page', async () => {
  const first = (await resolvedView()).webview.html;
  reset();
  const second = (await resolvedView()).webview.html;
  assert.notEqual(
    /nonce="([a-f0-9]+)"/.exec(first)?.[1],
    /nonce="([a-f0-9]+)"/.exec(second)?.[1]);
});

test('only the extension dist and the current pack are readable', async () => {
  addPack('/home/me/zaphod', 'zaphod');
  configuration.set('agentCompanion.packPaths', ['/home/me/zaphod']);
  const { webview } = await resolvedView();

  const roots = (webview.options.localResourceRoots as Array<{ path: string }>).map(r => r.path);
  assert.ok(roots.includes('/ext/dist'));
  assert.equal(roots.length, 2, 'the other pack should not be exposed: ' + roots.join(', '));
});

test('sends the manifest with every image already resolved', async () => {
  const { webview } = await resolvedView();
  webview.posted.length = 0;
  (webview as never as { listener(message: unknown): void }).listener({ type: 'ready' });

  const show = webview.posted.find((m: never) => (m as { type: string }).type === 'show') as {
    pack: { id: string }; images: Record<string, string>;
  };
  assert.ok(show, 'a show message should follow ready');
  assert.equal(show.pack.id, 'marvin');

  // Every image the pack names, and nothing else.
  assert.deepEqual(Object.keys(show.images).sort(), [
    'attention.webp', 'complete.webp', 'right.blink.webp', 'right.webp',
    'surprise.webp', 'working.webp',
  ]);
  for (const url of Object.values(show.images)) {
    assert.match(url, /^https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/ext\/packs\/marvin\//);
  }
});

test('a view that appears later is told the state the session is already in', async () => {
  const { provider, webview } = await resolvedView();
  provider.setState('working');
  provider.setSleeping(true);

  webview.posted.length = 0;
  (webview as never as { listener(message: unknown): void }).listener({ type: 'ready' });

  const types = webview.posted.map((m: never) => (m as { type: string }).type);
  assert.deepEqual(types, ['show', 'state', 'sleep']);
  assert.equal((webview.posted[1] as { state: string }).state, 'working');
  assert.equal((webview.posted[2] as { sleeping: boolean }).sleeping, true);
});

test('says so plainly when there are no packs at all', async () => {
  const output = { info() {}, warn() {}, error() {} } as never;
  const provider = new CompanionViewProvider(EXTENSION, output);
  const webview = fakeWebview();
  await provider.resolveWebviewView(
    { webview, onDidDispose() { return { dispose() {} }; } } as never);

  const error = webview.posted.find((m: never) => (m as { type: string }).type === 'error') as
    { message: string };
  assert.ok(error);
  assert.match(error.message, /No character packs were found/);
});

// --- activation -------------------------------------------------------------

test('activating registers a provider for every contributed view', async () => {
  const { activate } = await import('../src/host/extension.js');
  const registered: string[] = [];
  const disposables: unknown[] = [];

  const stub = await import('./vscode-stub.js');
  const original = stub.window.registerWebviewViewProvider;
  (stub.window as { registerWebviewViewProvider: unknown }).registerWebviewViewProvider =
    (id: string, _provider: unknown, options: { webviewOptions?: { retainContextWhenHidden?: boolean } }) => {
      registered.push(id);
      // Rebuilding on every tab switch would reload the pack and visibly restart.
      assert.equal(options?.webviewOptions?.retainContextWhenHidden, true,
        id + ' should keep its context when hidden');
      return { dispose() {} };
    };

  try {
    activate({ extensionUri: EXTENSION, subscriptions: disposables } as never);
  } finally {
    (stub.window as { registerWebviewViewProvider: unknown }).registerWebviewViewProvider = original;
  }

  assert.deepEqual(registered, [
    'agentCompanion.sidebarView',
    'agentCompanion.panelView',
    'agentCompanion.explorerView',
  ]);
  assert.ok(disposables.length >= registered.length, 'everything registered must be disposable');
});

declare const __EXTENSION_ROOT__: string;

test('the manifest contributes exactly the views the code registers', async () => {
  const { VIEW_IDS } = await import('../src/host/companion-view.js');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const manifestJson = JSON.parse(
    readFileSync(join(__EXTENSION_ROOT__, 'package.json'), 'utf8'));

  const contributed = Object.values(manifestJson.contributes.views as Record<string, Array<{
    id: string; type: string; when: string;
  }>>).flat();

  assert.deepEqual(
    contributed.map(view => view.id).sort(),
    [...VIEW_IDS].sort(),
    'package.json and VIEW_IDS have drifted');

  for (const view of contributed) {
    assert.equal(view.type, 'webview', view.id + ' must be declared as a webview view');
    assert.match(view.when, /config\.agentCompanion\.position ==/,
      view.id + ' should only appear for its configured position');
  }

  // Exactly one position is valid at a time, so the when clauses must be
  // mutually exclusive and must cover every value the setting allows.
  const positions = manifestJson.contributes.configuration
    .properties['agentCompanion.position'].enum as string[];
  const guarded = contributed.map(view => /'([a-z]+)'/.exec(view.when)?.[1]);
  assert.deepEqual([...guarded].sort(), [...positions].sort(),
    'every position needs a view, and no position may have two');
});

// --- watching the editor ----------------------------------------------------

/** Activate with the stub's emitters live, and hand back the view. */
async function activated() {
  addPack('/ext/packs/marvin', 'marvin');
  const stub = await import('./vscode-stub.js');
  const { activate } = await import('../src/host/extension.js');

  const webview = stub.fakeWebview();
  const view = { webview, onDidDispose() { return { dispose() {} }; } } as never;

  let captured: { resolveWebviewView(v: never): Promise<void> } | undefined;
  const original = stub.window.registerWebviewViewProvider;
  (stub.window as { registerWebviewViewProvider: unknown }).registerWebviewViewProvider =
    (_id: string, provider: never) => { captured ??= provider; return { dispose() {} }; };
  try {
    activate({ extensionUri: EXTENSION, subscriptions: [] } as never);
  } finally {
    (stub.window as { registerWebviewViewProvider: unknown }).registerWebviewViewProvider = original;
  }

  await captured!.resolveWebviewView(view);
  webview.posted.length = 0;
  return { webview, stub };
}

/** Wait past the host's 150ms debounce. */
const settle = () => new Promise(resolve => setTimeout(resolve, 220));

const editorAt = (line: number, column: number, first: number, last: number) => ({
  textEditor: {
    selection: { active: { line, character: column } },
    visibleRanges: [{ start: { line: first }, end: { line: last } }],
  },
});

test('the gaze follows the caret, debounced', async () => {
  const { webview, stub } = await activated();

  // A burst of keystrokes should produce one look, not one per event.
  for (let i = 0; i < 10; i++) stub.emit('selection', editorAt(2, 4, 0, 40));
  await settle();

  const looks = webview.posted.filter((m: never) => (m as { type: string }).type === 'look');
  assert.equal(looks.length, 1, 'ten selection changes should collapse to one look');
  assert.equal((looks[0] as { direction: string }).direction, 'up_left');
});

test('scrolling moves the gaze too, not just typing', async () => {
  const { webview, stub } = await activated();
  stub.emit('visibleRanges', editorAt(38, 90, 0, 40));
  await settle();

  const look = webview.posted.find((m: never) => (m as { type: string }).type === 'look');
  assert.equal((look as { direction: string }).direction, 'down_right');
});

test('the caret in the middle of the view sends nothing at all', async () => {
  const { webview, stub } = await activated();
  stub.emit('selection', editorAt(20, 50, 0, 40));
  await settle();
  assert.equal(webview.posted.filter((m: never) => (m as { type: string }).type === 'look').length, 0);
});

test('turning followCaret off stops it', async () => {
  const { webview, stub } = await activated();
  stub.configuration.set('agentCompanion.followCaret', false);

  stub.emit('selection', editorAt(2, 4, 0, 40));
  await settle();
  assert.equal(webview.posted.filter((m: never) => (m as { type: string }).type === 'look').length, 0);
});

test('an editor with nothing visible is ignored rather than throwing', async () => {
  const { webview, stub } = await activated();
  stub.emit('selection', { textEditor: { selection: { active: { line: 0, character: 0 } }, visibleRanges: [] } });
  stub.emit('activeEditor', undefined);
  await settle();
  assert.equal(webview.posted.filter((m: never) => (m as { type: string }).type === 'look').length, 0);
});

test('he sleeps when the window loses focus and wakes when it returns', async () => {
  const { webview, stub } = await activated();

  stub.emit('windowState', { focused: false });
  const asleep = webview.posted.find((m: never) => (m as { type: string }).type === 'sleep');
  assert.equal((asleep as { sleeping: boolean }).sleeping, true);

  webview.posted.length = 0;
  stub.emit('windowState', { focused: true });
  const awake = webview.posted.find((m: never) => (m as { type: string }).type === 'sleep');
  assert.equal((awake as { sleeping: boolean }).sleeping, false);
});

test('the view is told whether to doze, so the setting reaches the player', async () => {
  configuration.set('agentCompanion.autoSleep', false);
  const { webview } = await resolvedView();
  (webview as never as { listener(message: unknown): void }).listener({ type: 'ready' });

  const show = webview.posted.find((m: never) => (m as { type: string }).type === 'show') as
    { settings: { autoSleep: boolean } };
  assert.equal(show.settings.autoSleep, false);
});
