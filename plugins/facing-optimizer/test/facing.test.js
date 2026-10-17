import { test } from 'node:test';
import assert from 'node:assert/strict';

// Run with `node tools/plugin.mjs test <id>`: it installs this plugin's content and SDK registrations before this
// module (SP_PLUGIN_TEST_SET). Anywhere else — a plain `node --test` of the repository finds this file too — it skips.
const run = process.env.SP_PLUGIN_TEST_SET ? {} : { skip: 'run with node tools/plugin.mjs test <id>' };

// Test subjects, by what their ordinary attack is:
const SINGLE_TARGET = 'chess_char_1_01_a';   // 隐现, 速射手: one enemy per attack; its ammo skill is no stance → turns
const AOE_SKILL = 'chess_char_2_16_a';       // 拉普兰德: single-target normally, but S1 is a 群攻 stance (maxTargets 2)
const BLOCKER = 'chess_char_1_02_a';         // 角峰, 重装: range = its own tile, so only its blocked enemy is a target
const STANCE_ONLY = 'chess_char_1_18_a';     // 宴, 近战 无弹道: its skill is a 14 s stats stance, no 群攻 → keeps turning
const NO_PROJECTILE = 'chess_char_3_18_a';   // 忍冬, 近战 无弹道: a 充能 skill (S1) whose clip holds nothing either
const SPLASH = 'chess_char_1_14_a';          // 格雷伊, 群攻术师 (splashRadius > 0) → stays
const HEAL_ONE = 'chess_char_2_02_a';        // 赫默, 医师 (heal single) → turns to the ally it heals
const HEAL_MULTI = 'chess_char_2_14_a';      // 调香师, 群愈师 (heal 3) → stays

/** The direction of (dr, dc), as the plugin reads it: vertical only past ~60° off the horizontal. */
const TAN60 = 1.7320508075688772;
const dirOf = (dr, dc) => (Math.abs(dr) > TAN60 * Math.abs(dc) ? (dr > 0 ? 'UP' : 'DOWN') : dc > 0 ? 'RIGHT' : 'LEFT');

test('a target 45° above keeps the model horizontal — only past ~60° does it turn up', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // The enemy one row up and one column over: 45°, inside the 60° cone, so the model must NOT turn up (the 90° case is
  // the first test).
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 20,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  const e = h.spawn('enemy_facing_dummy', { pos: [10, 7] });   // dr = +1, dc = +1
  assert.ok(h.runUntil(() => h.eventsOf('atk').length > 0, 5), 'the operator attacks it');
  assert.ok(e.alive, 'the dummy survives the check');
  h.run(1);
  assert.equal(u.viewDir, null, '45° is inside the cone: the model stays level');
  checkInvariants(h.b);
});

