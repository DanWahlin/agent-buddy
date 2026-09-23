import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyCutout } from '../dist/index.js';

/**
 * Build an RGBA buffer from a picture, where '.' is the backdrop, '#' is solid
 * character, and 'd' is a dark pixel that is part of the character - a seam or
 * a shadowed interior, which is exactly what a brightness threshold gets wrong.
 */
function scene(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => {
    [...row].forEach((glyph, x) => {
      const at = (y * width + x) * 4;
      const value = glyph === '.' ? 0 : glyph === 'd' ? 8 : 200;
      data[at] = data[at + 1] = data[at + 2] = value;
      data[at + 3] = 255;
    });
  });
  return { data, width, height };
}

const alphaAt = (scene, x, y) => scene.data[(y * scene.width + x) * 4 + 3];

test('the backdrop is removed and the character kept', () => {
  const s = scene([
    '........',
    '..####..',
    '.######.',
    '.######.',
    '..####..',
    '........',
  ]);
  const removed = applyCutout(s.data, s.width, s.height, { feather: 0 });

  assert.equal(alphaAt(s, 0, 0), 0, 'a corner is backdrop');
  assert.equal(alphaAt(s, 3, 2), 255, 'the middle is character');
  assert.ok(removed > 0.4 && removed < 0.7, 'removed ' + removed);
});

test('a dark interior is kept, which a brightness threshold would eat', () => {
  // Marvin's darkest interior pixel is (14,19,19) against a (0,0,0) backdrop,
  // so this is the case that decides the whole approach.
  const s = scene([
    '........',
    '..####..',
    '.##dd##.',
    '.##dd##.',
    '..####..',
    '........',
  ]);
  applyCutout(s.data, s.width, s.height, { feather: 0 });

  assert.equal(alphaAt(s, 3, 2), 255, 'a dark seam inside the head stays opaque');
  assert.equal(alphaAt(s, 4, 3), 255);
  assert.equal(alphaAt(s, 0, 0), 0, 'while the backdrop still goes');
});

test('an enclosed dark hollow is kept, since nothing reaches it from outside', () => {
  const s = scene([
    '........',
    '.######.',
    '.#....#.',
    '.#....#.',
    '.######.',
    '........',
  ]);
  applyCutout(s.data, s.width, s.height, { feather: 0 });

  assert.equal(alphaAt(s, 3, 2), 255, 'the hollow is walled off from the edges');
  assert.equal(alphaAt(s, 0, 0), 0);
});

test('a backdrop that reaches the edge through a gap is removed', () => {
  const s = scene([
    '........',
    '.######.',
    '.#....#.',
    '.#......',
    '.######.',
    '........',
  ]);
  applyCutout(s.data, s.width, s.height, { feather: 0 });
  assert.equal(alphaAt(s, 3, 2), 0, 'the hollow now connects to outside');
});

test('feathering softens the silhouette without punching holes', () => {
  const s = scene([
    '........',
    '..####..',
    '.######.',
    '.######.',
    '..####..',
    '........',
  ]);
  applyCutout(s.data, s.width, s.height, { feather: 1 });

  const rim = alphaAt(s, 2, 1);
  assert.ok(rim > 0 && rim < 255, 'a rim pixel is partly transparent, got ' + rim);
  assert.ok(alphaAt(s, 3, 2) > 200, 'the interior stays essentially solid');
});

test('a character touching the edge is not flooded away', () => {
  const s = scene([
    '####',
    '####',
    '####',
    '####',
  ]);
  const removed = applyCutout(s.data, s.width, s.height, { feather: 0 });
  assert.equal(removed, 0);
  assert.equal(alphaAt(s, 0, 0), 255);
});

test('an entirely empty frame comes out entirely transparent', () => {
  const s = scene(['....', '....', '....']);
  assert.equal(applyCutout(s.data, s.width, s.height, { feather: 0 }), 1);
  assert.equal(alphaAt(s, 1, 1), 0);
});

test('the threshold decides what counts as backdrop', () => {
  const dim = scene(['dddd', 'd##d', 'dddd']);
  applyCutout(dim.data, dim.width, dim.height, { feather: 0, threshold: 4 });
  assert.equal(alphaAt(dim, 0, 0), 255, 'below the threshold, nothing is backdrop');

  const same = scene(['dddd', 'd##d', 'dddd']);
  applyCutout(same.data, same.width, same.height, { feather: 0, threshold: 16 });
  assert.equal(alphaAt(same, 0, 0), 0, 'above it, the dim border is backdrop');
});
