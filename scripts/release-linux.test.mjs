import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

// Exercise the same config evaluation used by the packager, with a real release identity.
test('Linux portable releases retain the signed updater configuration', () => {
  const config = new URL('../mygo.config.ts', import.meta.url).href;
  const result = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `const {default: config} = await import(${JSON.stringify(config)}); console.log(JSON.stringify(config));`], {
    encoding: 'utf8', env: {...process.env, PITH_DESK_LINUX_RELEASE_VERSION: '0.1.0-rc.36'},
  }));
  assert.equal(result.version, '0.1.0-rc.36');
  assert.ok(result.updates?.publicKey, 'Linux releases must embed the update verification key');
  assert.equal(result.updates.url, 'https://raw.githubusercontent.com/minifish-org/pith-desk/updates/preview');
  assert.equal(result.updates.deltas, 0);
});
