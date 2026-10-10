import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePreviewBlob } from '../src/image-viewer.ts';

test('large images decode across chunk boundaries with original bytes', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 5);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const blob = await imagePreviewBlob(bytes.toString('base64'), 'image/png');
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
});

test('closing a preview cancels decoding without creating a blob', async () => {
  let active = true;
  setTimeout(() => { active = false; }, 0);
  const blob = await imagePreviewBlob(Buffer.alloc(4 * 1024 * 1024).toString('base64'), 'image/png', () => active);
  assert.equal(blob, null);
});
