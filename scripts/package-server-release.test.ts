import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packageServerRelease} from './package-server-release.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(),'pith-server-release-'));
  t.after(() => rmSync(root,{recursive: true,force: true}));
  for (const directory of ['cmd/pith-desk-server','internal/desk','third_party','docs']) mkdirSync(join(root,directory),{recursive: true});
  writeFileSync(join(root,'go.mod'),'module github.com/minifish-org/pith-desk\n\ngo 1.24\n');
  writeFileSync(join(root,'internal/desk/version.go'),'package desk\nvar Version = "dev"\n');
  writeFileSync(join(root,'cmd/pith-desk-server/main.go'),'package main\nimport("fmt";"github.com/minifish-org/pith-desk/internal/desk")\nfunc main(){fmt.Println(desk.Version)}\n');
  writeFileSync(join(root,'LICENSE'),'Fixture license\n');
  writeFileSync(join(root,'third_party/NOTICE'),'Fixture dependency notice\n');
  writeFileSync(join(root,'docs/THIRD_PARTY.md'),'Fixture dependency summary\n');
  writeFileSync(join(root,'server-token'),'private fixture, must not ship');
  return root;
}

test('Server archives contain executable amd64/arm64 binaries, notices, identity and matching checksums', {timeout: 120_000}, t => {
  const root = fixture(t);
  const output = join(root,'build/releases');
  const identity = {version: '0.1.0-rc.41',sourceCommit: '1234567890abcdef1234567890abcdef12345678',sourceDirty: true};
  const stale = join(root,'build/server-release/linux-amd64');
  mkdirSync(stale,{recursive: true});
  writeFileSync(join(stale,'server-token'),'stale private fixture');
  packageServerRelease(root,output,identity);
  for (const architecture of ['amd64','arm64']) {
    const filename = `pith-desk-server-${identity.version}-linux-${architecture}.tar.gz`;
    const archive = join(output,filename);
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    assert.equal(readFileSync(archive+'.sha256','utf8'),`${sha256}  ${filename}\n`);
    const extracted = join(root,`extracted-${architecture}`);
    mkdirSync(extracted);
    execFileSync('tar',['-xzf',archive,'-C',extracted]);
    const executable = join(extracted,'pith-desk-server');
    assert.ok(statSync(executable).mode & 0o111,'archive must preserve executable permissions');
    const binary = readFileSync(executable);
    assert.equal(binary.subarray(0,4).toString(),'\x7fELF');
    assert.equal(binary[4],2,'64-bit ELF');
    assert.equal(binary.readUInt16LE(18),architecture === 'amd64' ? 62 : 183);
    const build = execFileSync('go',['version','-m',executable],{encoding: 'utf8'});
    for (const field of ['CGO_ENABLED=0','GOOS=linux',`GOARCH=${architecture}`]) assert.ok(build.includes(field),field);
    assert.ok(binary.includes(Buffer.from(identity.version)),'the linked executable must contain the release version');
    assert.equal(readFileSync(join(extracted,'LICENSE'),'utf8'),'Fixture license\n');
    assert.equal(readFileSync(join(extracted,'third_party/NOTICE'),'utf8'),'Fixture dependency notice\n');
    assert.equal(readFileSync(join(extracted,'docs/THIRD_PARTY.md'),'utf8'),'Fixture dependency summary\n');
    const provenance = JSON.parse(readFileSync(join(extracted,'pith-desk-release.json'),'utf8'));
    assert.deepEqual(provenance,{...identity,sourceURL: `https://github.com/minifish-org/pith-desk/tree/${identity.sourceCommit}`,architectures: [architecture],os: 'linux',cgo: false});
    assert.deepEqual(JSON.parse(readFileSync(archive+'.json','utf8')),{...provenance,file: filename,sha256});
    assert.equal(existsSync(join(extracted,'server-token')),false);
    if (process.platform === 'linux' && process.arch === (architecture === 'amd64' ? 'x64' : 'arm64')) {
      assert.equal(execFileSync(executable,{encoding: 'utf8'}).trim(),identity.version);
    }
  }
  assert.equal(existsSync(join(stale,'server-token')),false,'clear old staging files');
  assert.equal(existsSync(join(output,'update-linux-amd64.json')),false,'Server packages do not replace the Desktop update feed');
});

test('a failed Server build stops packaging before an archive can be uploaded', t => {
  const root = fixture(t);
  writeFileSync(join(root,'cmd/pith-desk-server/main.go'),'invalid Go source\n');
  const output = join(root,'build/releases');
  assert.throws(() => packageServerRelease(root,output,{version: '0.1.0-rc.41',sourceCommit: 'fixture',sourceDirty: false}),/go failed/);
  assert.equal(existsSync(join(output,'pith-desk-server-0.1.0-rc.41-linux-amd64.tar.gz')),false);
});

test('tag publication attaches all four packages and checksums in preview and signed releases', t => {
  const root = fixture(t);
  const workflow = readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  // Run the actual publication shell with a recording CLI, without publishing.
  const step = workflow.split('      - name: Publish tagged build\n')[1].split('\n      - name:')[0];
  const script = step.split('        run: |\n')[1].replace(/^ {10}/gm,'');
  const bin = join(root,'bin');
  mkdirSync(bin);
  writeFileSync(join(bin,'gh'),`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.GH_RECORD,JSON.stringify(process.argv.slice(2)));\n`,{mode: 0o755});
  const expected = ['pith-desk-0.1.0-rc.41-darwin-arm64','pith-desk-0.1.0-rc.41-linux-amd64','pith-desk-server-0.1.0-rc.41-linux-amd64','pith-desk-server-0.1.0-rc.41-linux-arm64']
    .flatMap(name => [`build/releases/${name}.tar.gz`,`build/releases/${name}.tar.gz.sha256`]);
  mkdirSync(join(root,'build/releases'),{recursive: true});
  for (const asset of expected) writeFileSync(join(root,asset),'fixture release asset\n');
  for (const preview of ['true','false']) {
    const record = join(root,`gh-${preview}.json`);
    const result = spawnSync('bash',['-e','-o','pipefail','-c',script],{cwd: root,encoding: 'utf8',env: {...process.env,PATH: `${bin}:${process.env.PATH}`,GH_RECORD: record,RELEASE_TAG: 'v0.1.0-rc.41',PREVIEW: preview}});
    assert.equal(result.status,0,result.stderr);
    const args: string[] = JSON.parse(readFileSync(record,'utf8'));
    assert.deepEqual(args.slice(0,3),['release','create','v0.1.0-rc.41']);
    assert.deepEqual(args.slice(3,11),expected);
    assert.ok(args.includes('--verify-tag'));
    assert.equal(args.includes('--prerelease'),preview === 'true');
    assert.equal(args.includes('--generate-notes'),preview === 'false');
  }
  rmSync(join(root,expected.at(-1)!));
  const record = join(root,'gh-missing-server.json');
  const missing = spawnSync('bash',['-e','-o','pipefail','-c',script],{cwd: root,encoding: 'utf8',env: {...process.env,PATH: `${bin}:${process.env.PATH}`,GH_RECORD: record,RELEASE_TAG: 'v0.1.0-rc.41',PREVIEW: 'true'}});
  assert.notEqual(missing.status,0,'a missing Server checksum must stop publication');
  assert.equal(existsSync(record),false,'do not create a partial Release');
});
