import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutations } from '../src/mutations.ts';

test('a successful write stays successful when its snapshot refresh fails', async () => {
  let busy = false, writes = 0, callbacks = 0, message = '';
  const mutate = createMutations({
    request: async () => { writes++; return { ok: true }; },
    refresh: async () => { throw new Error('snapshot unavailable'); },
    busy: () => busy, setBusy: (value) => { busy = value; }, error: (value) => { message = value; },
  });
  const succeeded = await mutate('/api/conversations', { workspaceId: 'a' }, () => { callbacks++; });
  if (!succeeded) await mutate('/api/conversations', { workspaceId: 'a' });
  assert.equal(writes, 1);
  assert.equal(callbacks, 1);
  assert.equal(busy, false);
  assert.match(message, /Change saved.*snapshot unavailable/);
});

test('failed writes preserve the draft callback and concurrent actions are rejected', async () => {
  let busy = false, release, callbacks = 0;
  const mutate = createMutations({ request: async () => { await new Promise((resolve) => { release = resolve; }); throw new Error('rejected'); }, refresh: async () => assert.fail('must not refresh'), busy: () => busy, setBusy: (value) => { busy = value; }, error: () => {} });
  const first = mutate('/api/send', { id: 'a', text: 'keep' }, () => { callbacks++; });
  assert.equal(await mutate('/api/send', { id: 'a', text: 'again' }), false);
  release();
  assert.equal(await first, false);
  assert.equal(callbacks, 0);
});
