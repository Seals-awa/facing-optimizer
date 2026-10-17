// Voice scheduling rules of public/js/audio.js (VoiceGate) — the 部署语音 必定播放 request:
//   部署 place never loses to timing, answers at once, interrupts the 选中 (select) line, does not cut off another
//   deploy line, and waits (queue) behind a more important line instead of being dropped.
// The gate is pure (the clock is passed in), so it is tested directly: `node --test test/voiceGate.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AudioManager, VoiceGate, VOICE_PRIORITY, VOICE_QUEUE_TTL_MS, VOICE_ALWAYS_SLOTS, VOICE_TAP_SLOTS } from '../public/js/audio.js';

/** A gate with a 1.2 s gap and the shipped margin. */
const makeGate = () => new VoiceGate({ gapMs: 1200, preemptMargin: 10 });

/** Put a line on air, as the manager does after a 'play' / 'preempt' verdict. */
const playing = (gate, slot, now) => {
  gate.request(slot, null, now);
  gate.start(slot, null, now);
};

test('部署 is the only always-play slot and it sits above 选中', () => {
  assert.deepEqual([...VOICE_ALWAYS_SLOTS], ['place']);
  assert.deepEqual([...VOICE_TAP_SLOTS], ['select']);
  assert.ok(VOICE_PRIORITY.place > VOICE_PRIORITY.select, 'place outranks select');
  assert.ok(VOICE_QUEUE_TTL_MS > 0);
});

test('a deploy line plays on an idle channel even inside the global gap', () => {
  const gate = makeGate();
  playing(gate, 'skill1', 1000);          // 作战中 on air, then it ends
  gate.release();
  assert.equal(gate.request('faceEnemy', null, 1100), 'drop', 'a normal line still respects the gap');
  assert.equal(gate.request('place', null, 1100), 'play', 'the deploy line does not');
});

test('a deploy line interrupts the 选中 line', () => {
  const gate = makeGate();
  playing(gate, 'select', 1000);          // the player tapped an operator, its 选中 line is on air
  assert.equal(gate.request('place', null, 1100), 'preempt', '部署 takes the channel from 选中');
});

test('a tap never interrupts a deploy line', () => {
  const gate = makeGate();
  playing(gate, 'place', 1000);
  assert.equal(gate.request('select', null, 1100), 'drop', '选中 must not cut off 部署');
});

test('two deploy lines do not cut each other off', () => {
  const gate = makeGate();
  playing(gate, 'place', 1000);
  assert.equal(gate.request('place', null, 1100), 'drop', 'an equal-priority deploy line waits, it does not chop');
});

test('a deploy line queues behind a more important line', () => {
  const gate = makeGate();
  playing(gate, 'start', 1000);           // 行动出发 (100)
  assert.equal(gate.request('place', null, 1100), 'queue');
  gate.release();
  assert.equal(gate.request('place', null, 1100), 'play', 'and it sounds as soon as that line ends');
});

test('the other lines keep the official scheduling', () => {
  const gate = makeGate();
  playing(gate, 'skill1', 1000);          // 作战中1 (70)
  assert.equal(gate.request('skill2', null, 1100), 'drop', 'an equal line waits (preemptMargin)');
  assert.equal(gate.request('faceEnemy', null, 1100), 'preempt', '接敌 (90) beats 作战中 (70) by the margin');
  gate.release();
  playing(gate, 'select', 2000);
  assert.equal(gate.request('select', null, 2100), 'preempt', 'a newer tap replaces the 选中 line');
  assert.equal(gate.request('faceEnemy', null, 2100), 'preempt', '接敌 (90) takes the channel from 选中 (10)');
});

test('a deploy line still needs a line to exist (the manager picks it before asking the gate)', () => {
  const gate = makeGate();
  // an operator without a 部署 line never reaches the gate: voice() returns false when voiceLine finds nothing. The
  // gate itself knows nothing about operators, so this is just the shipped contract: the slot name is 'place'.
  assert.equal('place' in VOICE_PRIORITY, true);
  assert.equal(gate.request('place', 'unit-7', 0), 'play');
});

// ---- the manager's side of the queue (a 部署 line waiting behind a more important line) ---------------------------

/** An AudioManager-shaped object: the two queue methods only touch `this.queuedVoice` and `this.voice`. */
function fakeManager() {
  const m = Object.create(AudioManager.prototype);
  m.queuedVoice = null;
  m.played = [];
  m.voice = (charId, slot, o = {}) => { m.played.push({ charId, slot, ...o }); return true; };
  return m;
}

test('a queued deploy line sounds when the channel frees up', () => {
  const m = fakeManager();
  m._queueVoice('char_a', 'place', { unitKey: 4, volume: 0.7 }, performance.now());
  assert.deepEqual(m.played, [], 'nothing plays while it waits');
  m._flushQueuedVoice();
  assert.deepEqual(m.played, [{ charId: 'char_a', slot: 'place', unitKey: 4, volume: 0.7 }]);
  assert.equal(m.queuedVoice, null, 'the queue is emptied');
});

test('a deploy line that waited too long is dropped instead of sounding late', () => {
  const m = fakeManager();
  m._queueVoice('char_a', 'place', { unitKey: 4 }, performance.now() - VOICE_QUEUE_TTL_MS - 1);
  m._flushQueuedVoice();
  assert.deepEqual(m.played, [], 'the deployment is long past: it stays silent');
});

test('only the newest waiting deploy line is kept', () => {
  const m = fakeManager();
  m._queueVoice('char_a', 'place', { unitKey: 1 }, performance.now());
  m._queueVoice('char_b', 'place', { unitKey: 2 }, performance.now());
  m._flushQueuedVoice();
  assert.deepEqual(m.played.map((p) => p.charId), ['char_b'], 'one line, the latest deployment');
});

