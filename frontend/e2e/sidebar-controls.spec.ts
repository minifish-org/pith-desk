import {expect} from '@playwright/test';
import {test} from './host-fixture.mjs';

for(const mode of ['desktop','server']) test.describe(mode+' sidebar controls',()=>{
  test.use({hostMode:mode});
  test('open rails own their controls; closed rails expose topbar openers and preserve drafts',async({page,host})=>{
    await page.goto(host.url);const draft=page.getByRole('textbox',{name:'Message Pith',exact:true});await expect(draft).toBeEditable();await draft.fill('Sidebar draft 中文');await draft.evaluate((node:HTMLTextAreaElement)=>node.setSelectionRange(2,7));
    const nav=page.getByRole('complementary',{name:'Navigation',exact:true}),tools=page.getByRole('complementary',{name:'Workspace tools',exact:true}),topbar=page.locator('.pui-topbar');
    const openLeft=topbar.getByRole('button',{name:'Toggle navigation',exact:true}),openRight=topbar.getByRole('button',{name:'Toggle tools',exact:true});
    const closeLeft=nav.getByRole('button',{name:'Close navigation',exact:true}),closeRight=tools.getByRole('button',{name:'Close tools',exact:true});
    await expect(closeLeft).toBeVisible();await expect(openLeft).toHaveCount(0);await expect(openRight).toBeVisible();
    await openRight.click();await expect(closeRight).toBeVisible();await expect(topbar.getByRole('button',{name:/Toggle (navigation|tools)/})).toHaveCount(0);
    const header=(await topbar.boundingBox())!;expect(header.height).toBe(44);
    for(const row of [nav.locator('.pui-navigation-top'),tools.locator('.pui-tool-tabs-heading')]) {
      const box=(await row.boundingBox())!;expect(box.height).toBe(header.height);expect(box.y).toBe(header.y);
    }
    for(const [rail,button] of [[nav,closeLeft],[tools,closeRight]]) {
      const region=(await rail.boundingBox())!,control=(await button.boundingBox())!;expect(control.x).toBeGreaterThanOrEqual(region.x);expect(control.x+control.width).toBeLessThanOrEqual(region.x+region.width);expect(control.y-region.y).toBeLessThan(40);
      await expect(button).toHaveText('');await expect(button).toHaveAttribute('title',/Close/);await expect(button).toHaveAttribute('aria-expanded','true');
    }
    const strip=(await tools.getByRole('tablist',{name:'Workspace tools',exact:true}).boundingBox())!,right=(await closeRight.boundingBox())!;expect(Math.abs(strip.y-right.y)).toBeLessThan(8);
    await closeLeft.click();await expect(openLeft).toBeFocused();await expect(closeRight).toBeVisible();
    await closeRight.click();await expect(openRight).toBeFocused();await expect(openLeft).toBeVisible();expect((await openLeft.boundingBox())!.x).toBeLessThan((await openRight.boundingBox())!.x);
    await expect(topbar).toHaveCSS('height','44px');
    await openLeft.press('Space');await expect(closeLeft).toBeFocused();await closeLeft.press('Enter');await expect(openLeft).toBeFocused();
    await openRight.focus();await openRight.press('Space');await expect(closeRight).toBeFocused();await closeRight.press('Enter');await expect(openRight).toBeFocused();
    await expect(draft).toHaveValue('Sidebar draft 中文');expect(await draft.evaluate((node:HTMLTextAreaElement)=>[node.selectionStart,node.selectionEnd])).toEqual([2,7]);
  });
});

test.describe('phone panel controls',()=>{
  test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  test('top panel controls and Escape dismiss overlays and restore the corresponding opener',async({page,host})=>{
    await page.goto(host.url);const draft=page.getByRole('textbox',{name:'Message Pith',exact:true});await expect(draft).toBeEditable();await draft.fill('Phone draft 中文');
    await page.evaluate(()=>{Object.defineProperty(window.visualViewport!,'height',{configurable:true,value:330});window.visualViewport!.dispatchEvent(new Event('resize'));});
    for(const [label,openName,closeName] of [['Navigation','Toggle navigation','Close navigation'],['Workspace tools','Toggle tools','Close tools']]) {
      const opener=page.getByRole('button',{name:openName,exact:true}),panel=page.getByRole('complementary',{name:label,exact:true}),close=panel.getByRole('button',{name:closeName,exact:true});
      await opener.click();await expect(close).toBeFocused();const box=(await close.boundingBox())!,region=(await panel.boundingBox())!;expect(box.y-region.y).toBeLessThan(40);expect(box.y+box.height).toBeLessThanOrEqual(330);
      await expect(page.locator('.pui-topbar')).toHaveCSS('height','44px');
      await expect(panel.locator(label==='Navigation' ? '.pui-navigation-top' : '.pui-tool-tabs-heading')).toHaveCSS('height','44px');
      await close.press('Escape');await expect(opener).toBeFocused();await opener.press('Enter');await close.click();await expect(opener).toBeFocused();
    }
    await expect(draft).toHaveValue('Phone draft 中文');
  });
});
