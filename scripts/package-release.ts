// Builds a self-contained Mac archive. No credentials enter an app bundle.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const signed = process.argv.includes('--signed');
if (process.argv.slice(2).some((arg) => arg !== '--signed')) throw new Error('Usage: node --experimental-strip-types scripts/package-release.ts [--signed]');
if (process.platform !== 'darwin') throw new Error('Mac packaging requires macOS.');
const identity = process.env.PITH_DESK_SIGNING_IDENTITY;
const profile = process.env.PITH_DESK_NOTARY_PROFILE;
const keychain = process.env.PITH_DESK_NOTARY_KEYCHAIN;
if (signed && (!identity?.startsWith('Developer ID Application:') || !profile)) {
  throw new Error('Signed releases require PITH_DESK_SIGNING_IDENTITY (Developer ID Application) and PITH_DESK_NOTARY_PROFILE. No unsigned fallback is allowed.');
}
const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('Use a numeric three-part app version; release tags may have prerelease suffixes.');
function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, CGO_ENABLED: '0' }, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${capture ? result.stderr : 'see output above'}`);
  return capture ? result.stdout.trim() : '';
}
const sourceCommit = run('git', ['rev-parse', 'HEAD'], true);
const sourceDirty = !!run('git', ['status', '--porcelain'], true);
run('npm', ['run', 'build:ui']);
run('npx', ['--no-install', 'mygo', 'build', '-skip-build-command', '-platform', 'darwin/arm64', '-skip-dmg', '-skip-notarize', '-o', 'build/release', '-sign', '-']);
const app = join(root, 'build/release/darwin-arm64/Pith Desk.app');
const binary = join(app, 'Contents/MacOS/Pith Desk');
const architectures = run('lipo', ['-archs', binary], true).split(/\s+/).sort();
if (architectures.join(',') !== 'arm64') throw new Error('Expected an Apple Silicon Mac app containing only arm64.');
const output = join(root, 'build/releases');
mkdirSync(output, { recursive: true });
if (signed) {
  run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity!, app]);
  const submission = join(output, 'notary-submission.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, submission]);
  const result = JSON.parse(run('xcrun', ['notarytool', 'submit', submission, '--keychain-profile', profile!, '--wait', '--output-format', 'json', ...(keychain ? ['--keychain', keychain] : [])], true));
  if (result.status !== 'Accepted') throw new Error(`Notarization was not accepted (${result.status}); no release archive created.`);
  run('xcrun', ['stapler', 'staple', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
}
run('codesign', ['--verify', '--deep', '--strict', app]);
if (!run('go', ['version', '-m', binary], true).includes('CGO_ENABLED=0')) throw new Error('The release binary was built with CGO enabled.');
const filename = `pith-desk-${version}-macos-arm64${signed ? '' : '-preview'}.zip`;
const archive = join(output, filename);
run('ditto', ['-c', '-k', '--keepParent', app, archive]);
const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(join(output, `${filename}.sha256`), `${checksum}  ${filename}\n`);
writeFileSync(join(output, `${filename}.json`), JSON.stringify({ version, file: filename, sha256: checksum, sourceCommit, sourceDirty, sourceURL: `https://github.com/minifish-org/pith-desk/tree/${sourceCommit}`, architectures, cgo: false, developerIDSigned: signed, notarized: signed }, null, 2)+'\n');
console.log(`Created ${archive}`);
console.log(signed ? 'Developer ID signed, notarized and stapled.' : 'Ad-hoc signed preview: Gatekeeper may block this download. This is not a notarized release.');