test('a single-target attacker turns its model toward the enemy, and only its model', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // Deployed at (9, 6) facing RIGHT, so its range covers rows 8–10, cols 6–9. The enemy stands straight ABOVE it at
  // (10, 6): inside that range, so the model should look UP.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 20,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  h.spawn('enemy_facing_dummy', { pos: [10, 6] });
  const rangeBefore = u.rangeKeys.slice().sort((a, b) => a - b).join(',');

  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected the model to face UP, viewDir=${u.viewDir}`);
  assert.equal(u.dir, 'RIGHT', 'the real facing — the one that rotates the range — never moves');
  assert.equal(u.rangeKeys.slice().sort((a, b) => a - b).join(','), rangeBefore, 'the attack range is untouched');
  // turn first, then swing: the model's turn is queued ahead of the first attack it makes
  const firstVdir = h.events.findIndex((e) => e[0] === 'vdir' && e[1] === u.id);
  const firstAtk = h.events.findIndex((e) => e[0] === 'atk' && e[1] === u.id);
  assert.ok(firstVdir >= 0, 'the model turned');
  assert.ok(firstAtk < 0 || firstVdir < firstAtk, 'the turn comes before the swing, not after it');
  const vdir = h.eventsOf('vdir');
  assert.equal(vdir.at(-1)[0], 'vdir');
  assert.equal(vdir.at(-1)[1], u.id);
  assert.equal(vdir.at(-1)[2], 'UP');
  assert.ok(vdir.at(-1)[3] > 0, 'the flip transition length rides with the event');
  checkInvariants(h.b);
});

test('an enemy it cannot reach is never faced', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // Deployed facing RIGHT (range cols 6–9 on rows 8–10); the enemy stands two tiles to the LEFT, at (9, 4) — close,
  // but outside the range, so there is nothing it can attack and the model must not turn.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 20,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  h.spawn('enemy_facing_dummy', { pos: [9, 4] });
  h.run(4);
  assert.equal(u.viewDir, null, 'no reachable target, no turn');
  assert.equal(h.eventsOf('vdir').length, 0, 'and the clients hear nothing');
  checkInvariants(h.b);
});

test('after the target is gone the model holds, then turns back', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  const { ATTACK_ANIM_TIME } = await import('../../../server/sim/constants.js');
  // A dummy above the operator: it turns UP and shoots it. When the target vanishes the facing holds through the
  // attack and `holdSeconds` (3 s) after it, then returns to the deployed direction.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 40,
    autoFinish: false,                       // an empty field keeps running, so the hold can be watched
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  const e = h.spawn('enemy_facing_dummy', { pos: [10, 6] });
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected the model to face UP, viewDir=${u.viewDir}`);
  assert.ok(h.runUntil(() => Number.isFinite(u.lastAttackAt) && u.lastAttackAt > -Infinity, 3), 'the operator shoots');
  const shotAt = u.lastAttackAt;
  e.alive = false;                            // the target is gone (no attack of its own to hold onto)
  const holdEnds = shotAt + ATTACK_ANIM_TIME + 3;
  assert.ok(h.runUntil(() => h.b.time >= shotAt + 2.5, 10));
  assert.equal(u.viewDir, 'UP', `held until ${holdEnds.toFixed(2)} s, still going at ${h.b.time.toFixed(2)} s`);
  assert.ok(h.runUntil(() => u.viewDir === null, 5), 'and back to the deployed facing once the hold is over');
  assert.ok(h.b.time >= holdEnds - 1e-6, `turned back at ${h.b.time.toFixed(2)} s, the hold ends at ${holdEnds.toFixed(2)} s`);
  const back = h.eventsOf('vdir').filter((x) => x[2] === null);
  assert.equal(back.length, 1, 'one turn back, with an event of its own');
  checkInvariants(h.b);
});

test('a melee operator turns to what it blocks, then strikes a few frames later (wind-up)', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // 角峰 stands facing UP; a walker comes along its row from the right and is blocked. The model turns toward the enemy it
  // has just blocked, and the swing is HELD for the flip — so the turn lands first and the strike a couple of frames
  // later (the operator is slightly slower to strike, which is the wind-up the owner asked for).
  const h = makeBattle({
    units: [{ chessId: BLOCKER, row: 9, col: 6, dir: 'UP' }],
    enemies: [{ key: 'enemy_facing_walker', time: 0, route: 0 }],
    defs: { enemies: { enemy_facing_walker: enemyRec({ key: 'enemy_facing_walker', hp: 100000, speed: 1, atk: 0 }) } },
    timeLimit: 30,
  });
  const u = h.unit(BLOCKER);
  h.step();
  const times = [];
  let seen = h.events.length;
  for (let i = 0; i < 600 && !h.b.finished && h.b.time < 20; i++) {
    h.step();
    if (h.events.length === seen) continue;
    const batch = h.events.slice(seen);
    seen = h.events.length;
    times.push({ t: h.b.time, dir: batch.some((e) => e[0] === 'vdir' && e[1] === u.id), atk: batch.some((e) => e[0] === 'atk' && e[1] === u.id) });
    if (batch.some((e) => e[0] === 'vdir' && e[1] === u.id)) console.log('BATCH', h.b.time.toFixed(3), JSON.stringify(batch.filter((e) => e[1] === u.id || e[0] === 'blocked')), 'atkCd=' + u.atkCd, 'viewDir=' + u.viewDir);
  }
  const firstTurn = times.find((x) => x.dir);
  const firstAtk = times.find((x) => x.atk);
  assert.ok(firstTurn, 'the model turned');
  assert.ok(firstAtk, 'and it struck');
  assert.ok(firstAtk.t > firstTurn.t, `the strike comes after the turn (turn t=${firstTurn.t.toFixed(3)}, strike t=${firstAtk.t.toFixed(3)})`);
  assert.ok(u.dir === 'UP', 'the deploy direction is untouched');
  assert.equal(u.viewDir, 'RIGHT', 'the model faces the enemy it blocked');
  checkInvariants(h.b);
  // the swing that needed the turn was held, not lost: the operator still counts real attacks afterwards
  assert.ok(u.stats.attacks > 0, 'the held swing is followed by a real one');
  assert.deepEqual(h.b.errors.map((e) => e.label), [], 'no hook of the plugin threw');
});

