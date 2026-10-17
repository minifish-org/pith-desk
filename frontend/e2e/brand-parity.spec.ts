import{test,expect}from'./test.ts';
import{installFixture}from'./fixture.mjs';
for(const appearance of ['light','dark'] as const)test(`the ${appearance} application retains the app-owned four-tile logo and wordmark`,async({page})=>{
  await page.addInitScript(installFixture);await page.addInitScript(value=>{(window as any).reviewState.settings.appearance=value;},appearance);await page.goto('/');await expect(page.locator('ui=[id$=composer-input]')).toBeEditable();
  const mark=page.locator('.pui-split-navigation .pui-image-brand img');await expect(mark).toBeVisible();expect(await mark.evaluate((image:HTMLImageElement)=>({width:image.clientWidth,height:image.clientHeight,local:new URL(image.src).origin===location.origin}))).toEqual({width:24,height:24,local:true});
  const source=await page.request.get(await mark.getAttribute('src') as string),svg=await source.text();expect(source.ok()).toBe(true);expect((svg.match(/<(?:rect|path)\b/g)??[])).toHaveLength(4);expect(svg).toContain(appearance==='light'?'#4A62C8':'#86B6F2');await expect(page.locator('.pui-split-navigation')).toContainText('Pith Desk');
});
