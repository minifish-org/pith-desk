import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDiff } from '../src/previews.ts';

test('diff distinguishes metadata, additions and removals and escapes file content', () => {
  const html = renderDiff('--- note.md\n+++ note.md\n@@ -1 +1 @@\n-<script>old</script>\n+<img src=x onerror=alert(1)>\n context');
  assert.match(html, /diff-meta/);
  assert.match(html, /diff-remove.*&lt;script&gt;old&lt;\/script&gt;/);
  assert.match(html, /diff-add.*&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /diff-context.*context/);
  assert.doesNotMatch(html, /<script>|<img/);
});