test('a melee operator turns toward an enemy hugging it (up-right corner reads as up)', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // The enemy stands at the up-right CORNER of the operator's tile (0.4 up, 0.4 right — inside the block radius), where
  // the rounded tile is the operator's own and a polar reading would be 45°. A neighbour like that is looked UP at: that
  // is the only angle a melee operator ever has, and without it the model would never turn while it fights.
  const h = makeBattle({
    units: [{ chessId: BLOCKER, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_hugger: enemyRec({ key: 'enemy_facing_hugger', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 20,
  });
  const u = h.unit(BLOCKER);
  h.step();
  h.spawn('enemy_facing_hugger', { pos: [9.4, 6.4] });
  assert.ok(h.runUntil(() => u.blocking.length > 0, 5), 'it is blocked by the operator');
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected the model to look UP at it, got ${u.viewDir}`);
  assert.equal(u.dir, 'RIGHT', 'the deploy direction is untouched');
  assert.ok(h.runUntil(() => u.stats.attacks > 0, 5), 'and it goes on to hit it');
  checkInvariants(h.b);
});

test('a melee operator turns toward the enemy it blocks, outside its range grid', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // 角峰's whole attack range is its own tile ([[0, 0]]), so the engine only ever hits the enemies it BLOCKS — the
  // blocked-target rule of ai.js acquireTargets. Deployed facing UP, it blocks an enemy walking in along its row: the
  // model has to turn RIGHT although nothing is inside the range grid.
  const h = makeBattle({
    units: [{ chessId: BLOCKER, row: 9, col: 6, dir: 'UP' }],
    enemies: [{ key: 'enemy_facing_walker', time: 0, route: 0 }],
    defs: { enemies: { enemy_facing_walker: enemyRec({ key: 'enemy_facing_walker', hp: 100000, speed: 0.4, atk: 0 }) } },
    timeLimit: 30,
  });
  const u = h.unit(BLOCKER);
  h.step();
  assert.ok(h.runUntil(() => u.blocking.length > 0, 25), 'the walker is blocked');
  assert.equal(u.rangeKeySet.has(u.blocking[0].tileR * 21 + u.blocking[0].tileC), false,
    'the blocked enemy stands outside the range grid — only the block rule can see it');
  assert.ok(h.runUntil(() => u.viewDir === 'RIGHT', 3), `expected the model to face RIGHT, viewDir=${u.viewDir}`);
  assert.equal(u.dir, 'UP', 'its deploy direction is untouched');
  assert.ok(h.eventsOf('vdir').some((x) => x[2] === 'RIGHT' && x[1] === u.id));
  checkInvariants(h.b);
});

test('no turn inside the attack animation — only after the swing', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  const { ATTACK_ANIM_TIME } = await import('../../../server/sim/constants.js');
  // A target 45° up (no turn of its own), then — while the swing is still playing — a FLYING enemy straight above it:
  // 隐现 is a 速射手 (空气优先), so that one instantly becomes the enemy it would attack. The model must sit still
  // through the attack clip and only then turn UP.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: {
      enemies: {
        a: enemyRec({ key: 'a', hp: 100000, speed: 0, atk: 0 }),
        b: enemyRec({ key: 'b', hp: 100000, speed: 0, atk: 0, motion: 'FLY' }),
      },
    },
    timeLimit: 30,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  h.spawn('a', { pos: [10, 7] });
  assert.ok(h.runUntil(() => Number.isFinite(u.lastAttackAt), 5), 'it swings at the enemy up-right');
  assert.equal(u.viewDir, null, 'a 45° target keeps the model level');
  h.spawn('b', { pos: [10, 6] });                                 // a flyer straight above: the engine's first pick
  h.run(ATTACK_ANIM_TIME * 0.5);                                  // still inside the attack clip
  assert.equal(u.viewDir, null, 'the model does not turn inside the attack animation');
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected UP once the swing is over, got ${u.viewDir}`);
  checkInvariants(h.b);
});

test('a skill that is no 群攻 stance (宴) keeps turning while it runs', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // 宴's S1 is a stats stance (duration 14 s, no attack / targeting override): it owns no stance the model would read as
  // "facing this way", so a 无弹道 近战 in its skill animation KEEPS turning — that is the owner's rule.
  const h = makeBattle({
    units: [{ chessId: STANCE_ONLY, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { a: enemyRec({ key: 'a', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 30,
    autoFinish: false,
  });
  const u = h.unit(STANCE_ONLY);
  h.step();
  assert.ok(u.skill.active, 'its skill comes on by itself (a duration stance)');
  h.spawn('a', { pos: [9.4, 6.4] });                              // hugging its up-right corner → it is blocked
  assert.ok(h.runUntil(() => u.blocking.length > 0, 5), 'the enemy is blocked');
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected UP while the skill still runs, got ${u.viewDir}`);
  assert.ok(u.skill.active, 'nothing froze the model: its skill is no 群攻 stance');
  checkInvariants(h.b);
});

test('a 群攻 skill snaps the model back to the deployed facing at once and freezes it', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // 深巡's S1–S3 are a 群攻 stance (`targeting.maxTargets: 3`): its line is fired along the DEPLOYED facing (the range
  // grid is rotated by `unit.dir`, which the plugin never touches), so the model has to be back on that facing on the
  // first frame of the animation — an INSTANT snap back, no flip — and hold it for the whole skill.
  const h = makeBattle({
    units: [{ chessId: AOE_SKILL, row: 9, col: 6, dir: 'RIGHT' }],
    defs: {
      enemies: {
        a: enemyRec({ key: 'a', hp: 100000, speed: 0, atk: 0 }),
        b: enemyRec({ key: 'b', hp: 100000, speed: 0, atk: 0, motion: 'FLY' }),
      },
    },
    timeLimit: 40,
    autoFinish: false,
  });
  const u = h.unit(AOE_SKILL);
  h.step();
  h.spawn('a', { pos: [10, 6] });                                 // straight above → the model turns UP first
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected UP first, got ${u.viewDir}`);
  u.skill.sp = 999;                                               // fuel the skill; it casts on its next attack
  assert.ok(h.runUntil(() => u.skill.active, 8), 'the skill comes on');
  h.run(0.2);
  assert.equal(u.viewDir, null, 'a 群攻 skill puts the model back on the deployed facing');
  const back = h.eventsOf('vdir').filter((x) => x[2] === null);
  assert.ok(back.length >= 1, 'and the clients are told to turn it back');
  assert.equal(Number(back.at(-1)[3]) || 0, 0, 'instantly: the snap back carries no flip, so the first frame matches');
  h.spawn('b', { pos: [10, 7] });                                 // a flyer up-right: preferred, but the stance is frozen
  h.run(2);
  assert.equal(u.viewDir, null, 'the facing stays put for the whole skill');
  checkInvariants(h.b);
});

test('a skill with no stance animation (隐现\'s ammo) keeps turning', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // 隐现's skill is an ammo magazine: no stance to hold, so the model keeps aiming while it runs.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: {
      enemies: {
        a: enemyRec({ key: 'a', hp: 100000, speed: 0, atk: 0 }),
        b: enemyRec({ key: 'b', hp: 100000, speed: 0, atk: 0, motion: 'FLY' }),
      },
    },
    timeLimit: 40,
    autoFinish: false,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  h.spawn('a', { pos: [9, 8] });                                  // to the RIGHT: nothing to turn for, just to shoot at
  h.run(0.5);
  u.skill.sp = 999;                                               // fuel the ammo skill; it casts on its next attack
  assert.ok(h.runUntil(() => u.skill.active, 8), 'the skill comes on');
  h.run(1.5);                                                     // past the one-off clip window
  assert.equal(u.viewDir, null, 'still facing the deployed way');
  h.spawn('b', { pos: [10, 6] });                                 // a flyer straight above: the engine's first pick
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 4), `the model keeps turning, got ${u.viewDir}`);
  assert.ok(u.skill.active, 'and that skill is still the one running');
  checkInvariants(h.b);
});

test('it is already facing the target when the next swing comes', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // The turn is decided in the tick's `scheduled` phase — before attackCommit, the enemies' move and the attack — so
  // once the model is aimed, the next swing of that operator must come with no further turn in between.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 20,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  h.spawn('enemy_facing_dummy', { pos: [10, 6] });
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `expected UP, got ${u.viewDir}`);
  const mark = h.events.length;                         // everything drained from here on happened after the turn
  assert.ok(h.runUntil(() => h.events.slice(mark).some((e) => e[0] === 'atk' && e[1] === u.id), 5), 'it swings again');
  const after = h.events.slice(mark);
  const atk = after.findIndex((e) => e[0] === 'atk' && e[1] === u.id);
  assert.ok(atk >= 0);
  assert.equal(after.slice(0, atk).some((e) => e[0] === 'vdir'), false,
    'no turn between the decision and the swing — the model is aimed first, then it fires');
  assert.equal(u.viewDir, 'UP');
  checkInvariants(h.b);
});

