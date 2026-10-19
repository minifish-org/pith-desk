// Publish MyGo's Linux portable archive for both installation and signed updates.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {loadUpdateKey,releaseVersion,signUpdateArchive} from './update-release.ts';

if (process.argv.length > 2) throw new Error('Usage: node scripts/package-linux-release.ts');
const root = resolve(import.meta.dirname,'..');
const base = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const version = releaseVersion(base,process.env.RELEASE_TAG || process.env.PITH_DESK_RELEASE_VERSION);
const updateKey = loadUpdateKey(root);
const env = {...process.env,GOWORK: 'off',CGO_ENABLED: '0',PITH_DESK_LINUX_RELEASE_VERSION: version};
function run(command: string,args: string[],capture = false): string {
  const result = spawnSync(command,args,{cwd: root,env,encoding: 'utf8',stdio: capture ? 'pipe' : 'inherit'});
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${capture ? result.stderr : 'see output above'}`);
  return capture ? result.stdout.trim() : '';
}
const sourceCommit = run('git',['rev-parse','HEAD'],true);
const sourceDirty = !!run('git',['status','--porcelain'],true);
const metadata = join(root,'build/linux-release-metadata');
mkdirSync(metadata,{recursive: true});
writeFileSync(join(metadata,'pith-desk-release.json'),JSON.stringify({version,sourceCommit})+'\n');
run('npm',['run','build:ui']);
run('npx',['--no-install','mygo','build','-skip-build-command','-platform','linux/amd64','-o','build/release']);
const stage = join(root,'build/release/linux-amd64');
const binary = readFileSync(join(stage,'pith-desk'));
if (binary.subarray(0,4).toString() !== '\x7fELF' || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== 62) throw new Error('Expected a Linux x86-64 ELF executable.');
const build = run('go',['version','-m',join(stage,'pith-desk')],true);
if (!['CGO_ENABLED=0','GOOS=linux','GOARCH=amd64'].every(field => build.includes(field))) throw new Error('Expected a CGO-free Linux amd64 build.');
const output = join(root,'build/releases');
mkdirSync(output,{recursive: true});
const archive = `pith-desk-${version}-linux-amd64.tar.gz`;
copyFileSync(join(stage,archive),join(output,archive));
signUpdateArchive(join(output,archive),'linux-amd64',version,updateKey,readFileSync(join(root,'docs/RELEASE_PREVIEW.md'),'utf8'));
const sha256 = createHash('sha256').update(readFileSync(join(output,archive))).digest('hex');
writeFileSync(join(output,archive+'.json'),JSON.stringify({version,file: archive,sha256,sourceCommit,sourceDirty,sourceURL: `https://github.com/minifish-org/pith-desk/tree/${sourceCommit}`,architectures: ['amd64'],os: 'linux',cgo: false},null,2)+'\n');
console.log(`Created ${join(output,archive)}`);
