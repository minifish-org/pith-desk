import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrafts, draftKey } from '../src/drafts.ts';

function storage() {
  const records = new Map(), saves = [], errors = [];
  const request = async (_path, input, options) => {
    const key = draftKey(input.query || input);
    if (input.query) return records.get(key) || { text: '', revision: 0 };
    saves.push({ input, options });
    const existing = records.get(key) || { text: '', revision: 0 };
    if (input.revision > existing.revision) records.set(key, { text: input.text, revision: input.revision });
    return records.get(key);
  };
  return { request, records, saves, errors, drafts: () => createDrafts(request, (error) => errors.push(error), 10000) };
}

test('conversation and workspace drafts stay separate and survive a new frontend', async () => {
  const db = storage(), drafts = db.drafts();
  const scopes = [{ id: 'a' }, { id: 'b' }, { workspaceId: 'workspace' }];
  for (const [index, scope] of scopes.entries()) {
    await drafts.load(scope);
    drafts.update(scope, `Draft ${index} 中文`);
  }
  await drafts.flushAll();
  const restarted = db.drafts();
  for (const [index, scope] of scopes.entries()) assert.equal((await restarted.load(scope)).text, `Draft ${index} 中文`);
  assert.deepEqual(db.errors, []);
});

test('successful submission clears only its own unchanged draft', async () => {
  const db = storage(), drafts = db.drafts();
  await drafts.load({ id: 'a' });
  await drafts.load({ id: 'b' });
  drafts.update({ id: 'a' }, 'submitted');
  drafts.update({ id: 'b' }, 'another conversation');
  drafts.clearIfUnchanged({ id: 'a' }, 'submitted');
  await drafts.flushAll();
  assert.equal(db.records.get('conversation:a').text, '');
  assert.equal(db.records.get('conversation:b').text, 'another conversation');
  drafts.update({ id: 'a' }, 'typed while sending');
  drafts.clearIfUnchanged({ id: 'a' }, 'submitted');
  await drafts.flushAll();
  assert.equal(db.records.get('conversation:a').text, 'typed while sending');
});

test('unload save uses authentication transport and a newer revision than an in-flight autosave', async () => {
  const db = storage();
  let completeOld;
  const saves = [];
  const request = async (path, input, options) => {
    if (input.query) return db.request(path, input, options);
    saves.push(input);
    if (saves.length === 1) await new Promise((resolve) => { completeOld = resolve; });
    return db.request(path, input, options);
  };
  const drafts = createDrafts(request, () => {}, 10000);
  const scope = { id: 'a' };
  await drafts.load(scope);
  drafts.update(scope, 'old');
  const oldSave = drafts.flush(scope);
  drafts.update(scope, 'last keystrokes');
  await drafts.flushAll({ keepalive: true });
  completeOld();
  await oldSave;
  assert.equal(db.records.get('conversation:a').text, 'last keystrokes');
  assert.ok(saves[1].revision > saves[0].revision);
  assert.equal(db.saves[0].options.keepalive, true);
});

test('failed saves preserve the local draft for a later flush and deleted conversations cancel pending saves', async () => {
  const db = storage();
  let fail = true;
  const request = async (path, input, options) => {
    if (!input.query && fail) throw new Error('disk unavailable');
    return db.request(path, input, options);
  };
  const drafts = createDrafts(request, (error) => db.errors.push(error), 10000);
  await drafts.load({ id: 'a' });
  drafts.update({ id: 'a' }, 'keep me');
  await assert.rejects(drafts.flush({ id: 'a' }), /disk unavailable/);
  fail = false;
  await drafts.flushAll();
  assert.equal(db.records.get('conversation:a').text, 'keep me');
  drafts.update({ id: 'a' }, 'deleted');
  drafts.prune([], []);
  await drafts.flushAll();
  assert.equal(db.saves.length, 1);
});
