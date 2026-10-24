import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from '../node_modules/typescript/lib/typescript.js';
import { createAPI, parseStream } from '../src/api.ts';
import { readPaths, mutationPaths } from '../src/contract.generated.ts';

// These files are shared with Go tests and kept fixed, not generated from the
// current DTOs. Changes require an explicit public-compatibility review.
const stateNames = ['empty', 'active', 'idle'];
const stateJSON = stateNames.map((name) => readFileSync(new URL(`../../internal/desk/testdata/state.${name}.json`, import.meta.url), 'utf8'));
const requests = JSON.parse(readFileSync(new URL('../../internal/wire/testdata/requests.json', import.meta.url), 'utf8'));
const endpoints = readFileSync(new URL('../../internal/wire/testdata/endpoints.txt', import.meta.url), 'utf8').trim().split('\n').map((line) => {
  const [method, format, path] = line.split(' ');
  return { method, format, path };
});
const headers = (json) => {
  const result = new Headers({ Authorization: 'Bearer fixture-token' });
  if (json) result.set('Content-Type', 'application/json');
  return result;
};

test('generated client routes retain the fixed public method/path manifest', () => {
  for (const [method, actual] of [['GET', readPaths], ['POST', mutationPaths]]) {
    const expected = endpoints.filter((endpoint) => endpoint.method === method && endpoint.format === 'json').map((endpoint) => endpoint.path);
    assert.deepEqual([...actual].sort(), expected.sort());
  }
});

test('fixed JSON literals compile against HTTP, the state stream and typed request contracts', () => {
  // Contextual typing of literal JSON retains enum checks; JSON.parse casts or
  // importing JSON directly would lose them. The source exists only in memory.
  const virtualFile = fileURLToPath(new URL('./contract-fixtures.virtual.ts', import.meta.url));
  const source = [
    "import type { ReadContracts, StreamContracts } from '../src/contract.generated.ts';",
    "import type { ApiRequest, ApiDownload } from '../src/api.ts';",
    'declare const request: ApiRequest;',
    'declare const download: ApiDownload;',
    ...stateJSON.flatMap((json, index) => [
      `const http${index}: ReadContracts['/api/state']['output'] = ${json};`,
      `const socket${index}: StreamContracts['/api/socket'] = ${json};`,
    ]),
    ...requests.map((fixture) => fixture.format === 'blob'
      ? `void download(${JSON.stringify(fixture.path)}, ${JSON.stringify(fixture.input)});`
      : `void request(${JSON.stringify(fixture.path)}, ${JSON.stringify(fixture.method === 'GET' ? { query: fixture.input } : fixture.input)});`),
  ].join('\n');
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => name === virtualFile
    ? ts.createSourceFile(name, source, languageVersion, true)
    : readSource(name, languageVersion, ...rest);
  const program = ts.createProgram([virtualFile], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => ts.sys.getCurrentDirectory(), getNewLine: () => '\n' });
  assert.equal(diagnostics.length, 0, formatted);
});

for (const [index, name] of stateNames.entries()) {
  test(`fixed ${name} State retains the same JSON through HTTP and the state stream`, async (t) => {
    const fixed = JSON.parse(stateJSON[index]);
    t.mock.method(globalThis, 'fetch', async (path, options) => {
      assert.equal(path, '/api/state');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.get('Authorization'), 'Bearer fixture-token');
      assert.equal(options.credentials, 'same-origin');
      return new Response(stateJSON[index], { headers: { 'Content-Type': 'application/json' } });
    });
    assert.deepEqual(await createAPI(headers).request('/api/state'), fixed);
    assert.deepEqual(parseStream('/api/socket', stateJSON[index]), fixed);
    // This verifies decoding compatibility, not runtime schema validation or
    // a real socket/reconnection flow (the separate G06 work covers those).
  });
}

for (const fixture of requests) {
  test(`fixed client request ${fixture.method} ${fixture.path} keeps its URL and payload`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls++;
      assert.equal(url, fixture.url);
      assert.equal(options.method ?? 'GET', fixture.method);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers.get('Authorization'), 'Bearer fixture-token');
      if (fixture.method === 'POST') {
        assert.equal(options.headers.get('Content-Type'), 'application/json');
        assert.deepEqual(JSON.parse(options.body), fixture.input);
      } else {
        assert.equal(options.body, undefined);
        assert.equal(options.headers.has('Content-Type'), false);
      }
      return fixture.format === 'blob' ? new Response('fixture binary', { headers: { 'Content-Type': 'image/png' } }) : Response.json({ ok: true });
    });
    const api = createAPI(headers);
    if (fixture.format === 'blob') {
      assert.equal((await api.download(fixture.path, fixture.input)).type, 'image/png');
    } else {
      await api.request(fixture.path, fixture.method === 'GET' ? { query: fixture.input } : fixture.input);
    }
    assert.equal(calls, 1);
  });
}