test('every turn of a tick precedes that tick\'s swing', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // A walker crossing the operator's lane on the row ABOVE it: while it is off to the right the model needs no turn, and
  // when it passes almost straight above the turn is due. Whichever tick that lands in — the 0.05 s pulse, the spawn
  // hook or `beforeAttack` (the engine's about-to-attack point) — the turn must sit ahead of that tick's attack.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    enemies: [{ key: 'enemy_facing_walker', time: 0, route: { motion: 'WALK', start: [10, 9], end: [10, 2], checkpoints: [] } }],
    defs: { enemies: { enemy_facing_walker: enemyRec({ key: 'enemy_facing_walker', hp: 100000, speed: 1, atk: 0 }) } },
    timeLimit: 30,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  const walker = h.b.enemies.find((e) => e.alive);
  assert.ok(walker, 'the walker is on the field');
  const batches = [];
  let seen = h.events.length;
  for (let i = 0; i < 800 && !h.b.finished && h.b.time < 20; i++) {
    h.step();
    if (h.events.length > seen) { batches.push(h.events.slice(seen)); seen = h.events.length; }
  }
  let turns = 0;
  for (const batch of batches) {
    const iv = batch.findIndex((e) => e[0] === 'vdir' && e[1] === u.id);
    if (iv < 0) continue;
    turns++;
    const ia = batch.findIndex((e) => e[0] === 'atk' && e[1] === u.id);
    if (ia >= 0) assert.ok(iv < ia, `the turn (${iv}) must precede the swing (${ia}) of the same tick`);
  }
  assert.ok(turns > 0, 'the walker made the model turn at least once');
  checkInvariants(h.b);
});

