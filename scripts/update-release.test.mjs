import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadUpdateKey, packageUpdate, releaseVersion, compareReleaseVersions } from './update-release.ts';

test('release identity distinguishes RC versions and refuses unrelated tags', () => {
  assert.equal(releaseVersion('0.1.0', 'v0.1.0-rc.20'), '0.1.0-rc.20');
  for (const tag of ['v0.2.0', 'not-a-version', 'v0.1.0/other']) assert.throws(() => releaseVersion('0.1.0', tag));
  for (const [older, newer] of [['0.1.0-rc.9', '0.1.0-rc.10'], ['0.1.0-rc.20', '0.1.0'], ['0.1.0', '0.2.0-dev.1']]) {
    assert.ok(compareReleaseVersions(older, newer) < 0);
    assert.ok(compareReleaseVersions(newer, older) > 0);
  }
  assert.equal(compareReleaseVersions('0.1.0-rc.20', '0.1.0-rc.20'), 0);
});

test('final app archive has a valid signature, executable permissions and immutable release URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'desk-update-package-'));
  const previous = process.env.PITH_DESK_UPDATE_PRIVATE_KEY;
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const appParent = join(root, 'stage'); const output = join(root, 'output');
    mkdirSync(join(root, 'resources'), { recursive: true }); mkdirSync(output);
    mkdirSync(join(appParent, 'Pith Desk.app/Contents/MacOS'), { recursive: true });
    writeFileSync(join(appParent, 'Pith Desk.app/Contents/MacOS/Pith Desk'), 'final signed app fixture', { mode: 0o755 });
    writeFileSync(join(root, 'resources/update-public-key.txt'), publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'));
    process.env.PITH_DESK_UPDATE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const manifest = packageUpdate(root, appParent, output, '0.1.0-rc.20', loadUpdateKey(root), 'Update notes');
    const archive = readFileSync(join(output, 'pith-desk-0.1.0-rc.20-darwin-arm64.tar.gz'));
    assert.equal(archive.length, manifest.size);
    assert.equal(manifest.url, 'https://github.com/minifish-org/pith-desk/releases/download/v0.1.0-rc.20/pith-desk-0.1.0-rc.20-darwin-arm64.tar.gz');
    const digest = createHash('sha256').update(archive).digest();
    assert.equal(readFileSync(join(output, 'pith-desk-0.1.0-rc.20-darwin-arm64.tar.gz.sha256'), 'utf8'), `${digest.toString('hex')}  pith-desk-0.1.0-rc.20-darwin-arm64.tar.gz\n`);
    assert.ok(verify(null, digest, publicKey, Buffer.from(manifest.signature, 'base64')));
    assert.equal(verify(null, Buffer.alloc(32), publicKey, Buffer.from(manifest.signature, 'base64')), false);
    const extracted = join(root, 'extracted'); mkdirSync(extracted);
    const result = spawnSync('tar', ['-xzf', join(output, 'pith-desk-0.1.0-rc.20-darwin-arm64.tar.gz'), '-C', extracted]);
    assert.equal(result.status, 0);
    assert.equal(statSync(join(extracted, 'Pith Desk.app/Contents/MacOS/Pith Desk')).mode & 0o777, 0o755);
    const wrong = generateKeyPairSync('ed25519').privateKey;
    process.env.PITH_DESK_UPDATE_PRIVATE_KEY = wrong.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => loadUpdateKey(root), /does not match/);
    assert.deepEqual(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }), publicKey.export({ type: 'spki', format: 'der' }));
  } finally {
    if (previous === undefined) delete process.env.PITH_DESK_UPDATE_PRIVATE_KEY; else process.env.PITH_DESK_UPDATE_PRIVATE_KEY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
