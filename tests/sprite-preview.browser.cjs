const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const runtime = path.resolve(`tests/.sprite-browser-runtime-${process.pid}`);
fs.mkdirSync(runtime, {recursive: true});
process.env.TMPDIR = runtime;
const baseURL = process.env.SPRITE_PREVIEW_URL || 'http://127.0.0.1:8765/sprite-preview.html';

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}, reducedMotion: 'reduce'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    await page.waitForFunction(() => !document.getElementById('play').disabled);
    assert.equal(await page.locator('#play').textContent(), 'Play', 'reduced motion starts paused');
    assert.equal(await page.locator('#error').isVisible(), false);
    assert.equal(await page.locator('#crossfade').isChecked(), false);
    assert.equal(await page.locator('[data-frame]').count(), 24);
    assert.equal(await page.locator('[data-direction]').count(), 8);
    assert.equal(await page.locator('#track option').count(), 9);
    await page.locator('[data-frame="11"]').click();
    assert.equal(await page.locator('#frame').textContent(), '12 / 24');
    assert.equal(await page.locator('#mode').textContent(), 'Explicit frame inspection');
    await page.locator('#track').selectOption('left');
    assert.match(await page.locator('#queue-status').textContent(), /Queued: left/);
    assert.equal(await page.locator('#frame').textContent(), '12 / 24', 'queued track does not jump');
    for (const direction of ['up_left', 'up_right', 'down_left', 'down_right']) {
      await page.locator(`[data-direction="${direction}"]`).click();
      assert.ok((await page.locator('#queue-status').textContent()).includes(direction.replaceAll('_', '-')));
      assert.equal(await page.locator('#frame').textContent(), '12 / 24', 'diagonal requests wait without jumping');
    }
    await page.locator('#duration').fill('0.8');
    await page.locator('#ease').uncheck();
    await page.locator('[data-speed="0.25"]').click();
    assert.equal(await page.locator('#frame').textContent(), '12 / 24', 'timing controls preserve inspection');
    await page.locator('#play').click();
    await page.waitForTimeout(40);
    await page.locator('#play').click();
    const resumed = Number((await page.locator('#frame').textContent()).split('/')[0]);
    assert.ok(Math.abs(resumed - 12) <= 1, `resume jumped to ${resumed}`);

    const result = await page.evaluate(() => {
      player.setPlaying(false); player.setAuto(false); player.setBlinks(false);
      player.queue.length = 0; player.inspect(0);
      player.setDuration(.8); player.setSpeed(1); player.setEased(true);
      player.setCycle(true); player.setPlaying(true);
      const centers = new Set(), seen = new Map(), hashes = new Map();
      let maxStep = 0, prior = 0, lastDirection = player.direction, turns = 0, previousPhase = player.phase;
      for (let i = 0; i < 24000 && turns < 16; i++) {
        player.update(i % 97 === 0 ? 90 : 1 / 60);
        maxStep = Math.max(maxStep, Math.abs(player.index - prior));
        if (lastDirection !== player.direction && (prior !== 0 || player.index !== 0)) {
          throw new Error('Direction changed away from shared center');
        }
        if (player.index !== prior || player.direction !== lastDirection || i === 0) {
          draw();
          if (document.getElementById('source').textContent !== 'Azure GPT Image') {
            throw new Error(`Non-generated artwork still active for ${player.direction}`);
          }
          const key = `${player.direction}:${player.index}`, pixels = screen.toDataURL();
          if (hashes.has(key) && hashes.get(key) !== pixels) throw new Error(`Non-exact return: ${key}`);
          hashes.set(key, pixels);
          if (player.index === 0) centers.add(pixels);
          if (!seen.has(player.direction)) seen.set(player.direction, new Set());
          seen.get(player.direction).add(player.index);
        }
        if (player.phase === 'center' && previousPhase === 'return') turns++;
        prior = player.index; lastDirection = player.direction; previousPhase = player.phase;
      }
      player.setPlaying(false); draw();
      return {maxStep, centers: centers.size, tracks: [...seen].map(([name, frames]) => [name, frames.size]), turns};
    });
    assert.equal(result.maxStep, 1);
    assert.equal(result.centers, 1, 'all rendered center frames are pixel-identical');
    assert.equal(result.turns, 16);
    assert.deepEqual(result.tracks.map(([name]) => name).sort(),
      ['down', 'down_left', 'down_right', 'left', 'right', 'up', 'up_left', 'up_right']);
    for (const [direction, count] of result.tracks) {
      assert.equal(count, direction === 'up' || direction === 'down' ? 12 : 24);
    }
    const occlusion = await page.evaluate(() => {
      player.setCycle(false);
      player.request('down');
      player.setPlaying(true);
      for (let i = 0; i < 2000 && player.direction !== 'down'; i++) player.update(1 / 60);
      if (player.direction !== 'down' || player.index !== 0) throw new Error('Failed to queue downward inspection at center');
      player.setPlaying(false);
      const results = [];
      for (const [index, frame] of manifest.directions[player.direction].frames.entries()) {
        if (frame.blinkMaskState !== 'occluded-or-rim-clipped' && frame.eyesOccluded !== true) continue;
        player.inspect(index); draw();
        results.push(document.getElementById('eyes').textContent);
      }
      return results;
    });
    assert.ok(occlusion.length > 0, 'published downward track exposes occlusion metadata');
    assert.ok(occlusion.every(value => value === 'Occluded / off'));

    const blink = await page.evaluate(() => {
      player.setCycle(false); player.inspect(0); draw();
      const original = screen.toDataURL(), index = player.index, levels = [0];
      player.requestBlink(); player.setPlaying(true);
      for (let i = 0; i < 100; i++) {
        player.update(1 / 60); draw();
        if (player.index !== index) throw new Error('Deliberately stationary center pose moved');
        if (levels.at(-1) !== player.blinkLevel) levels.push(player.blinkLevel);
        if (i > 0 && player.blinkPhase === 'idle') break;
      }
      player.setPlaying(false);
      return {levels, exact: original === screen.toDataURL()};
    });
    assert.deepEqual(blink.levels, [0, 1, 2, 3, 4, 3, 2, 1, 0]);
    assert.equal(blink.exact, true);
    const movingBlink = await page.evaluate(() => {
      player.request('right'); player.setPlaying(true);
      for (let i = 0; i < 2000 && player.index < 8; i++) player.update(1 / 60);
      const initial = player.index;
      player.requestBlink();
      let moving = false, exact = false;
      for (let i = 0; i < 100; i++) {
        player.update(1 / 60); draw();
        if (player.blinkLevel > 0 && player.index !== initial) moving = true;
        if (i > 0 && player.blinkPhase === 'idle') {
          const reopened = screen.toDataURL();
          lastSprite = null; draw();
          exact = reopened === screen.toDataURL() && player.blinkLevel === 0;
          break;
        }
      }
      player.inspect(10); draw();
      return {moving, exact};
    });
    assert.deepEqual(movingBlink, {moving: true, exact: true});
    const unblended = await page.evaluate(() => {
      player.inspect(8);
      player.inspecting = false;
      player.phase = 'out';
      player.target = 23;
      player.progress = .5;
      draw();
      return {state: JSON.stringify(player), image: screen.toDataURL()};
    });
    await page.locator('#crossfade').check();
    const crossfade = await page.evaluate(before => {
      const expectedPixels = index => {
        const canvas = document.createElement('canvas');
        canvas.width = screen.width; canvas.height = screen.height;
        const ctx = canvas.getContext('2d', {alpha: false});
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        const width = 396, height = width * manifest.height / manifest.width;
        ctx.drawImage(tracks[player.direction][index][player.blinkLevel],
          (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const a = expectedPixels(8), b = expectedPixels(9);
      const actual = context.getImageData(0, 0, screen.width, screen.height).data;
      let maxError = 0;
      for (let i = 0; i < actual.length; i++) {
        maxError = Math.max(maxError, Math.abs(actual[i] - (a[i] + b[i]) / 2));
      }
      const frozen = screen.toDataURL();
      for (let i = 0; i < 20; i++) { player.update(1); draw(); }
      return {maxError, unchangedTimeline: JSON.stringify(player) === before.state,
        changedPixels: frozen !== before.image, frozen: screen.toDataURL() === frozen,
        alphaRestored: context.globalAlpha === 1};
    }, unblended);
    assert.ok(crossfade.maxError <= 1, 'rendered pixels must be the actual 50/50 adjacent-frame blend');
    assert.equal(crossfade.unchangedTimeline, true);
    assert.equal(crossfade.changedPixels, true);
    assert.equal(crossfade.frozen, true);
    assert.equal(crossfade.alphaRestored, true);
    await page.locator('#crossfade').uncheck();
    assert.equal(await page.evaluate(() => screen.toDataURL()), unblended.image);
    await page.locator('#crossfade').check();
    const inspected = await page.evaluate(() => {
      player.inspect(10); draw();
      return {sample: player.sample(true), image: screen.toDataURL()};
    });
    assert.deepEqual(inspected.sample, {from: 10, to: 10, mix: 0});
    await page.locator('#crossfade').uncheck();
    assert.equal(await page.evaluate(() => screen.toDataURL()), inspected.image);
    const unchangedMutations = await page.evaluate(() => {
      player.setPlaying(false); draw();
      const observer = new MutationObserver(() => {});
      observer.observe(document.body, {subtree: true, childList: true, attributes: true, characterData: true});
      for (let i = 0; i < 120; i++) draw();
      const count = observer.takeRecords().length;
      observer.disconnect();
      return count;
    });
    assert.equal(unchangedMutations, 0, 'unchanged poses must not repeatedly rewrite the controls or telemetry');
    const download = page.waitForEvent('download');
    await page.locator('#snapshot').click();
    assert.match((await download).suggestedFilename(), /^copilot-\w+-frame-11-eyes-0\.png$/);
    await page.locator('#notes').fill('Browser test feedback');
    await page.locator('#copy').click();
    await page.waitForFunction(() => document.getElementById('feedback-status').textContent.length > 0);
    assert.match(await page.locator('#feedback-status').textContent(), /Copied|Clipboard unavailable/);
    await page.locator('#play').click();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, value: true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.locator('#play').textContent(), 'Play');
    assert.deepEqual(errors, []);

    const missing = await browser.newPage();
    await missing.route('**/characters/copilot/sprites/*-blink-4.png*', route => route.fulfill({status: 404, body: 'missing'}));
    await missing.goto(baseURL);
    await missing.locator('#error').waitFor({state: 'visible'});
    assert.match(await missing.locator('#error').textContent(), /Cannot load.*No substitute sprites/s);
    assert.equal(await missing.locator('#play').isDisabled(), true);
    console.log(JSON.stringify({result, blink, movingBlink, crossfade, ui: 'passed', missingAssets: 'explicit error'}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(runtime, {recursive: true, force: true}));
