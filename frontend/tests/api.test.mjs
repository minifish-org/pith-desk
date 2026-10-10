import test from 'node:test';
import assert from 'node:assert/strict';
import { createAPI, parseStream } from '../src/api.ts';

const headers = (json) => {
  const value = new Headers({ Authorization: 'Bearer fixture-token' });
  if (json) value.set('Content-Type', 'application/json');
  return value;
};

test('large Unicode drafts keep authentication and avoid the browser keepalive quota', async () => {
  const calls = [];
  globalThis.fetch = async (_path, options) => { calls.push(options); return Response.json({}); };
  const { request } = createAPI(headers);
  await request('/api/draft', { id: 'chat', text: '中'.repeat(40000), revision: 1 }, { keepalive: true });
  await request('/api/draft', { id: 'chat', text: 'small', revision: 2 }, { keepalive: true });
  assert.equal(calls[0].keepalive, false);
  assert.equal(calls[1].keepalive, true);
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer fixture-token');
  assert.equal(JSON.parse(calls[0].body).text.length, 40000);
});

test('typed reads and mutations retain authenticated same-origin requests', async () => {
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    return Response.json({ ok: true });
  };
  const { request } = createAPI(headers);
  await request('/api/models', { query: { provider: 'custom/中文' } });
  await request('/api/open', { id: 'saved-chat' });
  const controller = new AbortController();
  await request('/api/state', { signal: controller.signal });
  assert.equal(calls[0].path, '/api/models?provider=custom%2F%E4%B8%AD%E6%96%87');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { id: 'saved-chat' });
  assert.equal(calls[1].options.headers.get('Content-Type'), 'application/json');
  assert.equal(calls[2].options.method, 'GET');
  assert.equal(calls[2].options.signal, controller.signal);
  for (const call of calls) {
    assert.equal(call.options.headers.get('Authorization'), 'Bearer fixture-token');
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.path.includes('fixture-token'), false);
  }
});

test('paths shared by a query and mutation use the intended method', async () => {
  const methods = [];
  globalThis.fetch = async (_path, options) => { methods.push(options.method); return Response.json({}); };
  const { request } = createAPI(headers);
  await request('/api/custom-connection', { query: { id: 'custom' } });
  await request('/api/custom-connection', { id: '', name: 'Custom', baseUrl: 'http://localhost', api: 'openai-completions', apiKey: '', models: [] });
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('provider cancellation and an unsuccessful probe preserve their result semantics', async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.signal, controller.signal);
    return Response.json({ ok: false, kind: 'tool-calling', message: 'Provider did not call the test tool', toolCalling: false, durationMs: 5 });
  };
  const result = await createAPI(headers).request('/api/test-provider-connection', { provider: 'custom', baseUrl: 'http://localhost' }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.match(result.message, /test tool/);
});

test('host failures propagate their JSON error and binary downloads retain their type', async () => {
  const { request, download } = createAPI(headers);
  globalThis.fetch = async () => Response.json({ error: 'Conversation has been deleted' }, { status: 400 });
  await assert.rejects(request('/api/open', { id: 'deleted' }), /Conversation has been deleted/);
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/image?id=chat&message=message&index=2');
    assert.equal(options.headers.get('Authorization'), 'Bearer fixture-token');
    return new Response('image fixture', { headers: { 'Content-Type': 'image/png' } });
  };
  assert.equal((await download('/api/image', { id: 'chat', message: 'message', index: 2 })).type, 'image/png');
  assert.deepEqual(parseStream('/api/socket', '{"activeId":"saved-chat"}'), { activeId: 'saved-chat' });
});
