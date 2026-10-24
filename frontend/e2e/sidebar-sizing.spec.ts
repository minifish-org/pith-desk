import {expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

const rail=(page:any,name:string)=>page.getByRole('complementary',{name,exact:true});
const width=(page:any,name:string)=>rail(page,name).evaluate((node:HTMLElement)=>Math.round(node.getBoundingClientRect().width));
async function drag(page:any,name:string,dx:number) {
  const box=(await page.getByRole('separator',{name,exact:true}).boundingBox())!;
  const startX=box.x+5, startY=box.y+100, steps=20;
  await page.mouse.move(startX,startY);await page.mouse.down();
  for (let step=1;step<=steps;step++) {await page.mouse.move(startX+Math.round(dx*step/steps),startY);await page.waitForTimeout(12);}
  await page.mouse.up();
}
const file=(path:string)=>readFile(path,'utf8').catch(()=>'');

for(const mode of ['desktop','server']) test.describe(mode+' sidebar widths',()=>{
  test.use({hostMode:mode,viewport:{width:1600,height:840}});
  test('committed widths survive hide, refresh and service restart; viewport limits retain preferences',async({page,host})=>{
    const root=host.state.workspaces[0].path;await mkdir(root+'/width-state');await writeFile(root+'/width-state/note.txt','Retained file view');
    await page.goto(host.url);const draft=page.getByRole('textbox',{name:'Message Pith',exact:true});await expect(draft).toBeEditable();await draft.fill('Sizing draft 中文');
    await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await rail(page,'Workspace tools').getByRole('button',{name:'Open files',exact:true}).click();const folder=rail(page,'Workspace tools').getByRole('button',{name:'width-state',exact:true});await folder.click();await expect(rail(page,'Workspace tools').getByRole('button',{name:'note.txt',exact:true})).toBeVisible();
    let saves=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/sidebar-widths')saves++;});
    const left=(await page.getByRole('separator',{name:'Resize navigation',exact:true}).boundingBox())!;
    await page.mouse.move(left.x+5,left.y+100);await page.mouse.down();await page.mouse.move(left.x+85,left.y+100,{steps:12});expect(saves).toBe(0);
    const savedLeft=page.waitForResponse(response=>response.url().endsWith('/api/sidebar-widths')&&response.ok());await page.mouse.up();await savedLeft;
    const savedRight=page.waitForResponse(response=>response.url().endsWith('/api/sidebar-widths')&&response.ok());await drag(page,'Resize tools',-120);await savedRight;
    expect(saves).toBe(2);const navWidth=await width(page,'Navigation'),toolsWidth=await width(page,'Workspace tools');expect(navWidth).toBeGreaterThan(270);expect(toolsWidth).toBeGreaterThan(310);await expect(folder).toHaveAttribute('aria-expanded','true');await expect(draft).toHaveValue('Sizing draft 中文');
    await page.getByRole('button',{name:'Close tools',exact:true}).click();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await expect.poll(async()=>Math.abs(await width(page,'Workspace tools')-toolsWidth)).toBeLessThanOrEqual(2);
    await page.setViewportSize({width:780,height:840});await expect.poll(async()=>(await page.locator('main').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(319);
    await page.setViewportSize({width:1600,height:840});await expect.poll(async()=>Math.abs(await width(page,'Workspace tools')-toolsWidth)).toBeLessThanOrEqual(2);expect(saves).toBe(2);
    await page.reload();await expect(draft).toHaveValue('Sizing draft 中文');await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await expect(folder).toHaveAttribute('aria-expanded','true');await expect(rail(page,'Workspace tools').getByRole('button',{name:'note.txt',exact:true})).toBeVisible();await expect.poll(async()=>Math.abs(await width(page,'Navigation')-navWidth)).toBeLessThanOrEqual(2);await expect.poll(async()=>Math.abs(await width(page,'Workspace tools')-toolsWidth)).toBeLessThanOrEqual(2);
    const restarted=await host.command('restart');await page.goto(restarted.url);await expect(draft).toHaveValue('Sizing draft 中文');await page.getByRole('button',{name:'Toggle tools',exact:true}).click();await expect.poll(async()=>Math.abs(await width(page,'Navigation')-navWidth)).toBeLessThanOrEqual(2);await expect.poll(async()=>Math.abs(await width(page,'Workspace tools')-toolsWidth)).toBeLessThanOrEqual(2);
  });

  test('dragging a terminal rail resizes the real PTY while retaining its pending command and shell',async({page,host})=>{
    const root=host.state.workspaces[0].path;await page.goto(host.url);await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();await page.getByRole('button',{name:'Toggle tools',exact:true}).click();
    const tools=rail(page,'Workspace tools');await tools.getByRole('button',{name:'Open files',exact:true}).click();await tools.getByRole('button',{name:'New tool tab',exact:true}).click();await page.getByRole('menuitem',{name:'New terminal',exact:true}).click();await expect(tools.getByLabel('Interactive terminal',{exact:true})).toHaveAttribute('aria-disabled','false');
    const input=tools.getByRole('textbox',{name:'Terminal input',exact:true});
    async function typeText(text:string) {await input.focus();await input.evaluate((node: HTMLTextAreaElement,value: string) => {const data = new DataTransfer();data.setData('text/plain', value);node.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));},text);}
    async function command(text:string) {await typeText(text);await input.press('Enter');}
    await command('echo $$ > size-shell; stty size > before-size');await expect.poll(()=>file(root+'/before-size')).toMatch(/\d+ \d+/);const before=(await file(root+'/before-size')).trim().split(/\s+/).map(Number),pid=await file(root+'/size-shell');
    await typeText('echo pending-中文 > pending-size');await drag(page,'Resize tools',-220);await expect.poll(()=>width(page,'Workspace tools')).toBe(520);
    await input.focus();await input.press('Enter');await expect.poll(()=>file(root+'/pending-size')).toBe('pending-中文\n');
    await command('stty size > after-size; echo $$ > size-shell-after');await expect.poll(()=>file(root+'/after-size')).toMatch(/\d+ \d+/);const after=(await file(root+'/after-size')).trim().split(/\s+/).map(Number);
    expect(after[1]).toBeGreaterThan(before[1]);expect(after[0]).toBe(before[0]);expect(await file(root+'/size-shell-after')).toBe(pid);
    await tools.getByRole('tab',{name:'Files',exact:true}).click();await tools.getByRole('button',{name:'Refresh workspace files',exact:true}).click();await expect(tools.getByRole('button',{name:'pending-size',exact:true})).toBeVisible();
    await drag(page,'Resize tools',80);await expect.poll(()=>width(page,'Workspace tools')).toBe(440);await expect(tools.getByRole('button',{name:'pending-size',exact:true})).toBeVisible();
    await tools.getByRole('tab',{name:'Terminal',exact:true}).click();await command('cat pending-size > pending-visible; stty size > smaller-size');await expect.poll(()=>file(root+'/pending-visible')).toBe('pending-中文\n');await expect.poll(async()=>Number((await file(root+'/smaller-size')).trim().split(/\s+/)[1])).toBeLessThan(after[1]);
  });
});
