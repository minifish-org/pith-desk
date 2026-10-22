import {expect} from '@playwright/test';
import {createServer as createVite} from 'vite';
import {writeFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

test.setTimeout(60000);
const tools=(page:any)=>page.getByRole('complementary',{name:'Workspace tools',exact:true});
async function open(page:any,host:any) {
  await page.goto(host.url);await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();
  await page.getByRole('textbox',{name:'Message Pith',exact:true}).fill('Keep my draft 中文');
  await page.getByRole('button',{name:'Toggle tools',exact:true}).click();
  await tools(page).getByRole('button',{name:'New tool tab',exact:true}).click();await page.getByRole('menuitem',{name:'New Web',exact:true}).click();
}
async function navigate(page:any,address:string) {
  const input=tools(page).getByRole('textbox',{name:'Web address',exact:true});await input.fill(address);await input.press('Enter');
}
const script=(label:string)=>`export const label=${JSON.stringify(label)};document.querySelector('h1').textContent=label;document.querySelector('button').onclick=()=>document.querySelector('output').textContent='operated';try{parent.document.body;document.body.dataset.isolated='no'}catch{document.body.dataset.isolated='yes'}if(import.meta.hot)import.meta.hot.accept(m=>document.querySelector('h1').textContent=m.label);`;

for(const mode of ['desktop','server'])test.describe(mode+' web preview',()=>{
  test.use({hostMode:mode});
  test('real server localhost project supports root assets, interaction and Vite HMR; permissions and drafts stay isolated',async({page,host,context})=>{
    const root=host.state.workspaces[0].path;
    await writeFile(root+'/index.html','<!doctype html><h1>Loading</h1><button>Project action</button><output></output><script type="module" src="/main.ts"></script>');await writeFile(root+'/main.ts',script('First render'));
    // Match an ordinary `vite` launch: localhost may listen only on ::1.
    const project=await createVite({configFile:false,root,server:{port:0}});await project.listen();
    const projectAddress=project.httpServer!.address() as {port:number};let previewOrigin='';
    try {
      await open(page,host);await navigate(page,`http://localhost:${projectAddress.port}/nested?q=1`);
      const frame=page.frameLocator('iframe[title="Web preview"]');await expect(frame.getByRole('heading',{name:'First render',exact:true})).toBeVisible();
      previewOrigin=await page.locator('iframe').evaluate((node:HTMLIFrameElement)=>new URL(node.src).origin);expect(previewOrigin).not.toBe(host.url);
      await expect(frame.locator('body')).toHaveAttribute('data-isolated','yes');await frame.getByRole('button',{name:'Project action'}).click();await expect(frame.locator('output')).toHaveText('operated');
      // A real Vite module update travels through the separate Go WebSocket proxy.
      await writeFile(root+'/main.ts',script('Hot updated 中文'));await expect(frame.getByRole('heading',{name:'Hot updated 中文',exact:true})).toBeVisible();
      const targetFrame=page.frames().find((candidate:any)=>candidate.url().startsWith(previewOrigin));
      expect(await targetFrame!.evaluate(async(desk:string)=>{try{await fetch(desk+'/api/state',{credentials:'include'});return false}catch{return true}},host.url)).toBe(true);
      await tools(page).getByRole('button',{name:'Refresh',exact:true}).click();
      await expect.poll(()=>page.locator('iframe').evaluate((node:HTMLIFrameElement)=>new URL(node.src).origin)).not.toBe(previewOrigin);
      await expect(frame.getByRole('heading',{name:'Hot updated 中文',exact:true})).toBeVisible();
      const nextOrigin=await page.locator('iframe').evaluate((node:HTMLIFrameElement)=>new URL(node.src).origin);expect(nextOrigin).not.toBe(previewOrigin);
      if(mode==='server') {
        const other=await context.newPage();await other.goto(host.url);await other.getByRole('button',{name:'Continue here',exact:true}).click();await expect(other.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();
        await expect(page.getByRole('button',{name:'Continue here',exact:true})).toBeVisible();await expect(page.locator('iframe')).toHaveCount(0);
        const expired=await context.request.get(nextOrigin+'/main.ts');expect(expired.status()).toBe(410);await other.close();
      } else {
        await tools(page).getByRole('button',{name:'Close tools',exact:true}).click();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toHaveValue('Keep my draft 中文');
      }
    } finally {await project.close();}
  });

  test('external pages embed directly; denied embedding keeps external opening available and invalid URLs cannot replace the frame',async({page,host,context})=>{
    const received:string[]=[];
    await context.route('https://embed.example.test/**',route=>{received.push(route.request().url());return route.fulfill({contentType:'text/html',headers:route.request().url().endsWith('/denied')?{'X-Frame-Options':'DENY'}:{},body:'<h1>External content</h1><button onclick="this.textContent=\'Done\'">Try</button>'});});
    await open(page,host);await navigate(page,'https://embed.example.test/allowed');
    await expect(page.frameLocator('iframe').getByRole('heading',{name:'External content'})).toBeVisible();await page.frameLocator('iframe').getByRole('button',{name:'Try',exact:true}).click();await expect(page.frameLocator('iframe').getByRole('button',{name:'Done',exact:true})).toBeVisible();
    await navigate(page,'https://embed.example.test/denied');await expect.poll(()=>received.includes('https://embed.example.test/denied')).toBe(true);
    await tools(page).getByRole('button',{name:'Refresh',exact:true}).click({button:'right'});await expect(page.getByRole('menuitem',{name:'Open externally',exact:true})).toBeEnabled();
    const popupPromise=page.waitForEvent('popup');await page.getByRole('menuitem',{name:'Open externally',exact:true}).click();const popup=await popupPromise;await expect(popup).toHaveURL('https://embed.example.test/denied');expect(await popup.evaluate(()=>window.opener)).toBeNull();await popup.close();
    await navigate(page,host.url);await expect(tools(page)).toContainText('cannot preview itself');await expect(page.locator('iframe')).toHaveAttribute('src','https://embed.example.test/denied');
    await tools(page).getByRole('button',{name:'New tool tab',exact:true}).click();await page.getByRole('menuitem',{name:'New Web',exact:true}).click();await expect(tools(page).getByRole('tab',{name:'Web',exact:true})).toHaveCount(1);
    await tools(page).getByRole('button',{name:'Close tools',exact:true}).click();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toHaveValue('Keep my draft 中文');
  });
});
