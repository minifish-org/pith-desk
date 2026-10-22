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
async function opened(page:any,action:()=>Promise<unknown>) {
  const next=page.waitForEvent('popup');await action();const tab=await next;
  await expect.poll(()=>tab.url()).not.toBe('about:blank');return tab;
}
const script=(label:string)=>`export const label=${JSON.stringify(label)};document.querySelector('h1').textContent=label;document.querySelector('button').onclick=()=>document.querySelector('output').textContent='operated';document.body.dataset.isolated=opener===null&&parent===window?'yes':'no';if(import.meta.hot)import.meta.hot.accept(m=>document.querySelector('h1').textContent=m.label);`;

for(const mode of ['desktop','server'])test.describe(mode+' browser intent',()=>{
  test.use({hostMode:mode});
  test('independent tabs preserve paths, resources and real Vite HMR through tool lifecycle; takeover revokes Server access',async({page,host,context})=>{
    const root=host.state.workspaces[0].path;
    await writeFile(root+'/index.html','<!doctype html><h1>Loading</h1><button>Project action</button><output></output><script type="module" src="/main.ts"></script>');await writeFile(root+'/main.ts',script('First render'));
    const project=await createVite({configFile:false,root,server:{port:0}});await project.listen();
    const port=(project.httpServer!.address() as {port:number}).port;
    try {
      await open(page,host);
      const first=await opened(page,()=>navigate(page,`http://localhost:${port}/nested?q=1`));
      await expect(first.getByRole('heading',{name:'First render',exact:true})).toBeVisible();
      const origin=new URL(first.url()).origin;expect(origin).not.toBe(host.url);expect(new URL(first.url()).pathname).toBe('/nested');expect(new URL(first.url()).search).toBe('?q=1');
      if(mode==='server')expect(origin).not.toBe(`http://localhost:${port}`);
      await expect(first.locator('body')).toHaveAttribute('data-isolated','yes');expect(await first.evaluate(()=>window.opener)).toBeNull();
      await first.getByRole('button',{name:'Project action'}).click();await expect(first.locator('output')).toHaveText('operated');
      expect(await first.evaluate(async(desk:string)=>{try{await fetch(desk+'/api/state',{credentials:'include'});return false}catch{return true}},host.url)).toBe(true);
      const second=await opened(page,()=>tools(page).getByRole('button',{name:'Refresh',exact:true}).click());await expect(second.getByRole('heading',{name:'First render',exact:true})).toBeVisible();
      if(mode==='server')expect(new URL(second.url()).origin).not.toBe(origin);
      await expect(first.locator('output')).toHaveText('operated');
      await tools(page).getByRole('button',{name:'Close Web',exact:true}).click();await tools(page).getByRole('button',{name:'Close tools',exact:true}).click();
      await writeFile(root+'/main.ts',script('Hot updated 中文'));
      for(const tab of [first,second])await expect(tab.getByRole('heading',{name:'Hot updated 中文',exact:true})).toBeVisible();
      await page.reload();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toHaveValue('Keep my draft 中文');
      // Reload resumes the same lease, independently of the removed tool view.
      await expect(first.getByRole('heading',{name:'Hot updated 中文',exact:true})).toBeVisible();
      if(mode==='server') {
        const other=await context.newPage();await other.goto(host.url);await other.getByRole('button',{name:'Continue here',exact:true}).click();await expect(other.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();
        for(const tab of [first,second]) {
          const failed=await context.request.get(new URL('/main.ts',tab.url()).href).then(r=>r.status()===410,()=>true);expect(failed).toBe(true);
        }
        await other.close();
      }
      await first.close();await second.close();await expect(page.locator('iframe')).toHaveCount(0);
    }finally{await project.close();}
  });
  test('HTTP and HTTPS domain, public and private addresses open directly with no Desk credentials',async({page,host,context})=>{
    const addresses=['https://web.example.test/path','http://8.8.8.8:8080/','http://192.168.1.20:3000/','https://10.0.0.2/','http://[fd00::1]:8080/'];
    const received=new Map<string,Record<string,string>>();
    for(const address of addresses)await context.route(address,async route=>{
      received.set(route.request().url(),await route.request().allHeaders());await route.fulfill({contentType:'text/html',headers:{'X-Frame-Options':'DENY'},body:'<h1>Direct preview</h1>'});
    });
    await open(page,host);
    for(const address of addresses){
      const tab=await opened(page,()=>navigate(page,address));await expect(tab).toHaveURL(address);await expect(tab.getByRole('heading',{name:'Direct preview',exact:true})).toBeVisible();expect(await tab.evaluate(()=>window.opener)).toBeNull();
      const headers=received.get(address)!;expect(headers).toBeDefined();for(const name of ['authorization','cookie','x-desk-lease','x-desk-request','referer'])expect(headers[name]).toBeUndefined();await tab.close();
    }
    await expect(page.locator('iframe')).toHaveCount(0);await expect(tools(page).getByRole('button',{name:'Refresh',exact:true})).toHaveCount(1);
  });
  test('rejected targets close their reserved tab, retain address drafts and allow multiple independent Web tools',async({page,host,context})=>{
    await context.route('https://external.example.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>External content</h1>'}));
    await open(page,host);const first=await opened(page,()=>navigate(page,'https://external.example.test/'));
    await expect(first.getByRole('heading',{name:'External content'})).toBeVisible();
    await navigate(page,host.url);await expect(tools(page)).toContainText('cannot preview itself');await expect(first.getByRole('heading',{name:'External content'})).toBeVisible();
    await tools(page).getByRole('button',{name:'New tool tab',exact:true}).click();await page.getByRole('menuitem',{name:'New Web',exact:true}).click();await expect(tools(page).getByRole('tab',{name:'Web',exact:true})).toHaveCount(2);
    await first.close();await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toHaveValue('Keep my draft 中文');
  });
});
