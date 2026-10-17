// Which simulation host a room's content set gets (battle/runner.js ensureSim → battle/simLoader.js contentNeedsWorker).
//
// The module Worker exists for the SES sandbox around SCRIPT plugins, and it boots per battle: import the engine modules,
// load SES, lock the realm down, install the plugin sources. On a phone that is the multi-second start a modded battle
// showed. A data-only content set (数值 / 干员 / 敌人 / 商店 …) needs none of it and is simulated in the page exactly like the
// original content, so the rule is simply "a script plugin in the set → Worker, otherwise the page".
// `node --test test/contentRouting.test.js`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contentNeedsWorker } from '../public/js/battle/simLoader.js';

test('a set with a script plugin needs the module Worker (the SES sandbox)', () => {
  assert.equal(contentNeedsWorker({ cs: 'abc', data: {}, scripts: [{ id: 'facing-optimizer', files: {} }] }), true);
  assert.equal(contentNeedsWorker({ scripts: [{ id: 'a' }, { id: 'b' }] }), true);
});

test('a data-only set runs in the page (no Worker, no per-battle boot)', () => {
  assert.equal(contentNeedsWorker({ cs: 'abc', data: { chess: {} }, scripts: [] }), false, '数值 / 干员 / 商店 plugin');
  assert.equal(contentNeedsWorker({ cs: 'abc', data: {} }), false, 'no scripts field at all');
  assert.equal(contentNeedsWorker(null), false);
  assert.equal(contentNeedsWorker(undefined), false);
});

test('scripts the server did not enable count as no scripts', () => {
  // the host sends the set with the scripts it allows to run; a disabled script plugin leaves an empty list
  assert.equal(contentNeedsWorker({ scripts: [] }), false);
  assert.equal(contentNeedsWorker({ scripts: null }), false);
  assert.equal(contentNeedsWorker({ scripts: 'x' }), false, 'a malformed value is not a script list');
});
