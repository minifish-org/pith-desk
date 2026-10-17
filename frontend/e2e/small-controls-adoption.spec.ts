import {test,expect} from './test.ts';

test.beforeEach(async({page})=>{
  await page.route('**/small-controls.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="app"></div></body></html>'}));
  await page.goto('/small-controls.html');
  await page.evaluate(async()=>{
    const library='/src/ui-mount.ts',controller='/src/confirmation.ts',styles='/node_modules/pith-ui/dist/styles.css';
    const [{mountApplication},{createConfirmation}]=await Promise.all([import(library),import(controller),import(styles)]);
    const ui=mountApplication();
    const confirm=createConfirmation(ui);
    const state={unavailable:false,calls:0,release:undefined as undefined|((ok:boolean)=>void)};
    const open=(subject:string)=>confirm({title:'Remove connection',action:'Remove',description:{before:'Remove ',subject,after:'?'},unavailable:()=>state.unavailable,
      run:()=>{state.calls++;return new Promise<boolean>(resolve=>state.release=resolve);},error:()=> 'Fixture rejected'});
    (window as any).smallFixture={ui,confirm,state,open};open('<original>');
  });
});

test('independent confirmation retains app modal guards, safe emphasis and availability',async({page})=>{
  const modal=page.locator('ui=.pui-owned-controls dialog[open]');
  await expect(modal).toHaveCount(1);
  await expect(modal.locator('ui=strong')).toHaveText('<original>');
  expect(await page.evaluate(()=>(window as any).smallFixture.ui.read().hasModal)).toBe(true);
  await page.evaluate(()=>{const f=(window as any).smallFixture;f.state.unavailable=true;f.confirm.render();});
  await expect(modal.getByRole('button',{name:'Remove',exact:true})).toBeDisabled();
  await modal.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('ui=.pui-owned-controls')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).smallFixture.ui.read().hasModal)).toBe(false);
});

test('old confirmation results do not update a replacement and failures stay in their own dialog',async({page})=>{
  const modal=page.getByRole('dialog',{name:'Remove connection'});
  await modal.getByRole('button',{name:'Remove',exact:true}).click();
  await expect(modal.getByRole('button',{name:'Remove',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).smallFixture.state.calls)).toBe(1);
  await modal.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('ui=.pui-owned-controls')).toHaveCount(0);
  await page.evaluate(()=>{const f=(window as any).smallFixture,release=f.state.release;f.open('replacement');release(false);});
  await expect(modal.locator('ui=strong')).toHaveText('replacement');
  await expect(modal.locator('ui=.pui-notice')).toBeHidden();
  await modal.getByRole('button',{name:'Remove',exact:true}).click();
  await page.evaluate(()=>(window as any).smallFixture.state.release(false));
  await expect(modal.locator('ui=.pui-notice')).toHaveText('Fixture rejected');
  await expect(modal.getByRole('button',{name:'Remove',exact:true})).toBeEnabled();
  await page.evaluate(()=>(window as any).smallFixture.confirm.destroy());
  await expect(page.locator('ui=.pui-owned-controls')).toHaveCount(0);
});
