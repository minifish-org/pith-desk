import test from 'node:test';
import assert from 'node:assert/strict';
import { mountUpdates } from '../src/updates.ts';

const state = (phase, extra = {}) => ({ version: '0.1.0-rc.19', enabled: true, phase, availableVersion: '', progress: 0, message: '', ...extra });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// Button visibility, disabled states and error rendering belong to pith-ui's
// app-settings browser tests. This host records only the controller protocol.
function settingsHost() {
  const events = [];
  return { events, panel: {
    updateUpdates: value => events.push({ kind: 'state', value }),
    setUpdatePending: value => events.push({ kind: 'pending', value }),
    setUpdateError: (message, options) => events.push({ kind: 'error', message, options }),
  } };
}

test('a stale initial status cannot hide the release found by a manual check', async () => {
  const { panel, events } = settingsHost();
  const requests = [];
  let initial, finishAction;
  let reads = 0;
  const ui = mountUpdates(panel, async (path, input) => {
    requests.push({ path, input });
    if (input) return new Promise(resolve => { finishAction = resolve; });
    if (reads++ === 0) return new Promise(resolve => { initial = resolve; });
    return state('available', { availableVersion: '0.1.0-rc.20', message: 'Version 0.1.0-rc.20 is available.' });
  });
  const check = ui.check();
  initial(state('idle'));
  await settle();
  assert.deepEqual(events, [{ kind: 'pending', value: true }]);
  finishAction({ ok: true });
  await check;
  assert.deepEqual(requests, [
    { path: '/api/update', input: undefined },
    { path: '/api/update', input: { action: 'check' } },
    { path: '/api/update', input: undefined },
  ]);
  assert.deepEqual(events, [
    { kind: 'pending', value: true },
    { kind: 'state', value: state('available', { availableVersion: '0.1.0-rc.20', message: 'Version 0.1.0-rc.20 is available.' }) },
    { kind: 'pending', value: false },
  ]);
  ui.dispose();
});

test('action failures remain visible after status refresh and can be retried', async () => {
  const { panel, events } = settingsHost();
  const actions = [];
  const ui = mountUpdates(panel, async (path, input) => {
    assert.equal(path, '/api/update');
    if (input) actions.push(input);
    if (input) throw new Error('The app is preparing to quit');
    return state('available', { availableVersion: '0.1.0-rc.20' });
  });
  await settle();
  await ui.act('install');
  assert.deepEqual(events.slice(-3), [
    { kind: 'state', value: state('available', { availableVersion: '0.1.0-rc.20' }) },
    { kind: 'pending', value: false },
    { kind: 'error', message: 'Error: The app is preparing to quit', options: undefined },
  ]);
  await ui.act('install');
  assert.deepEqual(actions, [{ action: 'install' }, { action: 'install' }]);
  assert.equal(events.at(-1).message, 'Error: The app is preparing to quit');
  ui.dispose();
});

test('closing Settings ignores a delayed status response', async () => {
  const { panel, events } = settingsHost();
  let finish;
  const ui = mountUpdates(panel, () => new Promise(resolve => { finish = resolve; }));
  ui.dispose();
  finish(state('installing', { progress: 70, message: 'Installing' }));
  await settle();
  assert.deepEqual(events, []);
});
