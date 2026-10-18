// Attack-clip pacing through the REAL path (#729 review): the sim's own attack interval reaches the view and the actor.
//
//   server/sim/snapshot.js  unitInfo  → UnitInfo.atkInterval (s.interval with its buffs)
//   Server → client        b.snap / b.ev  ['rate', id, seconds] when a skill or a buff changed it
//   render/app/info.js     renderInfo keeps atkInterval            ← it used to drop it
//   render/app.js          spawn → new UnitView(info); 'rate' → view.setAtkInterval(seconds)
//   render/units.js        the view paces its attack clip over it; a paused unit keeps the known interval
//   render/spine.js        SpineActor.windUp / attack take that interval for the clip's time scale
//
// Covered: the first strike, a skill / buff change, a delayed batch, and attacking again after a stop.
// `node --test test/render/attack-pacing.test.js`
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { installFakePixi, fakeViewCtx } from './render/fakepixi.js';
import { presetCamera } from '../public/js/render/projection.js';
import { renderInfo } from '../public/js/render/app/info.js';
import { ATK_JUMP_TOLERANCE, ATK_DEFAULT_S, clampAtkInterval } from '../public/js/render/attackRate.js';
import { unitInfo } from '../server/sim/snapshot.js';
import * as SNAPSHOT from '../server/sim/snapshot.js';
const require_snapshot = () => SNAPSHOT;

let fake, UnitView;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../public/js/render/units.js'));
});
after(() => fake.restore());

const tick = () => new Promise((r) => setImmediate(r));
const cam = () => presetCamera('prep', { width: 1280, height: 720 });

function store() {
  const entry = {
    skel: '/s/front.skel', atlas: '/s/front.atlas',
    anims: { idle: 'Idle', attack: { loop: 'Attack' }, skill: { loop: 'Skill' }, deploy: 'Start' },
    animations: { Idle: 1, Attack: 1, Skill: 1, Start: 1 }, hits: { Attack: [0.4] },
  };
  return {
    picture: () => null, image: async () => null, hasBack: () => false,
    spineEntry: () => entry,
    spine: { acquire: async () => ({ animations: [{ name: 'Idle' }, { name: 'Attack' }, { name: 'Skill' }, { name: 'Start' }] }), release: () => {} },
  };
}

/** A view exactly as render/app.js builds it: through renderInfo(UnitInfo). */
async function view(unitInfoLike) {
  const info = renderInfo(unitInfoLike);
  const ctx = fakeViewCtx(fake.P, { assets: store(), cam });
  const v = new UnitView(ctx, info);
  await tick(); await tick();
  return v;
}

const unit = (extra = {}) => ({
  id: 1, kind: 'op', side: 'ally', defId: 'char_test', spine: 'char_test', name: 'test', tier: 1,
  x: 4, y: 9, facing: 1, maxHp: 1000, dir: 'RIGHT', bat: 1.2, aspd: 100, ...extra,
});

describe('the sim value reaches the view', () => {
  test('renderInfo keeps UnitInfo.atkInterval (it used to drop the field)', () => {
    const info = renderInfo(unit({ atkInterval: 0.75 }));
    assert.equal(info.atkInterval, 0.75);
    assert.equal(renderInfo(unit()).atkInterval, undefined, 'absent on the wire: stays undefined, no fake 0');
    assert.equal(renderInfo(unit({ atkInterval: 0 })).atkInterval, undefined);
  });

  test('a fresh view starts from the sim interval, not from the record guess', async () => {
    // the record guess would be bat * 100 / aspd = 1.2; the sim says a buff brought it to 0.5
    const v = await view(unit({ atkInterval: 0.5 }));
    assert.equal(v.atkInterval, 0.5);
    assert.equal(v.atkKnown, true);
    // and the actor the clip is played on uses it
    assert.equal(v.windUp(0.2, 'none'), true);
    assert.equal(Math.round(v.actor.interval * 1000) / 1000, 0.5);
  });

  test('without the field the view falls back to its record guess (an enemy, an old frame)', async () => {
    const v = await view(unit());
    assert.equal(v.atkKnown, false);
    assert.equal(v.atkInterval, clampAtkInterval(1.2));
  });
});

