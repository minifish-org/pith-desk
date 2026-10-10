import test from 'node:test';
import assert from 'node:assert/strict';
import { findRanges } from '../src/conversation-reader.ts';

test('find treats regular-expression characters as literal user text', () => {
  assert.deepEqual(findRanges('a+b [x] a+b', 'a+b'), [{ start: 0, end: 3 }, { start: 8, end: 11 }]);
  assert.deepEqual(findRanges('look for [x] or .*', '[x]'), [{ start: 9, end: 12 }]);
  assert.deepEqual(findRanges('look for [x] or .*', '.*'), [{ start: 16, end: 18 }]);
  assert.deepEqual(findRanges('anything', ''), []);
});

test('find preserves offsets for Chinese, emoji, mixed-case text and newlines', () => {
  const text = '截图😀\nCODE code 截图';
  assert.deepEqual(findRanges(text, '截图'), [{ start: 0, end: 2 }, { start: 15, end: 17 }]);
  assert.deepEqual(findRanges(text, 'code'), [{ start: 5, end: 9 }, { start: 10, end: 14 }]);
  assert.deepEqual(findRanges(text, '😀'), [{ start: 2, end: 4 }]);
  assert.deepEqual(findRanges(text, 'missing'), []);
});
