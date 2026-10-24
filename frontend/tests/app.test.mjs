import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import { readAppBootstrap } from '../src/lib/bootstrap.ts';
import { createMutations } from '../src/mutations.ts';

const fixed = JSON.parse(readFileSync(new URL('../../internal/desk/testdata/state.active.json', import.meta.url), 'utf8'));
const turn = () => new Promise(setImmediate);

function setup(t, fetch) {
  const sockets = [], snapshots = [], connections = [], errors = [];
  class Socket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); }
    open() { this.onopen?.(); }
    state(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close(code) { this.closeCode = code; this.onclose?.(); }
  }
  t.mock.method(globalThis, 'fetch', fetch ?? (async () => Response.json(fixed)));
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  const app = createApp({ token: 'fixture-token', origin: 'https://127.0.0.1:12345/', appearance: 'system', onSnapshot: (...args) => snapshots.push(args), onConnection: (value) => connections.push(value), onError: (value) => errors.push(value) });
  t.after(() => { app.dispose(); globalThis.WebSocket = previousSocket; });
  return { app, sockets, snapshots, connections, errors };
}

test('retiring a page rejects late mutation responses and never starts follow-up requests', async t => {
  let finish, calls = 0;
  const {app} = setup(t, () => {calls++; return new Promise(resolve => {finish = resolve;});});
  const write = app.request('/api/send', {id: 'chat', text: 'send once'});
  app.dispose();
  finish(Response.json({ok: true}));
  await assert.rejects(write, /disconnected/);
  await assert.rejects(app.request('/api/draft', {id: 'chat', text: 'late', revision: 123}), /disconnected/);
  assert.equal(calls, 1);
});

test('app owns authenticated HTTP and WS ingress and consumes bootstrap secrets', async (t) => {
  const calls = [];
  const { app, sockets, snapshots } = setup(t, async (url, options) => { calls.push({ url, options }); return Response.json(fixed); });
  await app.start();
  await app.start();
  assert.equal(sockets.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer fixture-token');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(sockets[0].url, 'wss://127.0.0.1:12345/api/socket');
  assert.deepEqual(sockets[0].protocols, ['pith-desk', 'bearer.fixture-token']);
  assert.equal(snapshots[0][2], false);
  sockets[0].open();
  sockets[0].state({ ...fixed, queuedMessages: null, runs: null });
  assert.deepEqual(app.state.queuedMessages, []);
  assert.deepEqual(app.state.runs, []);
  assert.equal(snapshots[1][2], true);
  assert.equal(app.connection, 'connected');

  const removed = [];
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable:true, value: {documentElement: {dataset: {appearance: 'dark'}}, querySelector: selector => ({content: selector.includes('desk-token') ? 'fixture-token' : 'true', remove: () => removed.push(selector)})}});
  t.after(() => {if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;});
  const bootstrap = readAppBootstrap();
  assert.equal(bootstrap.token, 'fixture-token');
  assert.equal(bootstrap.nativeMenus, true);
  assert.equal(bootstrap.nativeBrowser,true);
  assert.equal(bootstrap.titlebar, 'overlay');
  assert.equal(bootstrap.appearance, 'dark');
  assert.equal(removed.length, 7);
});

test('browser bootstrap leaves titlebar fusion off unless the window host explicitly enables it', (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let value = 'false';
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    documentElement: {dataset: {}},querySelector: selector => ({content: selector.includes('desk-titlebar-overlay') ? value : 'true',remove() {}}),
  }});
  t.after(() => {if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;});
  for (value of ['false','__DESK_TITLEBAR_OVERLAY__','']) assert.equal(readAppBootstrap().titlebar, undefined);
  value = 'true';assert.equal(readAppBootstrap().titlebar, 'overlay');
});

test('a delayed HTTP snapshot cannot overwrite a newer streamed selection', async (t) => {
  let release;
  const { app, sockets } = setup(t);
  await app.start();
  sockets[0].open();
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { release = resolve; }));
  const reading = app.refresh();
  const newer = { ...fixed, activeId: 'chat-b', messages: [] };
  sockets[0].state(newer);
  release(Response.json(fixed));
  await reading;
  assert.equal(app.state.activeId, 'chat-b');
  assert.deepEqual(app.state.messages, []);
});

test('out-of-order HTTP reads retain the newer request result', async (t) => {
  const { app } = setup(t);
  const replies = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => replies.push(resolve)));
  const older = app.refresh(), newer = app.refresh();
  replies[1](Response.json({ ...fixed, activeId: 'chat-b' }));
  await newer;
  replies[0](Response.json(fixed));
  await older;
  assert.equal(app.state.activeId, 'chat-b');
});

test('refresh failure and reconnect never replay a committed mutation or old socket frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0, failRead = false, busy = false;
  const { app, sockets } = setup(t, async (_url, options) => {
    if (options.method === 'POST') { writes++; return Response.json({ ok: true }); }
    if (failRead) { failRead = false; throw new Error('interrupted read'); }
    return Response.json({ ...fixed, activeId: writes ? 'chat-b' : 'chat-a' });
  });
  await app.start();
  sockets[0].open();
  const mutate = createMutations({ request: app.request, refresh: app.refresh, busy: () => busy, setBusy: (value) => { busy = value; }, error: () => {} });
  failRead = true;
  assert.equal(await mutate('/api/open', { id: 'chat-b' }), true);
  sockets[0].close();
  await turn();
  assert.equal(app.connection, 'reconnecting');
  t.mock.timers.tick(700);
  await turn();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[0].state(fixed);
  assert.equal(app.state.activeId, 'chat-b');
  assert.equal(writes, 1);
  sockets[1].close();
  await turn();
  app.dispose();
  t.mock.timers.tick(10000);
  await turn();
  assert.equal(sockets.length, 2);
});

test('startup read failure recovers from WS and invalid frames do not replace the snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { app, sockets, errors } = setup(t, async () => { throw new Error('startup unavailable'); });
  await app.start();
  assert.equal(app.loaded, false);
  assert.deepEqual(errors, ['startup unavailable']);
  sockets[0].open();
  sockets[0].state(fixed);
  assert.equal(app.loaded, true);
  sockets[0].onmessage({ data: '{broken JSON' });
  await turn();
  assert.equal(sockets[0].closeCode, 1003);
  assert.deepEqual(app.state, fixed);
  assert.equal(app.connection, 'reconnecting');
});

test('dispose aborts snapshot reads and ignores even a late successful reply', async (t) => {
  let release, signal;
  const { app, sockets, snapshots } = setup(t, async (_url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  const starting = app.start();
  app.dispose();
  assert.equal(signal.aborted, true);
  release(Response.json(fixed));
  await starting;
  assert.equal(sockets.length, 0);
  assert.equal(snapshots.length, 0);
  assert.equal(app.loaded, false);
});

test('confirmed reads update the owner only for the acknowledged completion run', async (t) => {
  const { app, sockets } = setup(t);
  await app.start();
  app.confirmRead('chat-a', 'old-run');
  assert.equal(app.state.conversations[0].unread, true);
  app.confirmRead('chat-a', 'run-previous');
  assert.equal(app.state.conversations[0].unread, false);
  sockets[0].state({ ...fixed, conversations: fixed.conversations.map((entry, index) => index === 0 ? { ...entry, completedRunId: 'next-run' } : entry) });
  app.confirmRead('chat-a', 'run-previous');
  assert.equal(app.state.conversations[0].unread, true);
});
