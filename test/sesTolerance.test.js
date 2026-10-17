// The script sandbox (SES) must not die on an engine whose globals carry an own, non-configurable `arguments` or
// `caller` on a function. Chromium builds of Android webviews do that for `TextEncoder`, and an unpatched SES threw
// `Cannot delete property 'arguments' of function TextEncoder()` out of `lockdown()` — with it every script plugin died
// with PLUGIN_WORKER_FAILED ("plugin worker stopped") the moment a room used one.
//
// public/vendor/ses.umd.js carries the [sp-patch] in cauterizeProperty that tolerates those two props (they are plain
// function-introspection leftovers with no sandbox power). This test reproduces the failing environment and proves the
// sandbox initialises and can evaluate code.
//   node --test test/sesTolerance.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = pathToFileURL(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;

/**
 * Give `globalThis.TextEncoder` an own, non-configurable `arguments`, like the failing browser does. Must run BEFORE the
 * sandbox module (and SES) are imported: both sample the globals when they load.
 */
function poisonTextEncoder() {
  const fake = function TextEncoder() {};
  Object.defineProperty(fake, 'arguments', { value: undefined, configurable: false, writable: false });
  Object.defineProperty(globalThis, 'TextEncoder', { value: fake, configurable: true, writable: true });
}

test('SES lockdown survives an undeletable own `arguments` on a global function', async () => {
  poisonTextEncoder();
  const sandbox = await import('../shared/plugins/sandbox.js');
  // the same adapter the browser Worker and the match child use (simWorkerRuntime.prepareScriptRuntime)
  await sandbox.initializeSandbox({ loadSES: () => import('../public/vendor/ses.umd.js') });
  assert.equal(typeof globalThis.lockdown, 'function', 'SES is loaded');
  assert.equal(typeof globalThis.Compartment, 'function', 'and locked down: the compartment exists');
});

test('a plugin compartment still evaluates code after that lockdown', async () => {
  const sandbox = await import('../shared/plugins/sandbox.js');
  const sp = Object.freeze({ log() {} });
  const compartment = sandbox.createPluginCompartment(sp);
  assert.equal(compartment.evaluate('1 + 2'), 3);
  // the sandbox still takes the host powers away from the guest
  assert.equal(compartment.evaluate('typeof fetch'), 'undefined');
  assert.equal(compartment.evaluate('typeof setTimeout'), 'undefined');
  assert.equal(compartment.evaluate('typeof Date'), 'undefined');
  assert.equal(compartment.evaluate('typeof Compartment'), 'undefined');
});
