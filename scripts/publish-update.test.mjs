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
    const manifest = { version, url: `https://github.com/minifish-org/pith-desk/releases/download/v${version}/app.tar.gz` };
    writeFileSync(join(root, 'build/releases/update-darwin-arm64.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.argv[3].replace('repos/minifish-org/pith-desk/', '');
const method = process.argv[5];
const body = process.argv.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync('calls.jsonl', JSON.stringify({ path, method, body }) + '\\n');
const mode = ${JSON.stringify(mode)};
let result;
if (path.startsWith('releases/tags/')) result = { draft: mode === 'draft', assets: [{ browser_download_url: ${JSON.stringify(manifest.url)} }, ...(mode === 'missing' ? [] : [{ name: 'update-darwin-arm64.json' }])] };
else if (path === 'git/ref/heads/updates') {
  if (mode === 'first') { process.stderr.write('HTTP 404'); process.exit(1); }
  result = { object: { sha: 'previous-commit' } };
} else if (path.startsWith('contents/')) result = { content: Buffer.from(JSON.stringify({ version: mode === 'older' ? '0.1.0-rc.21' : '0.1.0-rc.19' })).toString('base64') };
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

test('feed appears only after both published assets exist and cannot move backward', () => {
  for (const mode of ['missing', 'draft']) {
    const result = publish(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
    assert.match(result.stderr, /Publish the release and update assets/);
  }
  const mismatch = publish('first', '0.1.0-rc.20', 'v0.1.0-rc.19');
  assert.notEqual(mismatch.status, 0);
  assert.equal(mismatch.calls.length, 0);
  const older = publish('older');
  assert.equal(older.status, 0, older.stderr);
  assert.equal(older.calls.some(call => call.method !== 'GET'), false);
});

test('feed creates the initial metadata branch and advances existing history without forcing', () => {
  for (const mode of ['first', 'advance']) {
    const result = publish(mode);
    assert.equal(result.status, 0, result.stderr);
    const tree = result.calls.find(call => call.path === 'git/trees');
    assert.equal(tree.body.tree[0].path, 'preview/update-darwin-arm64.json');
    assert.equal(JSON.parse(tree.body.tree[0].content).version, '0.1.0-rc.20');
    const commit = result.calls.find(call => call.path === 'git/commits');
    assert.deepEqual(commit.body.parents, mode === 'first' ? [] : ['previous-commit']);
    const ref = result.calls.at(-1);
    assert.deepEqual(ref.body, mode === 'first' ? { ref: 'refs/heads/updates', sha: 'new-commit' } : { sha: 'new-commit', force: false });
  }
});
