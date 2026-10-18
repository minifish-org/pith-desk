import test from 'node:test';
import assert from 'node:assert/strict';
import type {Application, CustomConnectionState, LoadingSession} from '../src/ui-contract.ts';
import type {ApiRequest} from '../src/api.ts';
import type {ModelsJsonModel} from '../src/contract.generated.ts';
import type {SDKFeatureAPI} from '../src/sdk-feature-api.ts';
import {createCustomUI} from '../src/custom-connections.ts';

type Connection = {name: string; baseUrl: string; api: string; models: ModelsJsonModel[]};

function harness(connection?: Connection) {
  const opened: CustomConnectionState[] = [], reads: unknown[] = [];
  const loading: LoadingSession = {update() {}, fail() {}, isOpen: () => true, close() {}, destroy() {}};
  const api = {
    ui: {settings: {
      openConnectionLoading() {return loading;},
      openCustomConnection(state: CustomConnectionState) {opened.push(state); return loading;},
    }} as unknown as Application,
    request: (async (path: string, input: unknown) => {
      reads.push({path, input});
      if (!connection) throw new Error('A new connection must not load existing data');
      return connection;
    }) as ApiRequest,
    mutate: async () => true,
    settings() {},
    error: () => '',
  } satisfies Pick<SDKFeatureAPI, 'ui' | 'request' | 'settings' | 'mutate' | 'error'>;
  return {controller: createCustomUI(api), opened, reads};
}

test('a new connection starts with one independent blank model and does not issue a read', async () => {
  const h = harness();
  await h.controller.custom();
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.opened[0], {name: '', baseUrl: '', api: 'openai-completions', editing: false, models: [{id: '', contextWindow: 128000, maxTokens: 8192}]});
  h.opened[0].models[0].id = 'unsaved';
  h.opened[0].models[0].contextWindow = 64000;
  await h.controller.custom();
  assert.deepEqual(h.opened[1].models, [{id: '', contextWindow: 128000, maxTokens: 8192}]);
  assert.notEqual(h.opened[0].models[0], h.opened[1].models[0]);
  h.controller.destroy();
});

test('editing preserves existing model definitions including absent limits and explicit values', async () => {
  const connection: Connection = {name: 'Existing', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [
    {id: 'unknown-limits'},
    {id: 'custom-limits', name: 'Saved 中文', contextWindow: 256000, maxTokens: 16384, reasoning: true, input: ['text', 'image'], cost: {input: 1, output: 2, cacheRead: 3, cacheWrite: 4}},
  ]};
  const original = structuredClone(connection), h = harness(connection);
  await h.controller.custom('existing');
  assert.deepEqual(h.reads, [{path: '/api/custom-connection', input: {query: {id: 'existing'}}}]);
  assert.deepEqual(h.opened[0], {...original, editing: true});
  assert.notEqual(h.opened[0].models, connection.models);
  assert.deepEqual(connection, original);
  h.controller.destroy();
});

test('editing an empty existing model list does not inject new-model defaults', async () => {
  const h = harness({name: 'Empty', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: []});
  await h.controller.custom('empty');
  assert.deepEqual(h.opened[0].models, []);
  h.controller.destroy();
});
