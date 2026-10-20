import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createPortProbe } from 'node:net';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {checkUI} from './check-ui.ts';
import {localUIArguments,localUIResolution,readLocalUI} from './local-ui.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const frontend = join(root, 'frontend');
const server = process.argv.includes('--server');
const parsed = localUIArguments(process.argv.slice(2).filter(arg => arg !== '--server'));
const args = parsed.args;
if (args.some((arg) => /^--dev-(?:url|ui-root)(?:=|$)/.test(arg))) {
  throw new Error('Use --ui-source for local UI; the runner chooses its frontend origin and source root.');
}
const env = { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' };
const uiSource = await readLocalUI(parsed.uiSource);
// Go embeds the production UI even when development serves Vite. A fresh clone
// therefore needs the assets once; this does not watch or rebuild on edits.
let needsAssets = false;
try {await access(join(frontend,'dist/index.html'));} catch {needsAssets = true;}
if (needsAssets) await new Promise<void>((resolve, reject) => {
  const build = spawn('npm', ['run', 'build:ui'], { cwd: root, env, stdio: 'inherit' });
  build.on('error', reject);
  build.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Initial frontend build failed')));
});
await checkUI(uiSource);
const requireFrontend = createRequire(join(frontend, 'package.json'));
const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
// Vite treats port 0 as its default port. Pick an ephemeral loopback port, then
// use strictPort so a concurrent run cannot silently attach to another server.
const port = await new Promise<number>((resolve, reject) => {
  const probe = createPortProbe();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') { probe.close(); reject(new Error('No development port')); return; }
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const vite = await createServer({
  root: frontend,
  configFile: false,
  resolve: localUIResolution(uiSource),
  optimizeDeps: uiSource ? {exclude: ['pith-ui','pith-ui/recipes']} : undefined,
  server: { host: '127.0.0.1', port, strictPort: true, hmr: { path: '/__desk_hmr' },
    fs: {allow: [frontend,...(uiSource ? [uiSource.root] : [])]} },
});
await vite.listen();
const address = vite.httpServer.address();
if (!address || typeof address === 'string') throw new Error('No frontend listener');
if (uiSource) console.log(`Local Pith UI: ${uiSource.root} (development only; npm install and lockfile unchanged)`);
const child = spawn('go', ['run', server ? './cmd/pith-desk-server' : './cmd/pith-desk', ...(server ? ['--listen', '127.0.0.1:0'] : []), '--dev-url', `http://127.0.0.1:${address.port}`, ...(uiSource ? ['--dev-ui-root',uiSource.root] : []), ...args], {
  cwd: root, env, stdio: 'inherit', detached: true,
});
let stopping = false;
function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  // Include the executable created by go run, so its data lock is released.
  if (child.pid) {
    try { process.kill(-child.pid, signal); } catch { /* Child already exited. */ }
  }
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', async (error) => { console.error(error); await vite.close(); process.exitCode = 1; });
child.on('exit', async (code, signal) => {
  await vite.close();
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
});
