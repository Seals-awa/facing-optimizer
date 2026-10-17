// The warm-worker pool of public/js/battle/simHost.js: a finished (or pre-warmed) sim Worker boots the next modded
// battle without paying the engine import + SES lockdown + plugin install again. The runner's per-battle boot is what
// makes entering a modded battle slow on a phone, so these primitives must be exactly right:
//   * a worker is parked only when it finished cleanly for the same content set,
//   * taking it hands over the new battle's failure handler and clears the last battle's caches,
//   * a stopped / failed / vanilla host is never parked, an old one is terminated.
// `node --test test/simHostPool.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  takeWarmHost, parkHost, pruneWarmHosts, drainWarmHosts, prewarmHost, prewarming, warmHostCount,
  warmHostCount as count, WARM_TTL_MS, WorkerSimHost,
} from '../public/js/battle/simHost.js';

/** A Worker-shaped object: every command is answered on the next turn of the microtask queue. */
function fakeWorker(reply = () => ({})) {
  const w = {
    terminated: false,
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(m) {
      const value = reply(m.method, m.args);
      Promise.resolve().then(() => w.onmessage?.({ data: { id: m.id, value } }));
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

/** A WorkerSimHost whose boot always succeeds (the `load` RPC answers `{ install: false }`). */
async function loadedHost(cs = 'cs-a') {
  const host = new WorkerSimHost({ workerFactory: () => fakeWorker((method) => (method === 'load' ? { install: false } : {})) });
  await host.load(cs, { cs, data: {} });
  return host;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a worker parked after a battle is handed to the next one, cleaned', async () => {
  drainWarmHosts();
  const host = await loadedHost('cs-a');
  host.events.push(['atk', 1, 2, 'none']);
  host.packet = { snap: {} };
  host.statsCache.set(7, { hp: 1 });
  assert.equal(parkHost(host), true);
  assert.equal(warmHostCount(), 1);
  assert.equal(host.warmSince > 0, true, 'parked with a timestamp');

  const calls = [];
  const next = takeWarmHost('cs-a', (err) => calls.push(err));
  assert.equal(next, host, 'the same worker comes back');
  assert.equal(warmHostCount(), 0, 'the pool is empty again');
  assert.deepEqual(next.events, [], 'the last battle events are gone');
  assert.equal(next.packet, null, 'and its snapshot');
  assert.equal(next.statsCache.size, 0, 'and its unit-stat cache');
  assert.equal(next.warmSince, 0, 'in use, not parked');
  next.onFailure('boom');
  assert.deepEqual(calls, ['boom'], 'the failure handler is the new battle"s');
});

test('the pool is keyed by content set', async () => {
  drainWarmHosts();
  const host = await loadedHost('cs-a');
  parkHost(host);
  assert.equal(takeWarmHost('cs-b'), null, 'another content set never reuses it');
  assert.equal(warmHostCount(), 1, 'and it stays parked');
});

test('a cleaned-up or failed worker is never parked', async () => {
  drainWarmHosts();
  const host = await loadedHost('cs-a');
  host.stop();
  assert.equal(parkHost(host), false);
  host.failed = true;
  const other = await loadedHost('cs-a');
  other.failed = true;
  assert.equal(parkHost(other), false);
  assert.equal(warmHostCount(), 0);
});

test('only one worker is parked; a second content set terminates the old one', async () => {
  drainWarmHosts();
  const a = await loadedHost('cs-a');
  const b = await loadedHost('cs-b');
  parkHost(a);
  parkHost(b);
  assert.equal(warmHostCount(), 1);
  assert.equal(a.terminated || a.stopped, true, 'the older one is gone');
  assert.equal(takeWarmHost('cs-b'), b);
});

test('a parked worker older than the TTL is dropped', async () => {
  drainWarmHosts();
  const host = await loadedHost('cs-a');
  parkHost(host, Date.now() - WARM_TTL_MS - 1);
  pruneWarmHosts();
  assert.equal(warmHostCount(), 0);
  assert.equal(host.stopped, true, 'and terminated');
});

test('prewarm boots a worker in the background and parks it', async () => {
  drainWarmHosts();
  const seen = [];
  const started = prewarmHost('cs-a', { cs: 'cs-a', data: {} }, {
    workerFactory: () => fakeWorker((method) => (method === 'load' ? { install: false } : {})),
    onPrewarmed: (host) => seen.push(host),
  });
  assert.equal(started, true, 'a boot is scheduled');
  assert.equal(prewarming('cs-a'), true, 'and marked as in flight');
  assert.equal(prewarmHost('cs-a', { cs: 'cs-a', data: {} }), false, 'the same content set is not booted twice');
  await settle();
  assert.equal(prewarming('cs-a'), false);
  assert.equal(warmHostCount(), 1);
  assert.equal(seen.length, 1);
  assert.equal(count(), 1);
});

test('a failed prewarm leaves nothing behind', async () => {
  drainWarmHosts();
  prewarmHost('cs-a', { cs: 'cs-a', data: {} }, {
    workerFactory: () => fakeWorker(() => { throw new Error('no'); }),
  });
  await settle();
  assert.equal(warmHostCount(), 0);
  assert.equal(prewarming('cs-a'), false);
});
