import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRelativePath } from '../src/lib/format.ts';

test('workspace paths display relative to the workspace with browser separators', () => {
  assert.equal(workspaceRelativePath('/tmp/pith-review', '/tmp/pith-review/src/App.tsx'), 'src/App.tsx');
  assert.equal(workspaceRelativePath('/tmp/pith-review/', '/tmp/pith-review/src/App.tsx'), 'src/App.tsx');
  assert.equal(workspaceRelativePath('C:\\work\\desk', 'C:\\work\\desk\\src\\App.tsx'), 'src/App.tsx');
  assert.equal(workspaceRelativePath('/tmp/pith-review', '/tmp/other/App.tsx'), '/tmp/other/App.tsx');
  assert.equal(workspaceRelativePath('', '/tmp/other/App.tsx'), '/tmp/other/App.tsx');
});
