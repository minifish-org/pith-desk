import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPageRanges, previewPageBytes } from '../src/paged-preview.ts';

test('8 MiB previews page without losing Unicode, long lines or code fences', () => {
  const text = '```ts\n' + '中文🙂'.repeat(850000) + '\n```\nLast line';
  const bytes = new TextEncoder().encode(text);
  const ranges = previewPageRanges(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  assert.ok(ranges.length > 30);
  let end = 0;
  const parts = ranges.map(([start, next]) => {
    assert.equal(start, end);
    assert.ok(next > start && next - start <= previewPageBytes);
    end = next;
    return decoder.decode(bytes.subarray(start, next));
  });
  assert.equal(parts.join(''), text);
  assert.equal(end, bytes.length);
});

test('normal line boundaries and empty files remain usable', () => {
  const bytes = new TextEncoder().encode('a\nbb\nccc\ndddd\n');
  const ranges = previewPageRanges(bytes, 8);
  assert.deepEqual(ranges, [[0, 5], [5, 9], [9, 14]]);
  assert.deepEqual(previewPageRanges(new Uint8Array()), [[0, 0]]);
});
