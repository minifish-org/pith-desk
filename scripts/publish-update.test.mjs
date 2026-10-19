import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function publish(mode, version = '0.1.0-rc.20', tag = `v${version}`) {
  const root = mkdtempSync(join(tmpdir(), 'desk-feed-test-'));
  try {
    mkdirSync(join(root, 'build/releases'), { recursive: true });
    const manifests = ['darwin-arm64', 'linux-amd64'].map(target => ({version, url: `https://github.com/minifish-org/pith-desk/releases/download/v${version}/app-${target}.tar.gz`}));
    for (const [index, target] of ['darwin-arm64', 'linux-amd64'].entries()) {
      writeFileSync(join(root, `build/releases/update-${target}.json`), JSON.stringify(manifests[index]));
    }
    writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.argv[3].replace('repos/minifish-org/pith-desk/', '');
const method = process.argv[5];
const body = process.argv.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync('calls.jsonl', JSON.stringify({ path, method, body }) + '\\n');
const mode = ${JSON.stringify(mode)};
let result;
if (path.startsWith('releases/tags/')) result = { draft: mode === 'draft', assets: mode === 'missing' ? [] : ${JSON.stringify(manifests)}.filter((_, index) => mode !== 'missing-linux' || index === 0).map(manifest => ({browser_download_url: manifest.url + (mode === 'wrong-archive' ? '.other' : '')})) };
else if (path === 'git/ref/heads/updates') {
  if (mode === 'first') { process.stderr.write('HTTP 404'); process.exit(1); }
  result = { object: { sha: 'previous-commit' } };
} else if (path.startsWith('contents/')) {
  if (mode === 'add-linux' && path.includes('linux-amd64')) { process.stderr.write('HTTP 404'); process.exit(1); }
  const version = mode === 'older' || (mode === 'add-linux' && path.includes('darwin-arm64')) ? '0.1.0-rc.21' : '0.1.0-rc.19';
  result = { content: Buffer.from(JSON.stringify({version})).toString('base64') };
}
else if (path === 'git/commits/previous-commit') result = { tree: { sha: 'previous-tree' } };
else if (path === 'git/trees') result = { sha: 'new-tree' };
else if (path === 'git/commits') result = { sha: 'new-commit' };
else if (path === 'git/refs' || path === 'git/refs/heads/updates') result = {};
else throw new Error('Unexpected GitHub path ' + path);
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'publish-update.ts')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RELEASE_TAG: tag },
    });
    let calls = [];
    try { calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { /* tag failure precedes requests */ }
    return { ...result, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('feed requires the published archive, rejects drafts and cannot move backward', () => {
  for (const mode of ['missing', 'missing-linux', 'wrong-archive', 'draft']) {
    const result = publish(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /Publish the release and update archive/);
  }
  const mismatch = publish('first', '0.1.0-rc.20', 'v0.1.0-rc.19');
  assert.notEqual(mismatch.status, 0);
  assert.equal(mismatch.calls.length, 0);
  const older = publish('older');
  assert.equal(older.status, 0, older.stderr);
  assert.equal(older.calls.some(call => call.method !== 'GET'), false);
});

test('feed publishes its manifest without a release JSON attachment and never forces history', () => {
  for (const mode of ['first', 'advance']) {
    const result = publish(mode);
    assert.equal(result.status, 0, result.stderr);
    const tree = result.calls.find(call => call.path === 'git/trees');
    assert.deepEqual(tree.body.tree.map(entry => entry.path), ['preview/update-darwin-arm64.json', 'preview/update-linux-amd64.json']);
    for (const entry of tree.body.tree) assert.equal(JSON.parse(entry.content).version, '0.1.0-rc.20');
    const commit = result.calls.find(call => call.path === 'git/commits');
    assert.deepEqual(commit.body.parents, mode === 'first' ? [] : ['previous-commit']);
    const ref = result.calls.at(-1);
    assert.deepEqual(ref.body, mode === 'first' ? { ref: 'refs/heads/updates', sha: 'new-commit' } : { sha: 'new-commit', force: false });
  }
});

test('a missing Linux feed is introduced without moving an existing newer Mac feed backward', () => {
  const result = publish('add-linux');
  assert.equal(result.status, 0, result.stderr);
  const tree = result.calls.find(call => call.path === 'git/trees');
  assert.deepEqual(tree.body.tree.map(entry => entry.path), ['preview/update-linux-amd64.json']);
  assert.equal(JSON.parse(tree.body.tree[0].content).version, '0.1.0-rc.20');
  assert.equal(tree.body.base_tree, 'previous-tree');
});
