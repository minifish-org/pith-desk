import { test as base } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const test = base.extend({
  hostBinary: [async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'pith-host-binary-'));
    try {
      const binary = join(root, 'host-fixture');
      execFileSync('go', ['build', '-o', binary, './internal/testsupport/hostfixture'], { env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' }, timeout: 60000 });
      await use(binary);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, { scope: 'worker' }],
  host: async ({ hostBinary }, use) => {
    const root = await mkdtemp(join(tmpdir(), 'pith-host-test-'));
    const child = spawn(hostBinary, ['--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', exit;
    const waiting = [], queued = [];
    child.stderr.on('data', (value) => { stderr += value; });
    const exited = new Promise((resolve) => child.once('exit', (code) => { exit = code; resolve(); }));
    child.once('error', (error) => { for (const waiter of waiting.splice(0)) waiter.reject(error); });
    child.once('exit', (code) => { for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Host fixture exited ${code}: ${stderr}`)); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const reply = JSON.parse(line);
      const waiter = waiting.shift();
      if (waiter) reply.error ? waiter.reject(new Error(reply.error)) : waiter.resolve(reply);
      else queued.push(reply);
    });
    const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    try {
      const initial = await next();
      await use({ ...initial, command: (action, values = {}) => {
        const reply = next();
        child.stdin.write(JSON.stringify({ action, ...values }) + '\n');
        return reply;
      } });
    } finally {
      if (exit === undefined) {
        child.stdin.end('{"action":"quit"}\n');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        await exited;
        clearTimeout(timer);
      }
      lines.close();
      await rm(root, { recursive: true, force: true });
    }
  },
});
