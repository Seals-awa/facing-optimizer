// The attack interval the sim PUSHES to the clients when it changes (['rate', unitId, seconds], EV.RATE, sim
// snapshot.js noteAttackRates). The renderer stretches the attack clip over that interval (render/attackRate.js), so before
// this the clip was paced at the value from the unit's spawn until the view had measured two attacks by itself — 惊蛰's
// skill changing her interval mid-battle was the case: a few swings in a slightly wrong rhythm.
// `node --test test/attackRateEvents.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeBattle, enemyRec } from './helpers/battleHarness.js';

/** 惊蛰 (char_306_leizi, a slow caster) and one walker that comes into her range. */
function leiziBattle() {
  const h = makeBattle({
    units: [{ chessId: 'chess_char_1_03_a', row: 9, col: 6, dir: 'RIGHT' }],
    enemies: [{ key: 'w', time: 0, route: 0 }],
    defs: { enemies: { w: enemyRec({ key: 'w', hp: 400000, speed: 1, atk: 0 }) } },
    timeLimit: 60,
  });
  h.step();
  return h;
}

const rateEvents = (h, id) => h.events.filter((e) => e[0] === 'rate' && e[1] === id);
const rounded = (v) => Math.round(v * 100) / 100;

test('惊蛰 keeps her spawn interval and sends nothing while it does not change', () => {
  const h = leiziBattle();
  const u = h.unit('chess_char_1_03_a');
  assert.ok(u.s.interval > 2 && u.s.interval < 3, `a slow caster (${u.s.interval} s)`);
  h.run(3);
  assert.deepEqual(rateEvents(h, u.id), [], 'no change, no event');
});

test('an attack-speed change is pushed at once', () => {
  const h = leiziBattle();
  const u = h.unit('chess_char_1_03_a');
  const before = u.s.interval;
  h.b.addBuff(u, { key: 'test:haste', mods: { aspd: 100 } });   // +100 ASPD halves the interval
  h.run(0.2);
  const ev = rateEvents(h, u.id);
  assert.equal(ev.length, 1, 'exactly one event for one change');
  assert.equal(ev[0][2], rounded(u.s.interval), 'and it carries the sim interval');
  assert.ok(ev[0][2] < before, `faster than before (${before} → ${ev[0][2]})`);
});

test('removing the buff pushes the interval back', () => {
  const h = leiziBattle();
  const u = h.unit('chess_char_1_03_a');
  const buff = h.b.addBuff(u, { key: 'test:haste', mods: { aspd: 100 } });
  h.run(0.2);
  h.b.removeBuff(u, buff);
  h.run(0.2);
  const ev = rateEvents(h, u.id);
  assert.ok(ev.length >= 2, `one for the buff, one for its removal (${ev.length})`);
  assert.ok(ev[ev.length - 1][2] > ev[0][2], 'back to the slower rhythm');
  assert.equal(ev[ev.length - 1][2], rounded(u.s.interval));
});
