// test/battleSpeed.test.js — 战斗期倍速 (room.setBattleSpeed, shared/constants.js BATTLE_SPEEDS).
//
// The promise of the feature: a room's normal rounds and 联防 may run at 4 game seconds per real second instead of the
// forced 2, and the battle's RESULT is exactly the same — the speed only decides how many of the fixed 1/30 s ticks a real
// second gets. 最终攻势 / 隐秘核心 always stay at the base 2× (their shared leader HP pool is credited on the server's
// real-time field clock). This file checks the pieces that carry that promise:
//   * the accepted values and the per-kind choice (battleSpeedOf);
//   * the wire intent (validateC2S) and the lobby rules (host-only, before the match, un-readies the others, room.state,
//     Match opts.battleSpeed), including the host proxy's wire whitelist;
//   * the server pacing (FieldRunner) really steps twice as many ticks per real second at 4×;
//   * the client-side field clock / result deadline / result release scale with the field's speed, boss fields included;
//   * the same battle, stepped in different frame sizes (2 vs 4 ticks per frame — the only thing the speed changes),
//     ends with the identical tick count and result.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BATTLE_SPEEDS, DEFAULT_BATTLE_SPEED, isBattleSpeed, battleSpeedOf } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { FieldRunner } from '../server/match/fields.js';
import { MatchClientCombat } from '../server/match/match/clientCombat.js';
import { wireOptions } from '../server/match/host/proxy.js';
import { Lobby, Room } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { makeBattle } from './helpers/battleHarness.js';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const TICK = 1 / 30;

/** A Match-like receiver for MatchClientCombat's field-clock helpers. */
function clockMatch({ battleSpeed = 4, gameSpeed = 2, now = 5000 } = {}) {
  return {
    gameSpeed, battleSpeed, paused: false, _pausedAt: 0, sched: { instant: false, now: () => now },
    _speedOf(kind) { return battleSpeedOf(kind, this.gameSpeed, this.battleSpeed); },
    _clockNow() { return now; },
    cancel() {},
  };
}

test('battle speeds: only 2 and 4 are accepted, and only normal rounds / 联防 take the room speed', () => {
  assert.deepEqual([...BATTLE_SPEEDS], [2, 4]);
  assert.equal(DEFAULT_BATTLE_SPEED, 2);
  for (const v of [2, 4]) assert.equal(isBattleSpeed(v), true, String(v));
  for (const v of [0, 1, 3, 3.5, 5, 8, -2, '4', '2', null, undefined, NaN, Infinity]) assert.equal(isBattleSpeed(v), false, String(v));

  // normal rounds and 联防 follow the room; the boss rounds keep the base
  assert.equal(battleSpeedOf('normal', 2, 4), 4);
  assert.equal(battleSpeedOf('unite', 2, 4), 4);
  assert.equal(battleSpeedOf('boss', 2, 4), 2);
  assert.equal(battleSpeedOf('hidden', 2, 4), 2);
  // a room without a choice (an older server, a plain Match) keeps the base — tools / tests may raise it with combatSpeed
  assert.equal(battleSpeedOf('normal', 2, undefined), 2);
  assert.equal(battleSpeedOf('normal', 8, undefined), 8);
  assert.equal(battleSpeedOf('boss', 8, 4), 8);
  // a nonsense base never wins over a valid room speed
  assert.equal(battleSpeedOf('normal', 0, 4), 4);
});

test('room.setBattleSpeed is a wire intent of exactly 2 or 4', () => {
  assert.equal(validateC2S({ t: 'room.setBattleSpeed', speed: 2 }), null);
  assert.equal(validateC2S({ t: 'room.setBattleSpeed', speed: 4 }), null);
  for (const msg of [
    { t: 'room.setBattleSpeed' },
    { t: 'room.setBattleSpeed', speed: 3 },
    { t: 'room.setBattleSpeed', speed: 1 },
    { t: 'room.setBattleSpeed', speed: '4' },
    { t: 'room.setBattleSpeed', speed: true },
    { t: 'room.setBattleSpeed', speed: null },
  ]) assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
  // unknown fields stay ignored, as for every intent
  assert.equal(validateC2S({ t: 'room.setBattleSpeed', speed: 4, note: 'x' }), null);
});

