import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrafts} from '../src/drafts.ts';
import {createDraftRecovery} from '../src/draft-recovery.ts';
import type {ApiRequest} from '../src/api.ts';

function storage() {
  const values = new Map<string,string>();
  return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string,value: string) => {values.set(key,value);}, removeItem: (key: string) => {values.delete(key);}, values};
}

test('revocation cancels autosave and late acknowledgements preserve the newest recovery text',async () => {
  const saved = storage(), recovery = createDraftRecovery(saved), errors: string[] = [];
  let finish!: (value: unknown) => void, writes = 0;
  const request = (() => {writes++; return new Promise(resolve => {finish = resolve;});}) as ApiRequest;
  const drafts = createDrafts(request,message => errors.push(message),5,recovery), scope = {id: 'conversation'};
  drafts.update(scope,'First text');
  const writing = drafts.flush(scope);
  drafts.update(scope,'Newest unsent text',[{id: 'image',type: 'image',data: 'PRIVATE_IMAGE_DATA',mimeType: 'image/png',name: 'image.png',size: 10}]);
  drafts.suspend();
  finish({text: 'First text',revision: 1}); await writing;
  drafts.update(scope,'old page still typing'); drafts.clearIfUnchanged(scope,'Newest unsent text');
  await drafts.flushAll(); await new Promise(resolve => setTimeout(resolve,30));
  assert.equal(writes,1); assert.deepEqual(errors,[]);
  assert.match(createDraftRecovery(saved).text(),/Newest unsent text/);
  assert.doesNotMatch(JSON.stringify([...saved.values]),/PRIVATE_IMAGE_DATA/);
});

test('a matching save clears recovery; an older save cannot erase a newer draft',async () => {
  const saved = storage(), recovery = createDraftRecovery(saved), scope = {workspaceId: 'workspace'};
  recovery.remember(scope,{text: 'old',revision: 1}); recovery.remember(scope,{text: 'new',revision: 2});
  recovery.saved(scope,{text: 'old',revision: 1}); assert.match(recovery.text(),/new/);
  recovery.saved(scope,{text: 'new',revision: 2}); assert.equal(recovery.text(),''); assert.equal(saved.values.size,0);
  recovery.remember(scope,{text: 'retrievable',revision: 3}); createDraftRecovery(saved).discard(); assert.equal(createDraftRecovery(saved).text(),'');
});

test('unavailable storage still preserves a live-page recovery copy',() => {
  const unavailable = () => {throw new Error('storage disabled');};
  const recovery = createDraftRecovery({getItem: unavailable,setItem: unavailable,removeItem: unavailable});
  recovery.remember({id: 'chat'},{text: 'Copy this from the revoked page',revision: 1});
  assert.match(recovery.text(),/Copy this/);
});

test('startup recovery only reads actual drafts and suppresses text already saved on the server',async () => {
  const saved = storage(), before = createDraftRecovery(saved);
  before.remember({id: 'saved'},{text: 'Already saved',revision: 1});
  before.remember({id: 'uncertain'},{text: 'Keep until reviewed',revision: 2});
  before.keepText('Message edit','Unsubmitted edit');
  const reloaded = createDraftRecovery(saved), reads: string[] = [];
  const text = await reloaded.recover(async scope => {reads.push(scope.id!);return {text: scope.id === 'saved' ? 'Already saved' : '',revision: 5};});
  assert.deepEqual(reads,['saved','uncertain']);
  assert.doesNotMatch(text,/Already saved/);assert.match(text,/Keep until reviewed/);assert.match(text,/Unsubmitted edit/);
  assert.doesNotMatch(reloaded.text(),/Already saved/);
});

test('discarding recovered text cannot erase a newer unsaved recovery copy',() => {
  const saved = storage(), scope = {id: 'chat'};
  createDraftRecovery(saved).remember(scope,{text: 'Recovered copy',revision: 1});
  const reloaded = createDraftRecovery(saved);
  reloaded.remember(scope,{text: 'New text on the replacement page',revision: 2});
  reloaded.discard();
  assert.match(createDraftRecovery(saved).text(),/New text on the replacement page/);
});
