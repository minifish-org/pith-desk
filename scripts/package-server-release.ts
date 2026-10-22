import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {releaseVersion} from './update-release.ts';

interface ReleaseIdentity {
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
}

// The caller builds the shared embedded UI once before packaging either mode.
export function packageServerRelease(root: string,output: string,identity: ReleaseIdentity) {
  mkdirSync(output,{recursive: true});
  for (const architecture of ['amd64','arm64'] as const) {
    const env = {...process.env,GOWORK: 'off',CGO_ENABLED: '0',GOOS: 'linux',GOARCH: architecture,COPYFILE_DISABLE: '1'};
    function run(command: string,args: string[],capture = false): string {
      const result = spawnSync(command,args,{cwd: root,env,encoding: 'utf8',stdio: capture ? 'pipe' : 'inherit'});
      if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${capture ? result.stderr : result.error || 'see output above'}`);
      return capture ? result.stdout.trim() : '';
    }
    const stage = join(root,'build/server-release',`linux-${architecture}`);
    rmSync(stage,{recursive: true,force: true});
    mkdirSync(stage,{recursive: true});
    const executable = join(stage,'pith-desk-server');
    run('go',['build','-trimpath','-ldflags',`-s -w -X github.com/minifish-org/pith-desk/internal/desk.Version=${identity.version}`,'-o',executable,'./cmd/pith-desk-server']);
    const binary = readFileSync(executable);
    const machine = architecture === 'amd64' ? 62 : 183;
    if (binary.subarray(0,4).toString() !== '\x7fELF' || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== machine) {
      throw new Error(`Expected a Linux ${architecture} ELF executable.`);
    }
    const build = run('go',['version','-m',executable],true);
    if (!['CGO_ENABLED=0','GOOS=linux',`GOARCH=${architecture}`].every(field => build.includes(field))) {
      throw new Error(`Expected a CGO-free Linux ${architecture} build.`);
    }
    const provenance = {...identity,sourceURL: `https://github.com/minifish-org/pith-desk/tree/${identity.sourceCommit}`,architectures: [architecture],os: 'linux',cgo: false};
    writeFileSync(join(stage,'pith-desk-release.json'),JSON.stringify(provenance,null,2)+'\n');
    cpSync(join(root,'LICENSE'),join(stage,'LICENSE'));
    cpSync(join(root,'third_party'),join(stage,'third_party'),{recursive: true});
    mkdirSync(join(stage,'docs'));
    cpSync(join(root,'docs/THIRD_PARTY.md'),join(stage,'docs/THIRD_PARTY.md'));
    const filename = `pith-desk-server-${identity.version}-linux-${architecture}.tar.gz`;
    const archive = join(output,filename);
    run('tar',['--format','ustar','-czf',archive,'-C',stage,'pith-desk-server','pith-desk-release.json','LICENSE','third_party','docs/THIRD_PARTY.md']);
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(archive+'.sha256',`${sha256}  ${filename}\n`);
    writeFileSync(archive+'.json',JSON.stringify({...provenance,file: filename,sha256},null,2)+'\n');
    console.log(`Created ${archive}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/package-server-release.ts');
  const root = resolve(import.meta.dirname,'..');
  const base = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
  const version = releaseVersion(base,process.env.RELEASE_TAG || process.env.PITH_DESK_RELEASE_VERSION);
  const sourceCommit = spawnSync('git',['rev-parse','HEAD'],{cwd: root,encoding: 'utf8'});
  const sourceStatus = spawnSync('git',['status','--porcelain'],{cwd: root,encoding: 'utf8'});
  if (sourceCommit.status !== 0 || sourceStatus.status !== 0) throw new Error('Cannot read release source identity.');
  packageServerRelease(root,join(root,'build/releases'),{version,sourceCommit: sourceCommit.stdout.trim(),sourceDirty: !!sourceStatus.stdout.trim()});
}
