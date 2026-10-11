import test from 'node:test';
import assert from 'node:assert/strict';
import { mountUpdates } from '../src/updates.ts';

const state = (phase, extra = {}) => ({ version: '0.1.0-rc.19', enabled: true, phase, availableVersion: '', progress: 0, message: '', ...extra });
function elements() {
  const nodes = Object.fromEntries(['[data-update-version]', '[data-update-message]', '[data-update-check]', '[data-update-install]', 'progress'].map((name) => [name, Object.assign(new EventTarget(), { textContent: '', disabled: false, hidden: false, value: 0 })]));
  return { root: { querySelector: (name) => nodes[name] }, nodes };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a stale initial status cannot hide the release found by a manual check', async () => {
  const { root, nodes } = elements();
  let initial, finishAction;
  let reads = 0;
  const ui = mountUpdates(root, async (_path, input) => {
    if (input) return new Promise(resolve => { finishAction = resolve; });
    if (reads++ === 0) return new Promise(resolve => { initial = resolve; });
    return state('available', { availableVersion: '0.1.0-rc.20', message: 'Version 0.1.0-rc.20 is available.' });
  });
  const check = ui.check();
  initial(state('idle'));
  await settle();
  assert.equal(nodes['[data-update-check]'].disabled, true);
  finishAction({ ok: true });
  await check;
  assert.equal(nodes['[data-update-install]'].hidden, false);
  assert.equal(nodes['[data-update-install]'].disabled, false);
  assert.equal(nodes['[data-update-message]'].textContent, 'Version 0.1.0-rc.20 is available.');
  ui.dispose();
});

test('action failures remain visible after status refresh and can be retried', async () => {
  const { root, nodes } = elements();
  const ui = mountUpdates(root, async (_path, input) => {
    if (input) throw new Error('The app is preparing to quit');
    return state('available', { availableVersion: '0.1.0-rc.20' });
  });
  await settle();
  nodes['[data-update-install]'].dispatchEvent(new Event('click'));
  await settle();
  assert.match(nodes['[data-update-message]'].textContent, /preparing to quit/);
  assert.equal(nodes['[data-update-install]'].disabled, false);
  ui.dispose();
});

test('closing Settings ignores a delayed status response', async () => {
  const { root, nodes } = elements();
  let finish;
  const ui = mountUpdates(root, () => new Promise(resolve => { finish = resolve; }));
  ui.dispose();
  finish(state('installing', { progress: 70, message: 'Installing' }));
  await settle();
  assert.equal(nodes['[data-update-message]'].textContent, '');
});
