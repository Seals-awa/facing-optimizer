// Attack-clip timing (render/spine.js windUpPlan) — the fix for "the FIRST attack of a battle plays in slow motion".
//
// The clip is stretched over the unit's attack interval (`ts = loopDur / interval`, one loop per attack). With a real
// look-ahead that is right: the clip starts `lead` before the strike and its tail fills the gap to the next attack. With
// NO look-ahead — the first attack of a battle, a batch that arrived late, a model that was still loading — the clip was
// stretched just the same, so a slow caster's tail crawled: 惊蛰 is a 2.3 s caster with a 1 s Attack clip, i.e. 0.43×,
// and only the later, properly wound-up swings looked normal.
// Now a look-ahead below MIN_LEAD (0.05 s) means "no wind-up": the clip plays at its own speed (ts = 1).
// `node --test test/attackPlan.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { windUpPlan, MAX_WIND_SPEEDUP } from '../public/js/render/spine.js';

/** 惊蛰 (char_306_leizi): Attack clip 1 s, strike frame at 0.333 s, attack interval 2.3 s. */
const LEIZI = { loopDur: 1, hit: 0.333, interval: 2.3 };
const plan = (lead, o = LEIZI) => windUpPlan(o.loopDur, o.hit, o.interval, lead);

test('惊蛰 with no look-ahead (the first swing) plays the strike at the clip´s own speed', () => {
  const p = plan(0);
  assert.equal(p.ts, 1, 'not stretched over the 2.3 s interval');
  assert.equal(p.start, LEIZI.hit, 'starts at the strike frame');
  assert.equal(p.tsWind, 1);
  const tail = (LEIZI.loopDur - LEIZI.hit) / p.tsWind;
  assert.ok(tail < 0.7, `the tail is short (${tail.toFixed(2)} s) instead of the old 1.53 s crawl`);
});

test('a real look-ahead keeps the designed stretch (one loop ≈ one interval)', () => {
  const p = plan(1.5);
  assert.ok(Math.abs(p.ts - LEIZI.loopDur / LEIZI.interval) < 1e-6, 'ts = clip / interval');
  assert.equal(p.start, 0, 'starts from the top of the clip, the strike lands on time');
  assert.equal(p.tsWind, p.ts, 'no speed-up needed');
});

test('the look-ahead threshold is where the stretch stops', () => {
  assert.equal(plan(0.049).ts, 1, 'below MIN_LEAD: own speed');
  assert.ok(plan(0.06).ts < 1, 'at/above it: paced against the interval again');
});

test('a fast attacker is compressed, not slowed', () => {
  const p = windUpPlan(1, 0.4, 0.9, 1.5);       // 1 s clip, 0.9 s interval
  assert.ok(p.ts > 1, `ts > 1 (${p.ts})`);
  assert.equal(p.start, 0);
});

test('too much wind-up lost → the clip is sped up instead of starting late', () => {
  // 2 s clip, strike at 1.2 s, 3 s interval, only 0.3 s of look-ahead: starting at 1.0 s into the clip would throw the
  // wind-up away, so the speed grows (capped at MAX_WIND_SPEEDUP × ts) and the clip starts earlier
  const p = windUpPlan(2, 1.2, 3, 0.3);
  const ts = 2 / 3;
  assert.ok(Math.abs(p.ts - ts) < 1e-6);
  assert.ok(p.tsWind > p.ts && p.tsWind <= ts * MAX_WIND_SPEEDUP + 1e-9, `tsWind ${p.tsWind}`);
  assert.ok(p.start < 1.2, 'starts before the strike frame');
  assert.ok(Math.abs(p.start + 0.3 * p.tsWind - 1.2) < 1e-9, 'and reaches the strike frame exactly at the event');
});

test('the strike frame still lands on the event for every look-ahead that paces', () => {
  for (const lead of [0.1, 0.3, 0.6, 1.0, 1.5]) {
    const p = plan(lead);
    const reached = p.start + lead * p.tsWind;
    assert.ok(Math.abs(reached - LEIZI.hit) < 1e-6 || p.start === 0,
      `lead ${lead}: reaches ${reached.toFixed(3)} (or starts at the top)`);
  }
});
