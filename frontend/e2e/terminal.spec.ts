import {expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

test.setTimeout(60000);
const tools = (page: any) => page.getByRole('complementary',{name: 'Workspace tools',exact: true});
const panel = (page: any) => tools(page).getByRole('tabpanel');
const keyboard = (page: any) => panel(page).getByRole('textbox',{name: 'Terminal input',exact: true});
const connected = (page: any) => expect(panel(page).getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-disabled','false');
async function newTerminal(page: any) {await tools(page).getByRole('button',{name:'New tool tab',exact:true}).click();await page.getByRole('menuitem',{name:'New terminal',exact:true}).click();await connected(page);}
async function newFiles(page: any) {await tools(page).getByRole('button',{name:'New tool tab',exact:true}).click();await page.getByRole('menuitem',{name:'New files',exact:true}).click();}
async function showTerminal(page: any) {
  const toggle = page.getByRole('button',{name: 'Toggle tools',exact: true,includeHidden:true});
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await tools(page).getByRole('tab',{name: 'Terminal',exact: true}).click();
  await connected(page);
}
async function startTerminal(page: any,host: any) {
  await page.goto(host.url);await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();
  await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await newTerminal(page);await expect(keyboard(page)).toBeAttached();
}
async function typeText(page: any,text: string) {
  const input=keyboard(page);
  await input.focus();
  // Paste is atomic and keeps Unicode; editors receive it as text input.
  await input.evaluate((node: HTMLTextAreaElement,value: string) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, text);
}
async function typeKeys(page: any,text: string) {
  await keyboard(page).focus();
  await keyboard(page).pressSequentially(text);
}
async function command(page: any,text: string) {await typeText(page,text);await keyboard(page).press('Enter');}
async function file(path: string) {return readFile(path,'utf8').catch(() => '');}

for (const mode of ['desktop','server']) test.describe(mode+' manual terminal',() => {
  test.use({hostMode: mode});
  test('shell state, tools and drafts remain independent from Agent commands and approval',async ({page,host}) => {
    const root = host.state.workspaces[0].path;
    await startTerminal(page,host);await expect(panel(page).getByRole('button')).toHaveCount(0);await expect(panel(page)).not.toContainText('Connected · manual shell');
    const tab=tools(page).getByRole('tab',{name:'Terminal',exact:true});await expect(tab).toHaveAttribute('title',new RegExp('^'+(mode==='server'?'Server':'Local')));await expect(tab).toHaveAttribute('title',new RegExp(root));
    await command(page,"mkdir manual-dir; cd manual-dir; export MANUAL_ONLY=manual; echo 'terminal 中文' > shared.txt");
    await expect.poll(() => file(root+'/manual-dir/shared.txt')).toBe('terminal 中文\n');
    await newFiles(page);await tools(page).getByRole('button',{name: 'Refresh workspace files',exact: true}).click();
    await tools(page).getByRole('button',{name: 'manual-dir',exact: true}).click();await expect(tools(page).getByRole('button',{name: 'shared.txt',exact: true})).toBeVisible();
    await tools(page).getByRole('button',{name: 'Close tools',exact: true}).click();
    const draft = page.getByRole('textbox',{name: 'Message Pith',exact: true});await draft.fill('Agent verifies its own execution state');
    await host.command('command-tool',{enabled: true});await page.getByRole('button',{name: 'Send message',exact: true}).click();
    await expect(page.getByRole('button',{name: 'Allow this action',exact: true})).toBeVisible();await expect.poll(() => file(root+'/agent-cwd.txt')).toBe('');
    await page.getByRole('button',{name: 'Allow this action',exact: true}).click();
    await expect.poll(() => file(root+'/agent-cwd.txt')).toBe(root+'\n');await expect.poll(() => file(root+'/agent-env.txt')).toBe('unset');
    await expect(page.getByText('Fixture answer',{exact: true})).toBeVisible();
    const stats = await host.command('stats');expect(JSON.stringify(stats.lastRequest)).not.toContain('terminal 中文');
    await draft.fill('Unsubmitted draft 中文');await showTerminal(page);
    await command(page,"pwd > terminal-cwd; printf '%s' $MANUAL_ONLY > terminal-env");
    await expect.poll(() => file(root+'/manual-dir/terminal-cwd')).toBe(root+'/manual-dir\n');await expect.poll(() => file(root+'/manual-dir/terminal-env')).toBe('manual');
    await tools(page).getByRole('button',{name: 'Close tools',exact: true}).click();await expect(draft).toHaveValue('Unsubmitted draft 中文');
  });

  test('hide, reload, page close and disconnect keep one shell and bounded replay without input replay',async ({page,host,context}) => {
    const root = host.state.workspaces[0].path;let starts = 0;const connections: any[] = [];
    page.on('request',request => {if (request.method()==='POST' && new URL(request.url()).pathname==='/api/terminal') starts++;});
    await page.routeWebSocket('**/api/terminal/socket?**',route => {const server = route.connectToServer();connections.push({route,server});});
    await startTerminal(page,host);await command(page,"echo $$ > shell.pid; stty -echo; printf '\\344'; sleep .1; printf '\\270\\255\\346\\226\\207'; printf '\\nSPLIT_DONE\\n'");
    await expect(tools(page)).toContainText('中文');const pid = await file(root+'/shell.pid');expect(pid.trim()).toMatch(/^\d+$/);
    await command(page,"printf x >> once.txt; (sleep .25; printf 'while-away\\n'; echo finished > detached.txt) &");
    connections.at(-1).server.close();await expect.poll(() => connections.length).toBeGreaterThan(1);await connected(page);
    await expect.poll(() => file(root+'/once.txt')).toBe('x');
    await page.reload();await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();await showTerminal(page);await expect(tools(page)).toContainText('while-away');
    expect(starts).toBe(1);await command(page,'echo $$ > reconnected.pid');await expect.poll(() => file(root+'/reconnected.pid')).toBe(pid);
    await command(page,"sleep 60");await keyboard(page).press('Control+c');await command(page,'echo interrupted > interrupted.txt');await expect.poll(() => file(root+'/interrupted.txt')).toBe('interrupted\n');
    await command(page,"head -c 2097152 /dev/zero | tr '\\000' x; printf '\\nTAIL_MARKER\\n'");
    await expect(tools(page)).toContainText('TAIL_MARKER');await page.reload();await showTerminal(page);await expect(panel(page).getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-description',/Earlier terminal output was truncated/);await expect(tools(page)).toContainText('TAIL_MARKER');
    await command(page,"(sleep .2; echo page-closed > page-closed.txt) &");await page.close();await expect.poll(() => file(root+'/page-closed.txt')).toBe('page-closed\n');
    const next = await context.newPage();await next.goto(host.url);
    if (mode==='server') {await expect(next.getByRole('button',{name: 'Continue here',exact: true})).toBeVisible();await next.getByRole('button',{name: 'Continue here',exact: true}).click();}
    await expect(next.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();await showTerminal(next);await connected(next);
    await tools(next).getByRole('button',{name: 'Close Terminal',exact: true}).click();await expect(tools(next).getByRole('tab',{name:'Terminal',exact:true})).toHaveCount(0);
  });

  test('a shell that ended while its page was closed closes the restored tab', async ({page,host,context}) => {
    const workspace = host.state.workspaces[0],root = workspace.path;
    await startTerminal(page,host);await command(page,'echo $$ > ended.pid');
    await expect.poll(() => file(root+'/ended.pid')).toMatch(/^\d+\n$/);
    await page.close();process.kill(Number((await file(root+'/ended.pid')).trim()),'SIGKILL');
    const next = await context.newPage();await next.goto(host.url);
    if (mode==='server') {await expect(next.getByRole('button',{name: 'Continue here',exact: true})).toBeVisible();await next.getByRole('button',{name: 'Continue here',exact: true}).click();}
    await expect(next.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();await next.getByRole('button',{name:'Toggle tools',exact:true}).click();
    await expect.poll(() => next.evaluate(key => JSON.parse(localStorage.getItem('pith-desk.tools.v1.'+key)||'{}').tabs?.length ?? -1,workspace.id)).toBe(0);
    await expect(tools(next).getByRole('tab')).toHaveCount(0);
  });

  test('a session lost while the link is down restarts in its tab', async ({page,host}) => {
    const workspace = host.state.workspaces[0],root = workspace.path;
    let fail = false,authorization = '',operation = 0;const routes: any[] = [];
    page.on('request',request => {
      const headers = request.headers(),auth = headers.authorization;
      if (auth) authorization = auth;
      operation = Math.max(operation,Number(headers['x-desk-request'] || 0));
    });
    await page.routeWebSocket('**/api/terminal/socket?**',route => {if(fail) {void route.close(); return;} routes.push({route,server: route.connectToServer()});});
    await startTerminal(page,host);await command(page,'echo $$ > old.pid');
    await expect.poll(() => file(root+'/old.pid')).toMatch(/^\d+\n$/);
    const old = (await file(root+'/old.pid')).trim();
    fail = true;await routes.at(-1).server.close();
    const terminal = panel(page).getByLabel('Interactive terminal',{exact:true});
    await expect(terminal).toHaveAttribute('aria-description',/Disconnected/,{timeout:10000});
    const id = await page.evaluate(key => JSON.parse(localStorage.getItem(key)||'{}').tabs?.[0]?.id,'pith-desk.tools.v1.'+workspace.id);
    expect(id).toBeTruthy();
    // Drop the session the way a restarted or emptied service would. The page's
    // operation numbers stay valid because the lease allows 64 ahead.
    const close = await page.evaluate(async ({workspaceId,id,authorization,operation}) => {
      const headers: Record<string,string> = {'Content-Type':'application/json','X-Desk-Request':String(operation+32)};
      const lease = sessionStorage.getItem('pith-desk-server-lease');
      if (authorization) headers.Authorization = authorization;
      if (lease) headers['X-Desk-Lease'] = lease;
      const response = await fetch('/api/terminal/close',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({workspaceId,id})});
      return {status: response.status,error: response.ok ? '' : await response.text()};
    },{workspaceId: workspace.id,id,authorization,operation});
    expect(close).toEqual({status: 200,error: ''});
    fail = false;
    await expect(terminal).toHaveAttribute('aria-disabled','false',{timeout:30000});
    await expect(tools(page).getByRole('tab',{name:'Terminal',exact:true})).toHaveCount(1);
    await command(page,'echo $$ > new.pid');
    await expect.poll(() => file(root+'/new.pid')).toMatch(/^\d+\n$/);
    expect((await file(root+'/new.pid')).trim()).not.toBe(old);
  });

  // The complaint behind the reconnect rework: a notice that churns and a screen
  // that replays while the service is unreachable. Say it once, try quietly.
  test('an unreachable service retries quietly and keeps the same shell', async ({page,host}) => {
    const root = host.state.workspaces[0].path;
    let fail = false,attempts = 0;const routes: any[] = [];
    await page.routeWebSocket('**/api/terminal/socket?**',route => {
      if (fail) {attempts++; void route.close(); return;}
      routes.push({route,server: route.connectToServer()});
    });
    await startTerminal(page,host);await command(page,'echo $$ > quiet.pid');
    await expect.poll(() => file(root+'/quiet.pid')).toMatch(/^\d+\n$/);
    await page.evaluate(() => {
      const node = document.querySelector('[aria-label="Interactive terminal"]')!;
      const seen: string[] = [];
      new MutationObserver(() => {
        const value = node.getAttribute('aria-description') || '';
        if (seen.at(-1) !== value) seen.push(value);
      }).observe(node,{attributes:true,attributeFilter:['aria-description']});
      (window as any).descriptions = seen;
    });
    fail = true;await routes.at(-1).server.close();
    await page.waitForTimeout(2500);
    // Only the outage notice: no per-attempt "Connecting…", no replay or reset.
    expect(await page.evaluate(() => (window as any).descriptions)).toEqual(['Disconnected · reconnecting. Input is disabled and will not be replayed.']);
    expect(attempts).toBeLessThanOrEqual(4);
    expect(await page.locator('[role="alert"]').count()).toBe(0);
    fail = false;
    const terminal = panel(page).getByLabel('Interactive terminal',{exact:true});
    await expect(terminal).toHaveAttribute('aria-disabled','false',{timeout:30000});
    await command(page,'echo $$ > quiet-again.pid');
    await expect.poll(() => file(root+'/quiet-again.pid')).toMatch(/^\d+\n$/);
    expect(await file(root+'/quiet-again.pid')).toBe(await file(root+'/quiet.pid'));
  });

  test('workspace switches show separate shells and preserve their pending command lines',async ({page,host}) => {
    const [first,second] = host.state.workspaces;await startTerminal(page,host);
    await command(page,'export WORKSPACE_MARKER=first');await typeText(page,'echo pending-first > pending.txt');
    await page.getByRole('button',{name: second.name,exact: true}).click();await page.getByRole('button',{name: second.name+' conversation',exact: true}).click();
    await expect(tools(page).getByRole('tab')).toHaveCount(0);await newTerminal(page);
    await connected(page);await command(page,"printf '%s' ${WORKSPACE_MARKER-unset} > marker.txt");await expect.poll(() => file(second.path+'/marker.txt')).toBe('unset');
    await page.getByRole('button',{name: first.name+' conversation',exact: true}).click();await expect(panel(page)).toContainText('pending-first');
    await keyboard(page).press('Enter');await expect.poll(() => file(first.path+'/pending.txt')).toBe('pending-first\n');expect(await file(second.path+'/pending.txt')).toBe('');
  });

  test('continuous output stays interruptible without publishing application snapshots',async ({page,host}) => {
    await page.addInitScript(() => {
      const descriptor=Object.getOwnPropertyDescriptor(WebSocket.prototype,'onmessage')!;
      Object.defineProperty(WebSocket.prototype,'onmessage',{
        ...descriptor,
        set(listener) {
          descriptor.set!.call(this,listener && function(this:WebSocket,event:MessageEvent) {
            listener.call(this,event);
            if(!(window as any).interruptOnTerminalOutput || new URL(this.url).pathname!=='/api/terminal/socket' || JSON.parse(event.data).type!=='output') return;
            (window as any).interruptOnTerminalOutput=false;
            // Live flood output uses xterm's deferred write parser. Deliver the
            // real keyboard event after the handler but before that parser runs.
            const input=document.querySelector<HTMLTextAreaElement>('[aria-label="Terminal input"]')!;
            input.dispatchEvent(new KeyboardEvent('keydown',{key:'c',code:'KeyC',keyCode:67,ctrlKey:true,bubbles:true,cancelable:true}));
            input.dispatchEvent(new KeyboardEvent('keyup',{key:'c',code:'KeyC',keyCode:67,ctrlKey:true,bubbles:true,cancelable:true}));
          });
        },
      });
    });
    let snapshots=0,interrupts=0;
    page.on('websocket',socket=>{
      const path=new URL(socket.url()).pathname;
      if(path==='/api/socket') socket.on('framereceived',()=>snapshots++);
      if(path==='/api/terminal/socket') socket.on('framesent',event=>{const data=JSON.parse(String(event.payload));if(data.type==='input' && data.data==='\u0003') interrupts++;});
    });
    await startTerminal(page,host);const before=snapshots;
    await command(page,'yes terminal-flood; echo responsive > flood-stopped');await expect(panel(page).getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-description',/Earlier terminal output was truncated/);
    await page.evaluate(()=>{(window as any).interruptOnTerminalOutput=true;});
    await expect.poll(()=>interrupts).toBe(1);
    await expect.poll(()=>file(host.state.workspaces[0].path+'/flood-stopped'),{timeout:10000}).toBe('responsive\n');expect(snapshots).toBe(before);
  });
});

test('Server takeover retires terminal input while preserving unsent conversation text',async ({page,host,context}) => {
  const root = host.state.workspaces[0].path;await startTerminal(page,host);await command(page,'echo $$ > original.pid');
  await tools(page).getByRole('button',{name: 'Close tools',exact: true}).click();const draft = page.getByRole('textbox',{name: 'Message Pith',exact: true});await draft.fill('Keep my draft');await showTerminal(page);
  const other = await context.newPage();await other.goto(host.url);await other.getByRole('button',{name: 'Continue here',exact: true}).click();await expect(page.getByRole('dialog',{name: 'Reconnect to Pith Desk',exact: true})).toBeVisible();
  await showTerminal(other);await connected(other);await command(other,'echo $$ > taken-over.pid');await expect.poll(() => file(root+'/taken-over.pid')).toBe(await file(root+'/original.pid'));
  await tools(other).getByRole('button',{name: 'Close tools',exact: true}).click();await expect(other.getByRole('textbox',{name: 'Message Pith',exact: true})).toHaveValue('Keep my draft');
});

test('vim and top redraw across reconnect; unsaved editor state stays in the process',async ({page,host}) => {
  const root = host.state.workspaces[0].path;await writeFile(root+'/fullscreen.txt','Full-screen fixture 中文\n'+Array.from({length:40},(_,n)=>'Line '+n).join('\n'));
  await startTerminal(page,host);await command(page,'vim -Nu NONE -n -i NONE fullscreen.txt; echo vim-returned > vim-returned');await expect(tools(page)).toContainText('Full-screen fixture');
  await keyboard(page).press('i');await typeText(page,'UNSAVED 中文 ');await expect(tools(page)).toContainText('UNSAVED 中文');await page.reload();await showTerminal(page);
  // The unsaved editor state lives in the still-running vim process.
  await keyboard(page).press('Escape');await expect(tools(page)).toBeVisible();await typeKeys(page,':wq');await keyboard(page).press('Enter');
  await expect.poll(() => file(root+'/fullscreen.txt')).toContain('UNSAVED 中文');
  // Saving precedes vim's terminal cleanup; only send another command after exit.
  await expect.poll(() => file(root+'/vim-returned')).toBe('vim-returned\n');
  await command(page,'top; echo top-returned > top-returned');
  // top may spend seconds collecting its first sample under load. Wait for its
  // full-screen output so q reaches top's input loop instead of the shell.
  await expect(panel(page)).toContainText(/Processes:|Tasks:/,{timeout:10000});
  await page.reload();await showTerminal(page);await expect(panel(page)).toContainText(/Processes:|Tasks:/);
  await keyboard(page).focus();await keyboard(page).press('q');
  await expect.poll(() => file(root+'/top-returned'),{timeout:10000}).toBe('top-returned\n');
  await command(page,'echo full-screen-returned > after-fullscreen');await expect.poll(() => file(root+'/after-fullscreen')).toBe('full-screen-returned\n');
});

test.describe('phone terminal',() => {
  test.use({viewport: {width:390,height:844},isMobile:true,hasTouch:true});
  test('simulated soft keyboard keeps terminal sizing, scrolling and keyboard input usable',async ({page,host}) => {
    await page.goto(host.url);const draft = page.getByRole('textbox',{name:'Message Pith',exact:true});await expect(draft).toBeEditable();await draft.fill('Phone draft 中文');await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await newTerminal(page);
    await page.evaluate(() => {Object.defineProperty(window.visualViewport!,'height',{configurable:true,value:330});window.visualViewport!.dispatchEvent(new Event('resize'));});
    await keyboard(page).focus();await command(page,'stty size > phone-size');
    await expect.poll(() => file(host.state.workspaces[0].path+'/phone-size')).toMatch(/\d+ \d+/);
    const box = await page.locator('[data-terminal-viewport]').boundingBox();expect(box!.height).toBeGreaterThan(25);expect(box!.y+box!.height).toBeLessThanOrEqual(330);
    await expect(panel(page).getByRole('button')).toHaveCount(0);
    await command(page,'sleep 60');await keyboard(page).press('Control+c');await command(page,'echo phone-ok > phone.txt');await expect.poll(() => file(host.state.workspaces[0].path+'/phone.txt')).toBe('phone-ok\n');
    await keyboard(page).press('Escape');await expect(tools(page)).toBeVisible();await newFiles(page);await expect(tools(page).getByRole('button',{name:'Refresh workspace files',exact:true})).toBeVisible();
    await tools(page).getByRole('button',{name:'Close tools',exact:true}).click();await expect(draft).toHaveValue('Phone draft 中文');await expect(page.getByRole('button',{name:'Toggle tools',exact:true})).toBeFocused();
  });
});
