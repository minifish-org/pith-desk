import {test,expect} from '@playwright/test';

test('diff distinguishes metadata, additions and removals and escapes file content',async({page})=>{
  await page.route('**/parts-regression.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto('/parts-regression.html');
  const value=await page.evaluate(async()=>{
    const path='/e2e/fixtures/parts-regression.ts';const {diffFixture}=await import(path);
    return diffFixture('--- note.md\n+++ note.md\n@@ -1 +1 @@\n-<script>old</script>\n+<img src=x onerror=alert(1)>\n context');
  });
  // Keep the original renderDiff escaping/meta/add/remove/context assertions,
  // now applied to DOM produced by the official PreformattedPart(kind:'diff').
  expect(value.html).toMatch(/diff-meta/);
  expect(value.html).toMatch(/diff-remove.*&lt;script&gt;old&lt;\/script&gt;/);
  expect(value.html).toMatch(/diff-add.*&lt;img src=x onerror=alert\(1\)&gt;/);
  expect(value.html).toMatch(/diff-context.*context/);
  expect(value.html).not.toMatch(/<script>|<img/);
  expect(value.scripts).toBe(0);expect(value.images).toBe(0);
});