test('a 充能 skill (忍冬 S1) does not freeze the model either', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // 忍冬's S1 is a 充能 skill (no 群攻 override): it may turn at any time the attack / skill clip is not playing. Here the
  // model simply has to end up facing the enemy it fights while the skill keeps casting.
  const h = makeBattle({
    units: [{ chessId: NO_PROJECTILE, row: 9, col: 6, dir: 'UP', skillIndex: 1 }],
    enemies: [{ key: 'enemy_facing_walker', time: 0, route: 0 }],
    defs: { enemies: { enemy_facing_walker: enemyRec({ key: 'enemy_facing_walker', hp: 200000, speed: 1, atk: 0 }) } },
    timeLimit: 30,
  });
  const u = h.unit(NO_PROJECTILE);
  h.step();
  u.skill.sp = 999;                                     // keep the charge skill casting
  assert.ok(h.runUntil(() => u.blocking.length > 0, 25), 'it blocks the walker');
  assert.ok(h.runUntil(() => u.viewDir === 'RIGHT', 5), `expected the model to face its enemy, got ${u.viewDir}`);
  assert.ok(h.eventsOf('vdir').some((x) => x[1] === u.id && x[2] === 'RIGHT'));
  assert.ok(h.b.errors.length === 0, 'no hook threw');
  checkInvariants(h.b);
});

