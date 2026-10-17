// The client-side operator facing (render/facing.js): the model turns toward the target an operator is attacking, and the
// direction rule is the one the owner asked for (vertical only past ~60°; a target hugging the unit reads as vertical).
// `node --test test/facingRender.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { facingDir, facingToward, FACING_FLIP_S, FACING_HOLD_S } from '../public/js/render/facing.js';

test('a target straight above is faced UP, straight right is RIGHT', () => {
  assert.equal(facingDir(0, 1), 'UP');
  assert.equal(facingDir(0, -1), 'DOWN');
  assert.equal(facingDir(1, 0), 'RIGHT');
  assert.equal(facingDir(-1, 0), 'LEFT');
});

test('only past ~60° does a target count as above / below (a 45° diagonal stays level)', () => {
  assert.equal(facingDir(1, 1), 'RIGHT', '45° up-right keeps the model level');
  assert.equal(facingDir(1, 1.9), 'UP', '~62° turns it up');
  assert.equal(facingDir(-2, 1), 'LEFT');
  assert.equal(facingDir(0.2, 1), 'UP');
});

test('a target hugging the unit (inside a tile) reads as vertical as soon as it is as high as it is wide', () => {
  assert.equal(facingDir(0.4, 0.4), 'UP', 'a blocked enemy at the up-right corner is looked up at');
  assert.equal(facingDir(0.6, 0.2), 'RIGHT', 'a blocked enemy mostly to the right stays level');
  assert.equal(facingDir(0.4, -0.4), 'DOWN');
});

test('a target on the unit´s own tile has no direction', () => {
  assert.equal(facingDir(0, 0), null);
  assert.equal(facingDir(1e-9, -1e-9), null);
  assert.equal(facingToward({ x: 3, y: 4 }, { x: 3, y: 4 }), null);
  assert.equal(facingToward(null, { x: 1, y: 1 }), null);
});

test('facingToward subtracts the two positions', () => {
  assert.equal(facingToward({ x: 4.5, y: 9.5 }, { x: 4.5, y: 10.4 }), 'UP');
  assert.equal(facingToward({ x: 4.5, y: 9.5 }, { x: 7.2, y: 9.6 }), 'RIGHT');
  assert.equal(facingToward({ x: 4.5, y: 9.5 }, { x: 4.6, y: 8.2 }), 'DOWN');
});

test('the shipped timings: a 0.05 s flip and a 3 s hold', () => {
  assert.equal(FACING_FLIP_S, 0.05);
  assert.equal(FACING_HOLD_S, 3);
});
