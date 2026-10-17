// Attack-clip pacing (render/attackRate.js). The symptom this fixed: at the start of a battle an operator's attack clip
// ran in slow motion. The clip is stretched over the unit's attack interval, the view started from the operator's BASE
// record (`bat × 100 / aspd`) while the battle had already buffed it (宴: 1.20 s guessed vs 0.74 s real = a 62 % slow
// clip), and only the measured gap between attacks pulled it right. The snapshot's own interval now starts the view.
// `node --test test/attackRate.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampAtkInterval, startAtkInterval, nextAtkInterval, ATK_DEFAULT_S, ATK_MAX_S, ATK_MIN_S,
} from '../public/js/render/attackRate.js';

test('the snapshot interval wins over the base-record guess', () => {
  assert.equal(startAtkInterval(0.74, 1.2), 0.74, '宴 in its stance: the sim says 0.74, the record guessed 1.2');
  assert.equal(startAtkInterval(1, 1.2), 1);
  assert.equal(startAtkInterval(undefined, 1.3), 1.3, 'no snapshot value (an older field): the record guess is used');
  assert.equal(startAtkInterval(0, null), ATK_DEFAULT_S, 'nothing known at all');
  assert.equal(startAtkInterval(NaN, 2), 2);
});

test('intervals are clamped to what the renderer can show', () => {
  assert.equal(clampAtkInterval(0.01), ATK_MIN_S);
  assert.equal(clampAtkInterval(99), ATK_MAX_S);
  assert.equal(clampAtkInterval(1.04), 1.04);
  assert.equal(clampAtkInterval(NaN), ATK_DEFAULT_S);
  assert.equal(clampAtkInterval(-2), ATK_DEFAULT_S);
});

test('the first measured gap replaces the estimate outright', () => {
  const r = nextAtkInterval(1.2, 0.74, false);
  assert.equal(r.measured, true);
  assert.equal(r.interval, 0.74, 'no slow-motion ramp-in');
});

test('later gaps smooth 60/40 into the measurement', () => {
  const r = nextAtkInterval(0.74, 0.84, true);
  assert.equal(r.measured, true);
  assert.equal(Math.round(r.interval * 1000) / 1000, Math.round((0.74 * 0.6 + 0.84 * 0.4) * 1000) / 1000);
});

test('a stall is not a rhythm', () => {
  for (const d of [0.01, 0.05, 6, 30, NaN, undefined]) {
    const r = nextAtkInterval(1.1, d, true);
    assert.equal(r.measured, false, `gap ${d} is ignored`);
    assert.equal(r.interval, 1.1);
  }
});
