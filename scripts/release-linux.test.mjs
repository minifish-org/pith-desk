import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

test('Ubuntu release paths preserve the literal Debian prerelease separator in Bash', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const expressions = [...new Set(workflow.match(/\$\{version\/-\/[^}]+\}/g))];
  assert.ok(expressions.length,'expected the release workflow to derive Debian versions');
  for (const expression of expressions) {
    const actual = execFileSync('bash',['-c',`version=0.1.0-rc.31; printf '%s\\n' "${expression}"`],{encoding: 'utf8'}).trim();
    assert.equal(actual,'0.1.0~rc.31');
  }
});
