import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

test('Ubuntu release paths preserve the literal Debian prerelease separator in Bash', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const assignments = workflow.match(/^\s*debian_version=.*$/gm) ?? [];
  assert.equal(assignments.length,2,'both package verification and publication must derive Debian versions');
  for (const assignment of assignments) {
    for (const shell of ['bash','/bin/bash']) {
      for (const [version, expected] of [['0.1.0','0.1.0'],['0.1.0-rc.31','0.1.0~rc.31']]) {
        const actual = execFileSync(shell,['-c',`${assignment.trim()}\nprintf '%s\\n' "$debian_version"`],{encoding: 'utf8',env: {...process.env,version}}).trim();
        assert.equal(actual,expected);
      }
    }
  }
});