test('the lobby: host-only, before the match, un-readies the others, and the match gets the room speed', () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: QUIET, MatchClass: FakeMatch, now: () => 1000, seedFn: () => 7, getData: () => ({}) });
  const ws = () => ({ readyState: 1, bufferedAmount: 0, send() {} });
  const session = (name) => {
    const s = registry.create(name);
    s.connected = true;
    s.ws = ws();
    return s;
  };

  const host = session('Host');
  assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.rooms.get(host.roomCode);
  assert.ok(room instanceof Room);
  assert.equal(room.battleSpeed, DEFAULT_BATTLE_SPEED);
  assert.equal(room.toState().battleSpeed, DEFAULT_BATTLE_SPEED);

  const guest = session('Guest');
  assert.deepEqual(lobby.join(guest, { code: room.code }), { ok: true });
  room.seatOf(guest.playerId).ready = true;

  // not the host: refused, nothing changes
  assert.deepEqual(lobby.handleMessage(guest, { t: 'room.setBattleSpeed', speed: 4 }), { error: 'NOT_HOST' });
  assert.equal(room.battleSpeed, 2);

  // the host chooses 4×: stored, published, and the other humans are un-readied (they re-confirm the faster pace)
  assert.deepEqual(lobby.handleMessage(host, { t: 'room.setBattleSpeed', speed: 4 }), { ok: true });
  assert.equal(room.battleSpeed, 4);
  assert.equal(room.toState().battleSpeed, 4);
  assert.equal(room.seatOf(guest.playerId).ready, false);
  // the host is never un-readied by own changes
  assert.equal(room.seatOf(host.playerId).ready, false); // host starts un-ready anyway (starting is the host's ready)

  // the same speed again: accepted, no state churn
  assert.deepEqual(lobby.handleMessage(host, { t: 'room.setBattleSpeed', speed: 4 }), { ok: true });

  // an invalid value never reaches the wire; a direct call is refused without touching the room
  assert.equal(lobby.handleMessage(host, { t: 'room.setBattleSpeed', speed: 3 }).error, 'BAD_MSG');
  assert.equal(room.battleSpeed, 4);

  // the match starts on the room's speed (Match opts.battleSpeed → its normal rounds / 联防)
  assert.deepEqual(lobby.startMatch(room), { ok: true });
  assert.equal(room.match.opts.battleSpeed, 4);
  // the host proxy carries it into a match host (a room with gameplay plugins)
  assert.equal(wireOptions(room.match.opts).battleSpeed, 4);

  // during the match the setting is frozen (like the difficulty)
  assert.deepEqual(lobby.handleMessage(host, { t: 'room.setBattleSpeed', speed: 2 }), { error: 'ROOM_STARTED' });
  assert.equal(room.battleSpeed, 4);
});

test('the server paces a field at 4× with twice the ticks per real second, and the runner keeps its speed', () => {
  const drive = (speed, intervals = 30) => {
    let now = 0;
    const m = {
      gameSpeed: 2, battleSpeed: 4, paused: false, reportError() {}, guard(fn) { fn(); }, markPublic() {},
      sched: { instant: false, now: () => now, setInterval() { return 1; }, clearInterval() {} },
    };
    const battle = {
      finished: false, step() {}, snapshot() { return { t: 0, units: [] }; }, drainEvents() { return []; },
      forceEnd() { this.finished = true; },
    };
    const runner = new FieldRunner(m, [{ fieldId: 'f', kind: 'normal', players: [], battle, live: true }], {
      onDone() {}, emit: false, ...(speed == null ? {} : { speed }),
    });
    for (let i = 0; i < intervals; i++) {
      now += 1000 / 30; // one 30 Hz pacing interval, like Match.sched's
      runner._pump();
    }
    return runner;
  };

  const at2 = drive(2);
  const at4 = drive(4);
  assert.equal(at2.ticks, 60, '2 game s per real s → 60 ticks in one real second');
  assert.equal(at4.ticks, 120, '4 game s per real s → 120 ticks in one real second');
  // without an explicit speed a runner keeps the match's own (a boss round)
  assert.equal(drive(null).ticks, 60);
  assert.equal(drive(undefined).speed, 2);
});

