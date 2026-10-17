import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../..');
function sources(directory:string):string[]{return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(join(directory,entry.name)):/\.tsx?$/.test(entry.name)?[join(directory,entry.name)]:[]);}

test('Desk consumes a released component-only Pith UI package',()=>{
  const pkg=JSON.parse(readFileSync(join(root,'frontend/package.json'),'utf8'));
  const installed=JSON.parse(readFileSync(join(root,'frontend/node_modules/pith-ui/package.json'),'utf8'));
  assert.match(pkg.dependencies['pith-ui'],/^0\.(?:[4-9]|[1-9]\d+)\.\d+$/);
  assert.equal(installed.version,pkg.dependencies['pith-ui']);
  assert.deepEqual(Object.keys(installed.exports).sort(),['.','./styles.css']);
});

test('all Desk presentation imports use public small components and local page composition',()=>{
  for(const file of sources(join(root,'frontend/src'))){
    const text=readFileSync(file,'utf8');
    assert.doesNotMatch(text,/['"]pith-ui\/(?!styles\.css['"])/,file);
    assert.doesNotMatch(text,/from\s*['"][^'"]*(?:node_modules|pith-ui\/src|pith-ui\/dist)/,file);
  }
  const view=readFileSync(join(root,'frontend/src/ui-mount.ts'),'utf8');
  assert.doesNotMatch(view,/createApplication/);
  assert.match(view,/mount/);
});