test('a stunned operator does not turn until the stun ends', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // Stunned first, with a target straight above it that would otherwise pull the model UP: the facing must stay put for
  // the whole stun, and only then turn.
  const h = makeBattle({
    units: [{ chessId: SINGLE_TARGET, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 30,
    autoFinish: false,
  });
  const u = h.unit(SINGLE_TARGET);
  h.step();
  h.b.applyStatus(u, 'stun', { duration: 2 });
  assert.equal(u.canAct, false, 'it is stunned');
  h.spawn('enemy_facing_dummy', { pos: [10, 6] });
  h.run(1.6);
  assert.equal(u.viewDir, null, 'a stunned model keeps the facing it had');
  assert.ok(!h.eventsOf('vdir').some((x) => x[1] === u.id), 'and no turn was sent');
  assert.ok(h.runUntil(() => u.canAct, 3), 'the stun wears off');
  assert.ok(h.runUntil(() => u.viewDir === 'UP', 3), `then it turns, got ${u.viewDir}`);
  checkInvariants(h.b);
});

test('an AoE operator keeps the deployed facing', run, async () => {
  const { makeBattle, enemyRec, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  const h = makeBattle({
    units: [{ chessId: SPLASH, row: 9, col: 6, dir: 'RIGHT' }],
    defs: { enemies: { enemy_facing_dummy: enemyRec({ key: 'enemy_facing_dummy', hp: 100000, speed: 0, atk: 0 }) } },
    timeLimit: 20,
  });
  const u = h.unit(SPLASH);
  h.step();
  h.spawn('enemy_facing_dummy', { pos: [10, 6] });
  h.run(2);
  assert.equal(u.viewDir, null, '群攻 never turns');
  assert.equal(h.eventsOf('vdir').length, 0, 'and the clients hear nothing');
  checkInvariants(h.b);
});

test('a single-target healer turns toward the ally it heals', run, async () => {
  const { makeBattle, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  // The medic at (9, 6), the hurt ally straight above it at (10, 6) — inside the medic's range.
  const h = makeBattle({
    units: [{ chessId: HEAL_ONE, row: 9, col: 6, dir: 'RIGHT' }, { chessId: SINGLE_TARGET, row: 10, col: 6, dir: 'RIGHT' }],
    timeLimit: 20,
  });
  const medic = h.unit(HEAL_ONE);
  const ally = h.unit(SINGLE_TARGET);
  h.step();
  h.run(1);
  assert.equal(medic.viewDir, null, 'nobody is hurt: nothing to face');
  ally.hp = ally.maxHp * 0.4;
  const want = dirOf(ally.tileR - medic.tileR, ally.tileC - medic.tileC);
  assert.ok(h.runUntil(() => medic.viewDir === want, 3), `expected the medic to face ${want}, viewDir=${medic.viewDir}`);
  assert.equal(medic.dir, 'RIGHT', 'its own deploy direction is untouched');
  checkInvariants(h.b);
});

test('a multi-target healer keeps the deployed facing', run, async () => {
  const { makeBattle, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  const h = makeBattle({
    units: [{ chessId: HEAL_MULTI, row: 9, col: 6, dir: 'RIGHT' }, { chessId: SINGLE_TARGET, row: 10, col: 6, dir: 'RIGHT' }],
    timeLimit: 20,
  });
  const medic = h.unit(HEAL_MULTI);
  const ally = h.unit(SINGLE_TARGET);
  h.step();
  ally.hp = ally.maxHp * 0.4;
  h.run(2);
  assert.equal(medic.viewDir, null, '一次奶 2 个以上: no turn');
  assert.equal(h.eventsOf('vdir').length, 0);
  checkInvariants(h.b);
});

test('nothing in range leaves the deployed facing alone', run, async () => {
  const { makeBattle, checkInvariants } = await import('../../../test/helpers/battleHarness.js');
  const h = makeBattle({ units: [{ chessId: SINGLE_TARGET, row: 9, col: 3, dir: 'LEFT' }], timeLimit: 10 });
  const u = h.unit(SINGLE_TARGET);
  h.run(4);
  assert.equal(u.viewDir, null, 'no target: the model keeps its facing');
  assert.equal(h.eventsOf('vdir').length, 0);
  checkInvariants(h.b);
});
