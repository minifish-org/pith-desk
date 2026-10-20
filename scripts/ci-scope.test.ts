import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {selectScope} from './ci-scope.ts';

test('real PR history emits successful documentation step outputs and rejects whitespace errors',() => {
  const script = resolve('scripts/ci-scope.ts'),root = mkdtempSync(join(tmpdir(),'pith-ci-scope-'));
  const git = (args: string[]) => execFileSync('git',args,{cwd: root,encoding: 'utf8',stdio: ['ignore','pipe','pipe']});
  const commit = () => {git(['add','AGENTS.md']);git(['-c','user.name=CI Fixture','-c','user.email=ci@example.test','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture']);};
  try {
    git(['init','-q']);writeFileSync(join(root,'AGENTS.md'),'Guidance\n');commit();
    const base = git(['rev-parse','HEAD']).trim(),output = join(root,'step-output');
    writeFileSync(join(root,'AGENTS.md'),'Updated guidance\n');commit();
    const run = () => execFileSync(process.execPath,['--experimental-strip-types',script,'pull_request',base],{cwd: root,encoding: 'utf8',stdio: ['ignore','pipe','pipe'],env: {...process.env,GITHUB_OUTPUT: output}});
    assert.equal(JSON.parse(run()).mode,'docs');
    assert.match(readFileSync(output,'utf8'),/install=false\n/);
    assert.match(readFileSync(output,'utf8'),/browser=false\n/);
    writeFileSync(join(root,'AGENTS.md'),'Whitespace error \n');commit();
    assert.throws(run,/Command failed/);
  } finally {rmSync(root,{recursive: true,force: true});}
});

test('only PR documentation can omit runtime and browser work',() => {
  assert.equal(selectScope(['README.md','AGENTS.md','docs/TESTING.md']).mode,'docs');
  assert.equal(selectScope(['README.md'],'push').mode,'full');
  assert.equal(selectScope(['README.md'],'workflow_dispatch').mode,'full');
});
test('UI changes retain the frontend and both browser engines',() => {
  assert.deepEqual(selectScope(['frontend/src/files.ts','frontend/e2e/server.spec.ts','README.md']),{mode: 'ui',install: true,browser: true,runtime: false});
});
test('dependencies, public transport, build configuration and unknown paths expand coverage',() => {
  for (const file of ['go.mod','go.sum','internal/host/server.go','frontend/package-lock.json','package.json','frontend/src/contract.generated.ts','frontend/src/api.ts','frontend/src/server-session.ts','frontend/vite.config.ts','frontend/tsconfig.json','mygo.config.ts','.github/workflows/check.yml','scripts/ci-scope.ts','new-runtime/file']) {
    assert.equal(selectScope(['README.md',file]).mode,'full',file);
  }
});
test('missing history and deletions cannot silently select a smaller suite',() => {
  assert.equal(selectScope(null).mode,'full');
  assert.equal(selectScope(['internal/removed.go','docs/replacement.md']).mode,'full');
});
test('the actual selector falls back to full checks when the PR base is unavailable',() => {
  const output = execFileSync(process.execPath,['--experimental-strip-types','scripts/ci-scope.ts','pull_request','missing-ci-base-ref'],{encoding: 'utf8',env: {...process.env,GITHUB_OUTPUT: ''}});
  assert.equal(JSON.parse(output).mode,'full');
});
