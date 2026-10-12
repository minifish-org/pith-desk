import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function releaseVersion(base: string, tag?: string): string {
  const version = tag?.replace(/^v/, '') || `${base}-dev.${Date.now()}`;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version) || version.split('-')[0] !== base) {
    throw new Error('Release tag must match the numeric app version, optionally with a prerelease suffix.');
  }
  return version;
}

export function loadUpdateKey(root: string) {
  const localKey = join(homedir(), 'Library/Application Support/Pith Desk Release/updates/ed25519.key');
  const privateText = process.env.PITH_DESK_UPDATE_PRIVATE_KEY || (existsSync(localKey) ? readFileSync(localKey, 'utf8') : '');
  if (!privateText) throw new Error('Release packaging requires PITH_DESK_UPDATE_PRIVATE_KEY or the private local release key.');
  const key = createPrivateKey(privateText);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update signing requires an Ed25519 key.');
  const expected = readFileSync(join(root, 'resources/update-public-key.txt'), 'utf8').trim();
  const actual = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  if (actual !== expected) throw new Error('Update signing key does not match the public key embedded in the app.');
  return key;
}

// Sign the final app, after Developer ID signing and notarization/stapling.
// One tar.gz serves manual installation and MyGo's Ed25519(SHA256(archive)) updater.
export function packageUpdate(root: string, appParent: string, output: string, version: string, key: ReturnType<typeof loadUpdateKey>, notes: string) {
  const filename = `pith-desk-${version}-darwin-arm64.tar.gz`;
  const archive = join(output, filename);
  const result = spawnSync('tar', ['--format', 'ustar', '-czf', archive, '-C', appParent, 'Pith Desk.app'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8',
  });
  if (result.error || result.status !== 0) throw new Error(`Update archive failed: ${result.stderr || result.error}`);
  const bytes = readFileSync(archive);
  const digest = createHash('sha256').update(bytes).digest();
  writeFileSync(join(output, `${filename}.sha256`), `${digest.toString('hex')}  ${filename}\n`);
  const manifest = {
    version, notes, date: new Date().toISOString(),
    url: `https://github.com/minifish-org/pith-desk/releases/download/v${version}/${filename}`,
    size: bytes.length, signature: sign(null, digest, key).toString('base64'),
  };
  writeFileSync(join(output, 'update-darwin-arm64.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function compareReleaseVersions(a: string, b: string): number {
  const [ac, ap] = a.split('-'); const [bc, bp] = b.split('-');
  const an = ac.split('.').map(Number); const bn = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (an[i] !== bn[i]) return an[i] - bn[i];
  if (ap === bp) return 0;
  if (!ap) return 1; if (!bp) return -1;
  const av = ap.split('.'); const bv = bp.split('.');
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if (av[i] === bv[i]) continue;
    if (av[i] === undefined) return -1; if (bv[i] === undefined) return 1;
    const ai = /^\d+$/.test(av[i]); const bi = /^\d+$/.test(bv[i]);
    if (ai && bi) return Number(av[i]) - Number(bv[i]);
    if (ai !== bi) return ai ? -1 : 1;
    return av[i] < bv[i] ? -1 : 1;
  }
  return 0;
}