describe('a skill / buff change', () => {
  test("a 'rate' event paces the next swing and the actor", async () => {
    const v = await view(unit({ atkInterval: 1.2 }));
    v.setAtkInterval(0.35);                        // what app.js case 'rate' does
    assert.equal(v.atkInterval, 0.35);
    assert.equal(v.atkKnown, true);
    // a fast interval needs a shorter lead: the strike frame must still be ahead (windUpPlan)
    assert.equal(v.windUp(0.1, 'none'), true);
    assert.equal(Math.round(v.actor.interval * 1000) / 1000, 0.35, 'the clip is paced over the new interval');
  });

test('the sim emits rate only when the interval changed (noteAttackRates)', () => {
    const { noteAttackRates } = require_snapshot();
    const evs = [];
    // the live install's own push: server/sim/snapshot.js noteAttackRates (allies: the units whose clip is stretched)
    const u7 = { id: 7, alive: true, deployed: true, s: { interval: 0.5 } };
    const battle = { allyUnits: [u7], _ev: (t) => evs.push(t) };
    noteAttackRates(battle);                                   // the spawn value already reached the client
    assert.equal(evs.length, 0);
    u7.s.interval = 0.35;                                      // a skill came on
    noteAttackRates(battle);
    assert.deepEqual(evs, [['rate', 7, 0.35]]);
    noteAttackRates(battle);                                   // unchanged: nothing
    assert.equal(evs.length, 1);
    u7.s.interval = 1;                                         // the buff expired
    noteAttackRates(battle);
    assert.deepEqual(evs[1], ['rate', 7, 1]);
    // a unit that is not on the field is skipped
    const quiet = { allyUnits: [{ id: 8, alive: false, deployed: true, s: { interval: 1 } }], _ev: (x) => evs.push(x) };
    noteAttackRates(quiet);
    assert.equal(evs.length, 2);
  });
});

describe('the intervals the renderer must not mistake for a rhythm', () => {
  test('a delayed batch (a late first attack) does not turn the sim interval into a slow one', async () => {
    const v = await view(unit({ atkInterval: 0.5 }));
    v.onAttack({ x: 5, y: 9 }, 9.4, 'none');       // first attack, seen 9.4 s into the battle (a field entered late)
    v.onAttack({ x: 5, y: 9 }, 10.6, 'none');      // 1.2 s later: the client only saw the recovery, not a rhythm
    assert.equal(v.atkInterval, 0.5, 'the sim value wins over a gap it never measured');
    assert.equal(v.atkInterval, clampAtkInterval(0.5));
  });

  test('attacking again after a stop (a stun, a control, a redeploy) keeps the known interval', async () => {
    const v = await view(unit({ atkInterval: 0.9 }));
    v.onAttack({ x: 5, y: 9 }, 1.0, 'none');
    v.onAttack({ x: 5, y: 9 }, 1.9, 'none');       // normal gap: no change needed
    assert.equal(v.atkInterval, 0.9);
    v.onAttack({ x: 5, y: 9 }, 6.9, 'none');       // 5 s later: the unit was stunned and then walked back
    assert.equal(v.atkInterval, 0.9, 'the pause is not a slower attack');
    v.onAttack({ x: 5, y: 9 }, 7.85, 'none');      // attacking again at the known rhythm
    assert.ok(Math.abs(v.atkInterval - 0.9) < 0.02, 'only tick-sized wobble is followed');
  });

  test('small wobble around the known value is still followed', async () => {
    const v = await view(unit({ atkInterval: 1.0 }));
    v.onAttack({ x: 5, y: 9 }, 1.0, 'none');
    v.onAttack({ x: 5, y: 9 }, 2.04, 'none');      // +4 %: inside ATK_JUMP_TOLERANCE
    assert.ok(Math.abs(v.atkInterval - 1.0) < 0.02, 'drift is small, not a jump');
    assert.ok(v.atkInterval < 1.04, 'the raw measurement is not taken outright');
    assert.ok(ATK_JUMP_TOLERANCE > 0.04);
  });

  test('an unknown interval (no sim value) is still measured — an enemy, a legacy frame', async () => {
    const v = await view(unit({ kind: 'enemy', side: 'enemy', defId: 'enemy_test' }));
    assert.equal(v.atkKnown, false);
    v.onAttack({ x: 3, y: 9 }, 2.0, 'none');
    v.onAttack({ x: 3, y: 9 }, 3.2, 'none');       // the only source of truth here: the measured gap
    assert.equal(Math.round(v.atkInterval * 100) / 100, 1.2);
  });

  test('the sim side: unitInfo carries the interval, and a one-off cast is not a rhythm', async () => {
    const u = { id: 3, defId: 'char_test', kind: 'op', side: 'ally', x: 4, y: 9, s: { interval: 0.66, maxHp: 100, flags: {} }, base: { maxHp: 100 }, hidden: false };
    const info = unitInfo(u);
    assert.equal(info.atkInterval, 0.66);
    const v = await view(unit({ atkInterval: 0.66 }));
    v.onAttack({ x: 5, y: 9 }, 1.0, 'droneBomb');  // PROJ.once: one clip at its own speed, no rhythm measured
    assert.equal(v.atkInterval, 0.66);
  });

  test('the default when nothing is known at all', async () => {
    const v = await view(unit({ bat: 0, aspd: 0 }));
    assert.equal(v.atkInterval, ATK_DEFAULT_S);
  });
});
