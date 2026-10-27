const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const runtime = path.resolve(`tests/.character-browser-runtime-${process.pid}`);
fs.mkdirSync(runtime, {recursive: true});
process.env.TMPDIR = runtime;
const base = process.env.CHARACTER_PREVIEW_URL || 'http://127.0.0.1:8765';
const builtIn = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'characters', 'built-in.json'), 'utf8'));

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}, reducedMotion: 'reduce', hasTouch: true});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/character-preview.html`);
    await page.waitForFunction(() => !document.getElementById('play').disabled);
    assert.equal(await page.locator('#play').textContent(), 'Play');
    assert.equal(await page.locator('#connection').textContent(), 'Paused');
    assert.equal(await page.locator('[data-mode]').count(), 6);
    assert.equal(await page.locator('input[name="character"]').count(), builtIn.length);
    assert.equal(await page.locator('#error').isVisible(), false);
    const fullArt = (await page.locator('#assets').textContent()).startsWith('All 13');
    const initial = await page.locator('#screen').evaluate(canvas => canvas.toDataURL());
    // Compare the browser's actual pixels to a separate native session with the same seed.
    const parity = await page.evaluate(async () => {
      const session = crypto.randomUUID();
      try {
        const response = await fetch('/api/character/frame', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({session, delta: 0, playing: false}),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const pixels = document.getElementById('screen').getContext('2d').getImageData(27, 0, 412, 466).data;
        for (let i = 0, j = 0; i < bytes.length; i += 2, j += 4) {
          const word = (bytes[i] << 8) | bytes[i + 1];
          const expected = [Math.round(((word >> 11) & 31) * 255 / 31),
            Math.round(((word >> 5) & 63) * 255 / 63), Math.round((word & 31) * 255 / 31), 255];
          for (let channel = 0; channel < 4; channel++)
            if (pixels[j + channel] !== expected[channel]) return false;
        }
        return bytes.length === 383984;
      } finally {
        await fetch('/api/character/close', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({session})});
      }
    });
    assert.equal(parity, true, 'Canvas exactly decodes native RGB565 output');
    const openClawResponse = page.waitForResponse(res => res.url().endsWith('/api/character/frame')
      && res.request().postDataJSON().character === 'openclaw');
    await page.locator('.character-picker label', {hasText: 'OpenClaw'}).click();
    await openClawResponse;
    const openClaw = await page.locator('#screen').evaluate(canvas => canvas.toDataURL());
    assert.notEqual(openClaw, initial, 'OpenClaw selection changes the native sprite pixels');
    assert.equal(await page.locator('#assets').textContent(),
      'All 13 OpenClaw tracks are pre-rendered 3D sprites, including both attention tilts.');
    assert.equal(await page.locator('#character').getAttribute('aria-label'), 'Surprise OpenClaw');
    await page.screenshot({path: 'build/character-openclaw.png', fullPage: true});
    const grokResponse = page.waitForResponse(res => res.url().endsWith('/api/character/frame')
      && res.request().postDataJSON().character === 'grok');
    await page.locator('.character-picker label', {hasText: 'Grok'}).click();
    await grokResponse;
    const grok = await page.locator('#screen').evaluate(canvas => canvas.toDataURL());
    assert.notEqual(grok, initial, 'Grok selection changes the native sprite pixels');
    assert.notEqual(grok, openClaw, 'Grok and OpenClaw show different pixels');
    assert.equal(await page.locator('#assets').textContent(),
      'All 13 Grok tracks are rendered offline from a sphere with pill-eye decals.');
    assert.equal(await page.locator('#character').getAttribute('aria-label'), 'Surprise Grok');
    const copilotResponse = page.waitForResponse(res => res.url().endsWith('/api/character/frame')
      && res.request().postDataJSON().character === 'copilot');
    await page.locator('.character-picker label', {hasText: 'Copilot'}).click();
    await copilotResponse;
    assert.equal(await page.locator('#screen').evaluate(canvas => canvas.toDataURL()), initial);
    for (let mode = 1; mode <= 5; mode++) {
      const response = page.waitForResponse(res => res.url().endsWith('/api/character/frame')
        && res.request().postDataJSON().mode === mode);
      await page.locator(`[data-mode="${mode}"]`).click();
      await response;
      if (fullArt) {
        await page.waitForFunction(value =>
          document.querySelector(`[data-mode="${value}"]`).getAttribute('aria-pressed') === 'true', mode);
        assert.equal(await page.locator('#visible').textContent(), 'Idle', 'paused head does not jump');
      } else {
        await page.waitForFunction(() =>
          document.getElementById('error').textContent.includes('Expression assets unavailable'));
        assert.equal(await page.locator('#screen').evaluate(canvas => canvas.toDataURL()), initial);
      }
    }
    await page.locator('[data-mode="0"]').click();
    await page.waitForFunction(() => document.getElementById('error').hidden);
    await page.locator('#character').focus();
    await page.keyboard.press('Enter');
    if (fullArt) {
      await page.waitForFunction(() => document.getElementById('pending').textContent === 'Surprise');
    } else {
      await page.waitForFunction(() => !document.getElementById('error').hidden);
    }
    await page.keyboard.press('1');
    await page.waitForFunction(() => document.getElementById('error').hidden);
    for (const action of [() => page.keyboard.press('Space'), () => page.locator('#character').tap()]) {
      await page.locator('#character').focus();
      const response = page.waitForResponse(res => res.url().endsWith('/api/character/frame')
        && res.request().postDataJSON().mode === 1);
      await action();
      await response;
      await page.keyboard.press('1');
      await page.waitForFunction(() => document.getElementById('error').hidden
        && document.getElementById('pending').textContent === 'Idle');
    }
    await page.locator('#play').click();
    await page.waitForFunction(() => document.getElementById('connection').textContent.startsWith('Live'));
    if (fullArt) {
      await page.locator('[data-mode="4"]').click();
      await page.waitForFunction(() => document.getElementById('visible').textContent === 'Needs attention');
      await page.waitForFunction(() => document.getElementById('pose').textContent.startsWith('11:23'));
      await page.waitForFunction(() => document.getElementById('pose').textContent.startsWith('12:23'));
      assert.equal(await page.locator('#visible').textContent(), 'Needs attention');
      assert.equal(await page.locator('#pending').textContent(), 'Needs attention');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.getElementById('connection').textContent === 'Paused');
      await page.screenshot({path: 'build/character-attention-alternate.png', fullPage: true});
      await page.locator('#play').click();
      await page.locator('#character').click();
      await page.waitForFunction(() => document.getElementById('visible').textContent === 'Surprise');
      await page.waitForFunction(() => document.getElementById('visible').textContent === 'Needs attention',
        null, {timeout: 2000});
      await page.locator('[data-mode="3"]').click();
      await page.waitForFunction(() => document.getElementById('visible').textContent === 'Complete');
      await page.waitForFunction(() => document.getElementById('visible').textContent === 'Idle');
      for (const [mode, name, label] of [
        [2, 'working', 'Working'], [4, 'attention', 'Needs attention'],
        [5, 'sleep', 'Sleeping'], [1, 'surprise', 'Surprise'], [3, 'complete', 'Complete'],
      ]) {
        if (mode === 1) await page.locator('#speed').selectOption('0.25');
        await page.locator(`[data-mode="${mode}"]`).click();
        await page.waitForFunction(({label, mode}) => {
          const index = Number(document.getElementById('pose').textContent.split(':')[1].split('/')[0]);
          const blink = Number(document.getElementById('pose').textContent.split('/')[1]);
          return document.getElementById('visible').textContent === label
            && (mode === 1 ? index >= 3 && index <= 7 : mode === 5 ? blink === 4 : index >= 21);
        }, {label, mode});
        await page.locator('#play').click();
        await page.waitForFunction(() => document.getElementById('connection').textContent === 'Paused');
        await page.waitForTimeout(80);
        await page.screenshot({path: `build/character-${name}.png`, fullPage: true});
        if (mode === 1) await page.locator('#speed').selectOption('1');
        await page.locator('#play').click();
      }
      await page.waitForFunction(() => document.getElementById('visible').textContent === 'Idle');
    }
    await page.waitForTimeout(1200);
    await page.locator('#play').click();
    await page.waitForTimeout(100);
    const paused = await page.locator('#screen').evaluate(canvas => canvas.toDataURL());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#screen').evaluate(canvas => canvas.toDataURL()), paused);
    assert.equal(await page.locator('#connection').textContent(), 'Paused');
    await page.screenshot({path: 'build/character-preview.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path: 'build/character-preview-mobile.png', fullPage: true});
    if (fullArt) {
      await page.goto(`${base}/character-preview.html?character=openclaw&mode=working`);
      await page.waitForFunction(() => !document.getElementById('play').disabled);
      assert.equal(await page.locator('input[value="openclaw"]').isChecked(), true);
      assert.equal(await page.locator('#pending').textContent(), 'Working');
      await page.goto(`${base}/sprite-preview.html`);
      for (const mode of ['surprise', 'working', 'complete', 'attention', 'sleep']) {
        assert.equal(await page.locator(`a[href="/character-preview.html?mode=${mode}"]`).count(), 1);
      }
      await page.locator('a[href="/character-preview.html?mode=working"]').click();
      await page.waitForFunction(() => document.getElementById('pending').textContent === 'Working');
      await page.locator('#speed').focus();
      await page.keyboard.press('1');
      assert.equal(await page.locator('#pending').textContent(), 'Working', 'speed shortcuts do not change modes');
      await page.locator('#speed').selectOption('0.25');
      const slowFrame = page.waitForRequest(request => request.url().endsWith('/api/character/frame')
        && request.postDataJSON().delta > 0);
      await page.locator('#play').click();
      const delta = (await slowFrame).postDataJSON().delta;
      assert.ok(delta <= 1 / 120, 'quarter speed scales the native animation clock');
      await page.locator('#play').click();
      await page.goto(`${base}/character-preview.html`);
      await page.waitForFunction(() => !document.getElementById('play').disabled);
      assert.equal(await page.locator('#wave').isEnabled(), true);
      const beforeWave = await page.locator('#screen').evaluate(canvas => canvas.toDataURL());
      const waveRequest = page.waitForRequest(request => request.url().endsWith('/api/character/frame')
        && request.postDataJSON().direction === 0);
      await page.locator('#wave').click();
      const wavePayload = (await waveRequest).postDataJSON();
      assert.equal(wavePayload.character, 'openclaw');
      assert.equal(await page.locator('input[value="openclaw"]').isChecked(), true);
      assert.equal(new URL(page.url()).searchParams.get('character'), 'openclaw');
      await page.waitForFunction(() => {
        const [direction, index] = document.getElementById('pose').textContent.split(' / ')[0].split(':').map(Number);
        return direction === 0 && index >= 8;
      });
      assert.notEqual(await page.locator('#screen').evaluate(canvas => canvas.toDataURL()), beforeWave,
        'Preview wave visibly changes the native framebuffer');
      await page.reload();
      await page.waitForFunction(() => !document.getElementById('play').disabled);
      assert.equal(await page.locator('input[value="openclaw"]').isChecked(), true,
        'Character Lab preserves the selected character across reloads');
    }
    assert.deepEqual(errors, []);
    console.log(`Native character browser controls, RGB565 parity, pause and mobile layout passed (${fullArt ? 13 : 8} tracks)`);
  } finally {
    await browser.close();
    fs.rmSync(runtime, {recursive: true, force: true});
  }
})().catch(error => {
  fs.rmSync(runtime, {recursive: true, force: true});
  console.error(error); process.exitCode = 1;
});
