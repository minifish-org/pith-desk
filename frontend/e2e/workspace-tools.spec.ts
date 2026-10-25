import {expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

test.setTimeout(60000);
const tools=(page:any)=>page.getByRole('complementary',{name:'Workspace tools',exact:true});
const panel=(page:any)=>tools(page).getByRole('tabpanel');
const input=(page:any)=>panel(page).getByRole('textbox',{name:'Terminal input',exact:true});
const file=(path:string)=>readFile(path,'utf8').catch(()=> '');
const running=(pid:string)=>{try {process.kill(Number(pid.trim()),0);return true;} catch {return false;}};
async function create(page:any,kind:'files'|'terminal') {
  await tools(page).getByRole('button',{name:'New tool tab',exact:true}).click();
  await page.getByRole('menuitem',{name:kind==='files'?'New files':'New terminal',exact:true}).click();
  if(kind==='terminal') await expect(panel(page).getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-disabled','false');
}
async function command(page:any,text:string) {
  const target=input(page);
  await target.focus();
  await target.evaluate((node: HTMLTextAreaElement,value: string) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    node.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, text);
  await target.press('Enter');
}
async function open(page:any,host:any) {await page.goto(host.url);await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();}
async function expectEmpty(page:any) {
  await expect(tools(page).getByRole('tab')).toHaveCount(0);
  for(const entry of ['Open files','Open terminal','Open Web']) await expect(tools(page).getByRole('button',{name:entry,exact:true})).toBeVisible();
}

for(const mode of ['desktop','server']) test.describe(mode+' workspace tool tabs',()=>{
  test.use({hostMode:mode});
  test('independent shells survive switching and refresh; closing one tab cleans only its processes',async({page,host})=>{
    const [first,second]=host.state.workspaces;let starts=0;
    // Plain-HTTP LAN origins have getRandomValues but no secure-context UUID API.
    await page.addInitScript(()=>{Object.defineProperty(crypto,'randomUUID',{configurable:true,value:undefined});});
    page.on('request',request=>{if(request.method()==='POST' && new URL(request.url()).pathname==='/api/terminal') starts++;});
    await open(page,host);await expectEmpty(page);
    await page.reload();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await expectEmpty(page);
    await tools(page).getByRole('button',{name:'Close tools',exact:true}).click();
    const toggleTools=page.getByRole('button',{name:'Toggle tools',exact:true});
    await expect(toggleTools).toBeFocused();
    const composer=page.getByRole('textbox',{name:'Message Pith',exact:true});
    await composer.fill('Multiple tabs keep this draft 中文');
    await expect(composer).toHaveValue('Multiple tabs keep this draft 中文');
    await toggleTools.click();
    await create(page,'terminal');await command(page,"stty -echo; mkdir first-dir; cd first-dir; export TAB_STATE=first; echo $$ > ../first.pid; sleep 60 & echo $! > ../child.pid");
    await expect.poll(()=>file(first.path+'/child.pid')).toMatch(/^\d+\n$/);
    await input(page).pressSequentially('echo pending-first > pending.txt');
    await create(page,'terminal');await command(page,"stty -echo; echo $$ > second.pid; printf '%s' ${TAB_STATE-unset} > second.env; pwd > second.cwd");
    await expect.poll(()=>file(first.path+'/second.env')).toBe('unset');await expect.poll(()=>file(first.path+'/second.cwd')).toBe(first.path+'\n');
    expect(await file(first.path+'/first.pid')).not.toBe(await file(first.path+'/second.pid'));expect(starts).toBe(2);
    await tools(page).getByRole('tab',{name:'Terminal',exact:true}).click();await input(page).press('Enter');await expect.poll(()=>file(first.path+'/first-dir/pending.txt')).toBe('pending-first\n');
    await tools(page).getByRole('tab',{name:'Terminal 2',exact:true}).click();await page.reload();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();
    await expect(tools(page).getByRole('tab',{name:'Terminal 2',exact:true})).toHaveAttribute('aria-selected','true');await expect(panel(page).getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-disabled','false');
    await command(page,'echo $$ > restored.pid');await expect.poll(()=>file(first.path+'/restored.pid')).toBe(await file(first.path+'/second.pid'));expect(starts).toBe(2);
    await page.getByRole('button',{name:second.name,exact:true}).click();await page.getByRole('button',{name:second.name+' conversation',exact:true}).click();await expectEmpty(page);
    await create(page,'terminal');await command(page,'echo other-workspace > isolated.txt');await expect.poll(()=>file(second.path+'/isolated.txt')).toBe('other-workspace\n');expect(await file(first.path+'/isolated.txt')).toBe('');
    await page.getByRole('button',{name:first.name+' conversation',exact:true}).click();await expect(tools(page).getByRole('tab',{name:'Terminal 2',exact:true})).toHaveAttribute('aria-selected','true');
    const firstPID=await file(first.path+'/first.pid'),childPID=await file(first.path+'/child.pid');await tools(page).getByRole('button',{name:'Close Terminal',exact:true}).click();await expect(tools(page).getByRole('tab',{name:'Terminal',exact:true})).toHaveCount(0);
    await expect.poll(()=>running(firstPID)).toBe(false);await expect.poll(()=>running(childPID)).toBe(false);await command(page,'echo survivor > surviving.txt');await expect.poll(()=>file(first.path+'/surviving.txt')).toBe('survivor\n');
    await tools(page).getByRole('button',{name:'Close tools',exact:true}).click();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toHaveValue('Multiple tabs keep this draft 中文');
  });

  test('Files tabs restore independent views; an empty layout offers Files, Terminal and Web',async({page,host})=>{
    const root=host.state.workspaces[0].path;await mkdir(root+'/docs');await mkdir(root+'/other');await writeFile(root+'/other/other.txt','Other view');await Promise.all(Array.from({length:70},(_,index)=>writeFile(root+`/docs/file-${String(index).padStart(2,'0')}.txt`,'Fixture')));
    await open(page,host);await tools(page).getByRole('button',{name:'Open files',exact:true}).click();const tree=()=>panel(page).getByRole('navigation',{name:'Workspace files',exact:true});
    await tools(page).getByRole('button',{name:'docs',exact:true}).click();await expect(tools(page).getByRole('button',{name:'file-69.txt',exact:true})).toBeAttached();
    await tree().evaluate((node:HTMLElement)=>{node.scrollTop=420;});await expect.poll(()=>tree().evaluate((node:HTMLElement)=>node.scrollTop)).toBeGreaterThan(300);
    await create(page,'files');await expect(tools(page).getByRole('button',{name:'docs',exact:true})).toHaveAttribute('aria-expanded','false');
    await expect(panel(page).getByRole('searchbox')).toHaveCount(0);await tools(page).getByRole('button',{name:'other',exact:true}).click();await expect(tools(page).getByRole('button',{name:'other.txt',exact:true})).toBeVisible();
    await tools(page).getByRole('tab',{name:'Files',exact:true}).click();await expect(tools(page).getByRole('button',{name:'docs',exact:true})).toHaveAttribute('aria-expanded','true');await expect(tools(page).getByRole('button',{name:'other',exact:true})).toHaveAttribute('aria-expanded','false');await expect.poll(()=>tree().evaluate((node:HTMLElement)=>node.scrollTop)).toBeGreaterThan(300);
    await tools(page).getByRole('tab',{name:'Files 2',exact:true}).click();await page.reload();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();
    await expect(tools(page).getByRole('tab',{name:'Files 2',exact:true})).toHaveAttribute('aria-selected','true');await expect(tools(page).getByRole('button',{name:'docs',exact:true})).toHaveAttribute('aria-expanded','false');await expect(tools(page).getByRole('button',{name:'other.txt',exact:true})).toBeVisible();
    await tools(page).getByRole('tab',{name:'Files',exact:true}).click();await expect(tools(page).getByRole('button',{name:'file-69.txt',exact:true})).toBeAttached();await expect.poll(()=>tree().evaluate((node:HTMLElement)=>node.scrollTop)).toBeGreaterThan(300);
    await tools(page).getByRole('button',{name:'Close Files 2',exact:true}).click();await tools(page).getByRole('button',{name:'Close Files',exact:true}).click();await expect(tools(page).getByRole('tab')).toHaveCount(0);
    await page.reload();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await expect(tools(page).getByRole('tab')).toHaveCount(0);
    for(const [entry,label] of [['Open files','Files 3'],['Open terminal','Terminal'],['Open Web','Web']]) {
      for(const entry of ['Open files','Open terminal','Open Web']) await expect(tools(page).getByRole('button',{name:entry,exact:true})).toBeVisible();
      await tools(page).getByRole('button',{name:entry,exact:true}).click();
      await expect(tools(page).getByRole('tab',{name:label,exact:true})).toHaveAttribute('aria-selected','true');
      if(entry==='Open files') await expect(tree()).toBeVisible();
      if(label==='Terminal') await expect(panel(page).getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-disabled','false');
      if(label==='Web') await expect(panel(page).getByRole('textbox',{name:'Web address',exact:true})).toBeVisible();
      await tools(page).getByRole('button',{name:`Close ${label}`,exact:true}).click();
      await expect(tools(page).getByRole('tab')).toHaveCount(0);
    }
    await create(page,'files');await expect(panel(page).getByRole('searchbox')).toHaveCount(0);await expect(tools(page).getByRole('button',{name:'docs',exact:true})).toHaveAttribute('aria-expanded','false');await expect(tools(page).getByRole('button',{name:'other',exact:true})).toHaveAttribute('aria-expanded','false');
  });

  test('a delayed terminal close preserves tabs created while it is pending', async ({page, host}) => {
    await open(page, host);
    await create(page, 'terminal');
    let release!: () => void;
    let received!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const closing = new Promise<void>(resolve => {received = resolve;});
    await page.route('**/api/terminal/close', async route => {
      received();
      await pending;
      await route.continue();
    });
    try {
      await tools(page).getByRole('button', {name: 'Close Terminal', exact: true}).click();
      await closing;
      await create(page, 'files');
    } finally {release();}
    await expect(tools(page).getByRole('tab', {name: 'Terminal', exact: true})).toHaveCount(0);
    await expect(tools(page).getByRole('tab', {name: 'Files', exact: true})).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.getByRole('textbox', {name: 'Message Pith', exact: true})).toBeEditable();
    await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
    await expect(tools(page).getByRole('tab', {name: 'Files', exact: true})).toHaveAttribute('aria-selected', 'true');
  });

  test('a delayed terminal close stays with its original workspace', async ({page, host}) => {
    const [first, second] = host.state.workspaces;
    await open(page, host);
    await create(page, 'terminal');
    let release!: () => void;
    let received!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const closing = new Promise<void>(resolve => {received = resolve;});
    await page.route('**/api/terminal/close', async route => {
      received();
      await pending;
      await route.continue();
    });
    try {
      await tools(page).getByRole('button', {name: 'Close Terminal', exact: true}).click();
      await closing;
      await page.getByRole('button', {name: second.name, exact: true}).click();
      await page.getByRole('button', {name: second.name + ' conversation', exact: true}).click();
      await create(page, 'files');
    } finally {release();}
    await expect(tools(page).getByRole('tab', {name: 'Files', exact: true})).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', {name: first.name + ' conversation', exact: true}).click();
    await expect(tools(page).getByRole('tab', {name: 'Terminal', exact: true})).toHaveCount(0);
    await page.getByRole('button', {name: second.name + ' conversation', exact: true}).click();
    await expect(tools(page).getByRole('tab', {name: 'Files', exact: true})).toHaveAttribute('aria-selected', 'true');
  });

  test('closing a Terminal tab sends one close request and restores the empty tools layout', async ({page, host}) => {
    await open(page, host);
    await create(page, 'terminal');
    const closes: object[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminal/close') closes.push(request.postDataJSON());
    });
    await expect(panel(page).getByRole('button')).toHaveCount(0);
    await tools(page).getByRole('button', {name: 'Close Terminal', exact: true}).click();
    await expectEmpty(page);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({workspaceId: host.state.workspaces[0].id});
  });
});
