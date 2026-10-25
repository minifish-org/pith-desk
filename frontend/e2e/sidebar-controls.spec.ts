import {expect, type Locator} from '@playwright/test';
import {test} from './host-fixture.mjs';

async function expectToolsHeader(tools: Locator) {
  const heading=tools.locator('[data-rail-heading]');
  await expect(tools.getByText('Workspace tools',{exact:true})).toHaveCount(0);
  const row=(await heading.boundingBox())!;
  for(const control of [heading.getByRole('tablist'),heading.getByRole('button',{name:'New tool tab',exact:true}),heading.getByRole('button',{name:'Close tools',exact:true})]) {
    await expect(control).toBeVisible();
    const box=(await control.boundingBox())!;
    expect(Math.abs(box.y+box.height/2-row.y-row.height/2)).toBeLessThanOrEqual(1);
    expect(box.x).toBeGreaterThanOrEqual(row.x);
    expect(box.x+box.width).toBeLessThanOrEqual(row.x+row.width);
  }
}

for(const mode of ['desktop','server']) test.describe(mode+' sidebar controls',()=>{
  test.use({hostMode:mode});
  test('open rails own their controls; closed rails expose topbar openers and preserve drafts',async({page,host})=>{
    await page.goto(host.url);
    const draft=page.getByRole('textbox',{name:'Message Pith',exact:true});
    await expect(draft).toBeEditable();
    await draft.fill('Sidebar draft 中文');
    await draft.evaluate((node:HTMLTextAreaElement)=>node.setSelectionRange(2,7));
    const nav=page.getByRole('complementary',{name:'Navigation',exact:true});
    const tools=page.getByRole('complementary',{name:'Workspace tools',exact:true});
    const topbar=page.locator('header');
    const openLeft=topbar.getByRole('button',{name:'Toggle navigation',exact:true});
    const openRight=topbar.getByRole('button',{name:'Toggle tools',exact:true});
    const closeLeft=nav.getByRole('button',{name:'Close navigation',exact:true});
    const closeRight=tools.getByRole('button',{name:'Close tools',exact:true});
    await expect(closeLeft).toBeVisible();
    await expect(openLeft).toHaveCount(0);
    await expect(openRight).toBeVisible();
    await openRight.click();
    await expect(closeRight).toBeVisible();
    await tools.getByRole('button',{name:'Open files',exact:true}).click();
    await expectToolsHeader(tools);
    await expect(topbar.getByRole('button',{name:/Toggle (navigation|tools)/})).toHaveCount(0);
    const header=(await topbar.boundingBox())!;
    expect(header.height).toBe(44);
    for(const rail of [nav,tools]) {
      const row=(await rail.locator('[data-rail-heading]').boundingBox())!;
      expect(row.height).toBe(header.height);
      expect(row.y).toBe(header.y);
    }
    for(const [rail,button] of [[nav,closeLeft],[tools,closeRight]]) {
      const region=(await rail.boundingBox())!,control=(await button.boundingBox())!;
      expect(control.x).toBeGreaterThanOrEqual(region.x);
      expect(control.x+control.width).toBeLessThanOrEqual(region.x+region.width);
      expect(control.y-region.y).toBeLessThan(40);
      await expect(button).toHaveText('');
      await expect(button).toHaveAttribute('title',/Close/);
      await expect(button).toHaveAttribute('aria-expanded','true');
    }
    await closeLeft.click();
    await expect(openLeft).toBeFocused();
    await expect(closeRight).toBeVisible();
    await closeRight.click();
    await expect(openRight).toBeFocused();
    await expect(openLeft).toBeVisible();
    expect((await openLeft.boundingBox())!.x).toBeLessThan((await openRight.boundingBox())!.x);
    await expect(topbar).toHaveCSS('height','44px');
    await openLeft.press('Space');
    await expect(closeLeft).toBeFocused();
    await closeLeft.press('Enter');
    await expect(openLeft).toBeFocused();
    await openRight.focus();
    await openRight.press('Space');
    await expect(closeRight).toBeFocused();
    await closeRight.press('Enter');
    await expect(openRight).toBeFocused();
    await expect(draft).toHaveValue('Sidebar draft 中文');
    expect(await draft.evaluate((node:HTMLTextAreaElement)=>[node.selectionStart,node.selectionEnd])).toEqual([2,7]);
  });

  test('a collapsed rail opens only from its toggle, not from a gutter drag', async ({page, host}) => {
    await page.goto(host.url);
    await expect(page.getByRole('textbox', {name: 'Message Pith', exact: true})).toBeEditable();
    const navigation = page.getByRole('complementary', {name: 'Navigation', exact: true});
    const tools = page.getByRole('complementary', {name: 'Workspace tools', exact: true});
    const width = (rail: Locator) => rail.evaluate(node => Math.round(node.getBoundingClientRect().width));
    const mainWidth = () => page.locator('main').evaluate(node => Math.round(node.getBoundingClientRect().width));
    await page.getByRole('button', {name: 'Close navigation', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Toggle navigation', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Toggle tools', exact: true})).toBeVisible();
    const before = {navigation: await width(navigation), tools: await width(tools), main: await mainWidth()};
    for (const [name, dx] of [['Resize navigation', 140], ['Resize tools', -140]] as const) {
      const box = (await page.getByRole('separator', {name, exact: true}).boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + 100;
      await page.mouse.move(x, y);
      const cursor = await page.evaluate(({x, y}) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        return el ? getComputedStyle(el).cursor : 'none';
      }, {x, y});
      expect(cursor).not.toBe('col-resize');
      await page.mouse.down();
      await page.mouse.move(x + dx, y, {steps: 8});
      await page.mouse.up();
    }
    // Dragging the gutters leaves both rails closed and the centre untouched.
    await expect(page.getByRole('button', {name: 'Toggle navigation', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Toggle tools', exact: true})).toBeVisible();
    expect({navigation: await width(navigation), tools: await width(tools), main: await mainWidth()}).toEqual(before);
  });

  test('800px drawers retain their widths, dialog focus and terminal Escape', async ({page, host}) => {
    await page.setViewportSize({width: 800, height: 840});
    await page.goto(host.url);
    const draft = page.getByRole('textbox', {name: 'Message Pith', exact: true});
    await expect(draft).toBeEditable();
    await draft.fill('Mid-size drawer draft 中文');
    const openNavigation = page.getByRole('button', {name: 'Toggle navigation', exact: true});
    const navigation = page.getByRole('complementary', {name: 'Navigation', exact: true});
    await openNavigation.click();
    await expect(navigation.getByRole('button', {name: 'Close navigation', exact: true})).toBeFocused();
    expect(Math.round((await navigation.boundingBox())!.width)).toBe(280);
    await navigation.getByRole('button', {name: 'Settings', exact: true}).click();
    const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
    await expect(navigation).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect.poll(() => settings.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await settings.getByRole('button', {name: 'Close', exact: true}).click();
    await expect(settings).toHaveCount(0);

    const openTools = page.getByRole('button', {name: 'Toggle tools', exact: true});
    const tools = page.getByRole('complementary', {name: 'Workspace tools', exact: true});
    const closeTools = tools.getByRole('button', {name: 'Close tools', exact: true});
    await openTools.click();
    await expect(closeTools).toBeFocused();
    const bounds = (await tools.boundingBox())!;
    expect(Math.round(bounds.width)).toBe(340);
    expect(Math.round(bounds.x + bounds.width)).toBe(800);
    await tools.getByRole('button', {name: 'Open terminal', exact: true}).click();
    await expect(tools.getByLabel('Interactive terminal', {exact: true})).toHaveAttribute('aria-disabled', 'false');
    const input = tools.getByRole('textbox', {name: 'Terminal input', exact: true});
    await input.focus();
    await input.press('Escape');
    await expect(tools).toBeVisible();
    await expect(input).toBeFocused();
    await closeTools.focus();
    await closeTools.press('Escape');
    await expect(tools).toHaveCount(0);
    await expect(openTools).toBeFocused();
    await expect(draft).toHaveValue('Mid-size drawer draft 中文');
  });
});

test('closing tools cancels a width restore that cannot fit the current window', async ({page, host}) => {
  await page.setViewportSize({width: 1600, height: 840});
  await page.goto(host.url);
  await expect(page.getByRole('textbox', {name: 'Message Pith', exact: true})).toBeEditable();
  await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
  const handle = (await page.getByRole('separator', {name: 'Resize tools', exact: true}).boundingBox())!;
  const saved = page.waitForResponse(response => response.url().endsWith('/api/sidebar-widths') && response.ok());
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 500, handle.y + 100, {steps: 10});
  await page.mouse.up();
  await saved;
  expect((await host.command('state')).state.settings.toolsWidth).toBe(800);
  await page.setViewportSize({width: 1000, height: 840});
  await page.reload();
  await expect(page.getByRole('textbox', {name: 'Message Pith', exact: true})).toBeEditable();
  const frames = await page.evaluate(async () => {
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    document.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools"]')!.click();
    await frame(); await frame();
    document.querySelector<HTMLButtonElement>('button[aria-label="Close tools"]')!.click();
    // Observe several paints after closing while the old width restore would still be pending.
    await frame(); await frame();
    const states = [];
    for (let index = 0; index < 10; index++) {
      await frame();
      states.push({
        width: document.querySelector('[data-panel][id="tools"]')!.getBoundingClientRect().width,
        focused: document.activeElement === document.querySelector('header button[aria-label="Toggle tools"]'),
      });
    }
    return states;
  });
  expect(frames).toEqual(Array.from({length: 10}, () => ({width: 0, focused: true})));
});

test.describe('phone panel controls',()=>{
  test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  test('top panel controls and Escape dismiss overlays and restore the corresponding opener',async({page,host})=>{
    await page.goto(host.url);
    const draft=page.getByRole('textbox',{name:'Message Pith',exact:true});
    await expect(draft).toBeEditable();
    await draft.fill('Phone draft 中文');
    await page.evaluate(()=>{Object.defineProperty(window.visualViewport!,'height',{configurable:true,value:330});window.visualViewport!.dispatchEvent(new Event('resize'));});
    for(const [label,openName,closeName] of [['Navigation','Toggle navigation','Close navigation'],['Workspace tools','Toggle tools','Close tools']]) {
      const opener=page.getByRole('button',{name:openName,exact:true});
      const panel=page.getByRole('complementary',{name:label,exact:true});
      const close=panel.getByRole('button',{name:closeName,exact:true});
      await opener.click();
      await expect(close).toBeFocused();
      const box=(await close.boundingBox())!,region=(await panel.boundingBox())!;
      expect(box.y-region.y).toBeLessThan(40);
      expect(box.y+box.height).toBeLessThanOrEqual(330);
      await expect(page.locator('header')).toHaveCSS('height','44px');
      await expect(panel.locator('[data-rail-heading]')).toHaveCSS('height','44px');
      if(label==='Workspace tools') {
        await expect(panel.getByRole('tab')).toHaveCount(0);
        for(const entry of ['Open files','Open terminal','Open Web']) {
          const button=panel.getByRole('button',{name:entry,exact:true});
          await expect(button).toBeVisible();
          const bounds=(await button.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(region.x);
          expect(bounds.x+bounds.width).toBeLessThanOrEqual(region.x+region.width);
          expect(bounds.y+bounds.height).toBeLessThanOrEqual(330);
        }
        await panel.getByRole('button',{name:'Open Web',exact:true}).click();
        for(let index=0;index<4;index++) {
          await panel.getByRole('button',{name:'New tool tab',exact:true}).click();
          await page.getByRole('menuitem',{name:'New files',exact:true}).click();
        }
        await expect(panel.getByRole('tab')).toHaveCount(5);
        await expectToolsHeader(panel);
      }
      await close.press('Escape');
      await expect(opener).toBeFocused();
      await opener.press('Enter');
      await close.click();
      await expect(opener).toBeFocused();
    }
    await expect(draft).toHaveValue('Phone draft 中文');
  });
});
