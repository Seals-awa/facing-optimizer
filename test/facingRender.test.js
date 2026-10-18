// Operator model facing (render/facing.js): the direction to draw an operator's model in for the target it is attacking.
// Display only — `dir` (the deploy direction that rotates the attack range and picks Front / Back) never moves.
// The direction test is the OFFICIAL one (the operator's rule, reconstructed from the client's four-direction chain):
// a too-close target (< 0.25 tiles) turns nothing, sideways past TOLERANCE + ADDON (0.45 tiles) is level, and only the
// narrow band straight above / below (taller than it is wide, within that band) is UP / DOWN.
// `node --test test/render/facing.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  facingDir, facingToward, FACING_TURN_S, HELD_FACING, FACING_TOLERANCE, FACING_ADDON, FACING_TOO_CLOSE, FACING_ZERO,
} from '../public/js/render/facing.js';

test('the official thresholds: TOLERANCE 0.2 / ADDON 0.25 / too close 0.25 / zero 0.01', () => {
  assert.equal(FACING_TOLERANCE, 0.2);
  assert.equal(FACING_ADDON, 0.25);
  assert.equal(FACING_TOO_CLOSE, 0.25);
  assert.equal(FACING_ZERO, 0.01);
});

test('a target straight above / below / left / right', () => {
  assert.equal(facingDir(0, 1), 'UP');
  assert.equal(facingDir(0, -1), 'DOWN');
  assert.equal(facingDir(1, 0), 'RIGHT');
  assert.equal(facingDir(-1, 0), 'LEFT');
});

test('sideways past TOLERANCE + ADDON (0.45 tiles) is level, however high the target is', () => {
  assert.equal(facingDir(0.45, 1), 'RIGHT', 'the edge of the band: level');
  assert.equal(facingDir(0.44, 1), 'UP', 'just inside it: the narrow up band');
  assert.equal(facingDir(1, 5), 'RIGHT', 'a steep shot far to the right is still level');
  assert.equal(facingDir(-2, 1), 'LEFT');
});

test('inside the band the vertical wins only when the target is taller than it is wide', () => {
  assert.equal(facingDir(0.2, 0.3), 'UP');
  assert.equal(facingDir(0.3, 0.05), 'RIGHT', 'wider than tall: level, not up');
  assert.equal(facingDir(0.2, 0.2), 'RIGHT', 'a square offset stays level');
  assert.equal(facingDir(0.1, -0.5), 'DOWN');
});

test('a target hugging the unit (< 0.25 tiles) has no direction at all', () => {
  assert.equal(facingDir(0, 0), null);
  assert.equal(facingDir(0.1, 0.2), null, '0.22 tiles away: too close to judge');
  assert.equal(facingDir(0.15, 0.15), null);
  assert.equal(facingDir(0, 0.2), null);
  // just outside: a direction again
  assert.equal(facingDir(0, 0.25), 'UP');
});

test('both offsets under 0.01 is no direction, and 0 never is', () => {
  assert.equal(facingDir(0.005, -0.005), null);
  assert.equal(facingDir(0, 0.01), null, 'still inside the too-close circle');
});

test('facingToward subtracts the two positions, and never throws on a missing one', () => {
  assert.equal(facingToward({ x: 4.5, y: 9.5 }, { x: 4.5, y: 10.4 }), 'UP');
  assert.equal(facingToward({ x: 4.5, y: 9.5 }, { x: 7.2, y: 9.6 }), 'RIGHT');
  assert.equal(facingToward({ x: 4.5, y: 9.5 }, { x: 4.6, y: 8.2 }), 'DOWN');
  assert.equal(facingToward({ x: 3, y: 4 }, { x: 3, y: 4 }), null);
  assert.equal(facingToward(null, { x: 1, y: 1 }), null);
  assert.equal(facingToward({ x: 0, y: 0 }, undefined), null);
  assert.equal(facingToward({ x: 0, y: 0 }, { x: 'a', y: 'b' }), null);
});

test('the turnaround and the held states', () => {
  assert.equal(FACING_TURN_S, 0.15, '换骨架 + 镜像 + 换动画 takes 0.15 s');
  assert.deepEqual(HELD_FACING, ['stun', 'sleep', 'freeze'], 'the states whose clip plays in the facing the model already has');
});
