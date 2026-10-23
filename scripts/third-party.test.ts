import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';

// Packaging copies third_party/ wholesale. A notice left behind after removing
// a dependency would otherwise ship in every archive without its summary.
test('every retained third-party notice is documented', () => {
  const summary = readFileSync('docs/THIRD_PARTY.md', 'utf8');
  const missing = readdirSync('third_party')
    .filter(name => !name.endsWith('.md'))
    .filter(name => !summary.includes(name));
  assert.deepEqual(missing, []);
});
