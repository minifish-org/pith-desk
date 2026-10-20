import { test as base } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const test = base.extend({
  serverAutoLogin: [true, {option: true}],
  hostBinary: [async ({}, use) => {
    // CI builds the checkout's fixture once; every test still gets a fresh
    // process and data directory. Local runs retain the worker build fallback.
    if (process.env.PITH_DESK_HOST_FIXTURE) {
      await use(process.env.PITH_DESK_HOST_FIXTURE);
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'pith-host-binary-'));
    try {
      const binary = join(root, 'host-fixture');
      execFileSync('go', ['build', '-o', binary, './internal/testsupport/hostfixture'], { env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' }, timeout: 60000 });
      await use(binary);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, { scope: 'worker' }],
  host: async ({ hostBinary, context, serverAutoLogin }, use) => {
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
      const signIn = async (host) => {
        const response = await context.request.post(host.url + '/api/server/login', {data: {token: host.token}, headers: {Origin: host.url}});
        if (!response.ok()) throw new Error(`Fixture sign-in failed: ${response.status()}`);
      };
      if (serverAutoLogin) await signIn(initial);
      await use({ ...initial, command: async (action, values = {}) => {
        const reply = next();
        child.stdin.write(JSON.stringify({ action, ...values }) + '\n');
        const result = await reply;
        if (serverAutoLogin && action === 'restart') await signIn(result);
        return result;
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
