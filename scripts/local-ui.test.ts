import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {localUIArguments,localUIResolution,readLocalUI} from './local-ui.ts';

test('local UI is opt-in, consumes only its own flag and rejects missing or conflicting paths',() => {
  assert.deepEqual(localUIArguments(['--data-dir','/tmp/desk']),{uiSource: undefined,args: ['--data-dir','/tmp/desk']});
  assert.deepEqual(localUIArguments(['--ui-source','../pith-ui','--data-dir=/tmp/desk']),{uiSource: '../pith-ui',args: ['--data-dir=/tmp/desk']});
  assert.deepEqual(localUIArguments(['--ui-source=../pith-ui']),{uiSource: '../pith-ui',args: []});
  for (const args of [['--ui-source'],['--ui-source='],['--ui-source','--listen'],['--ui-source=a','--ui-source=b']]) assert.throws(() => localUIArguments(args));
  assert.equal(localUIResolution(undefined),undefined);
});

test('source resolution covers only the three public entries without changing registry metadata',async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'desk-local-ui-'));
  t.after(() => rm(directory,{recursive: true,force: true}));
  await mkdir(path.join(directory,'src/recipes'),{recursive: true});
  const metadata = JSON.stringify({name: 'pith-ui',version: '0.0.0-unpublished'});
  await writeFile(path.join(directory,'package.json'),metadata);
  for (const name of ['src/index.ts','src/recipes/index.ts','src/styles.css']) await writeFile(path.join(directory,name),'');
  const source = await readLocalUI(directory),resolution = localUIResolution(source)!;
  assert.equal(resolution.alias.length,3);
  for (const entry of ['pith-ui','pith-ui/recipes','pith-ui/styles.css']) assert.equal(resolution.alias.filter(alias => alias.find.test(entry)).length,1);
  for (const entry of ['pith-ui/dist/dom.js','pith-ui/recipes/private','pith-ui/app','other-pith-ui']) assert.equal(resolution.alias.some(alias => alias.find.test(entry)),false);
  assert.equal(await readFile(path.join(directory,'package.json'),'utf8'),metadata);
  await writeFile(path.join(directory,'package.json'),JSON.stringify({name: 'other'}));
  await assert.rejects(readLocalUI(directory),/Pith UI checkout/);
});
