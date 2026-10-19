import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('the bundled Pith UI notice identifies the pinned UI package version',()=>{
  const frontend=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const version=frontend.dependencies['pith-ui'];
  const notices=readFileSync(new URL('../../docs/THIRD_PARTY.md',import.meta.url),'utf8');
  const entry=notices.split('\n').find(line=>line.startsWith('| [Pith UI]('));
  assert.ok(entry,'The release must contain a Pith UI dependency notice.');
  const columns=entry.split('|').map(column=>column.trim());
  assert.equal(columns[1],`[Pith UI](https://github.com/minifish-org/pith-ui/tree/v${version})`);
  assert.equal(columns[2],'`'+version+'`');
});