test('the field clock, result deadline and release scale with the field speed; boss fields keep the base', () => {
  const cc = MatchClientCombat.prototype;
  const m = clockMatch({ now: 5000 });

  // 5 real s of field clock: 20 game s at 4×, 10 at the boss base 2×
  assert.equal(cc._fieldElapsed.call(m, { kind: 'normal', startAt: 0 }), 20);
  assert.equal(cc._fieldElapsed.call(m, { kind: 'unite', startAt: 0 }), 20);
  assert.equal(cc._fieldElapsed.call(m, { kind: 'boss', startAt: 0 }), 10);
  assert.equal(cc._fieldElapsed.call(m, { kind: 'hidden', startAt: 0 }), 10);
  // a finished field keeps its final game time whatever the speed
  assert.equal(cc._fieldElapsed.call(m, { kind: 'normal', startAt: 0, done: true, result: { time: 33 } }), 33);

  // the result deadline: a 120 game-second limit + the 15 s grace → 45 s real at 4×, 75 s at the boss base
  const timers = [];
  const deadlineOf = (kind) => {
    timers.length = 0;
    const c = clockMatch({ now: 0 });
    c.later = (ms) => { timers.push(ms); return 1; };
    cc._armDeadline.call(c, { kind, spec: { timeLimit: 120 }, startAt: 0, deadlineTimer: null, verifyJob: null, done: false, mode: 'client' });
    return timers[0];
  };
  assert.equal(deadlineOf('normal'), 45_000);
  assert.equal(deadlineOf('unite'), 45_000);
  assert.equal(deadlineOf('boss'), 75_000);

  // a server-run field's result is released at its natural end on the field clock
  const releaseOf = (kind) => {
    timers.length = 0;
    const c = clockMatch({ now: 0 });
    c.later = (ms) => { timers.push(ms); return 1; };
    c.cancel = () => {};
    cc._armRelease.call(c, { kind, startAt: 0, endGt: 120, result: { time: 120 }, done: false, doneTimer: null, mode: 'server' });
    return timers[0];
  };
  assert.equal(releaseOf('normal'), 30_000);
  assert.equal(releaseOf('boss'), 60_000);
});

test('the same battle, stepped at 2 or 4 ticks per frame, ends with the same ticks and the same result', () => {
  // The only thing 战斗期倍速 changes is how many fixed 1/30 s ticks a frame gets (2×: 60 ticks per real second, 4×: 120).
  // A battle therefore walks the identical tick sequence — this test pins that down on a real sim scenario with a kill,
  // a leak, damage and a skill's SP.
  const scenario = () => makeBattle({
    units: [{ chessId: 'chess_char_1_01_a', row: 9, col: 5 }, { chessId: 'chess_char_2_01_a', row: 12, col: 6 }],
    enemies: [{ key: 'enemy_1422_lrsldr', time: 0, route: 0, count: 2, interval: 2 }],
    seed: 11,
  });
  const play = (ticksPerFrame) => {
    const h = scenario();
    let frames = 0;
    while (!h.battle.finished && frames++ < 200_000) h.step(ticksPerFrame);
    return { ticks: h.battle.tickCount, time: h.battle.time, result: h.result() };
  };
  const at2 = play(2);   // 60 ticks per real second
  const at4 = play(4);   // 120 ticks per real second
  const at1 = play(1);   // a dropped frame: the same ticks, just later
  assert.ok(at2.ticks > 600, `the scenario runs a while: ${at2.ticks} ticks`);
  assert.equal(at4.ticks, at2.ticks);
  assert.equal(at1.ticks, at2.ticks);
  assert.deepEqual(at4.result, at2.result);
  assert.deepEqual(at1.result, at2.result);
  assert.ok(at2.result.perPlayer.p1.damageDealt > 0, 'the scenario actually fights');
  assert.ok(at2.result.perPlayer.p1.leaked.length + at2.result.killed > 0, 'and settles enemies');
  // the payoff: at 4× the same battle takes half the real time
  assert.equal((at4.ticks * TICK) / 4, (at2.ticks * TICK) / 2 / 2);
});

/** A stand-in Match that records its options (the lobby only needs the MATCH INTERFACE of Match.js). */
class FakeMatch {
  constructor(opts) {
    this.opts = opts;
    this.hosted = false;
    this.started = false;
  }
  start() { this.started = true; }
  handle() { return { ok: true }; }
  dispose() {}
}
