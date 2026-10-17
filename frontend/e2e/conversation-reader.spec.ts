import {test,expect,type Page} from '@playwright/test';
import type {ReaderFixture} from './fixtures/parts-regression';

declare global {interface Window {readerRegression:ReaderFixture}}
test.beforeEach(async ({page})=>{
  await page.route('**/parts-regression.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto('/parts-regression.html');
  await page.evaluate(async()=>{const path='/e2e/fixtures/parts-regression.ts';const {readerFixture}=await import(path);window.readerRegression=readerFixture();});
});
test.afterEach(async ({page})=>{await page.evaluate(()=>window.readerRegression?.destroy());});
async function findRanges(page:Page,text:string,query:string) {return page.evaluate(({text,query})=>window.readerRegression.findRanges(text,query),{text,query});}

test('find treats regular-expression characters as literal user text',async({page})=>{
  expect(await findRanges(page,'a+b [x] a+b','a+b')).toEqual([{start:0,end:3},{start:8,end:11}]);
  expect(await findRanges(page,'look for [x] or .*','[x]')).toEqual([{start:9,end:12}]);
  expect(await findRanges(page,'look for [x] or .*','.*')).toEqual([{start:16,end:18}]);
  expect(await findRanges(page,'anything','')).toEqual([]);
});
test('find preserves offsets for Chinese, emoji, mixed-case text and newlines',async({page})=>{
  const text='截图😀\nCODE code 截图';
  expect(await findRanges(page,text,'截图')).toEqual([{start:0,end:2},{start:15,end:17}]);
  expect(await findRanges(page,text,'code')).toEqual([{start:5,end:9},{start:10,end:14}]);
  expect(await findRanges(page,text,'😀')).toEqual([{start:2,end:4}]);
  expect(await findRanges(page,text,'missing')).toEqual([]);
});

// Exact assertions and event-order numbers from conversation-reader.test.mjs.
// Only installation changed: the official ReadingViewportPart owns the engine.
test('image decoding immediately before a render preserves automatic following',async({page})=>{
  const value=await page.evaluate(()=>{const view=window.readerRegression;view.grow(250);view.render();return {gap:view.gap(),hidden:view.latest.hidden};});
  expect(value.gap).toBe(0);expect(value.hidden).toBe(true);
});
test('layout-induced scroll events cannot disable following before the resize notification',async({page})=>{
  const gap=await page.evaluate(()=>{const view=window.readerRegression;view.grow(250);view.emitScroll();view.resize();return view.gap();});
  expect(gap).toBe(0);
});
test('scroll events during a pending render cannot overwrite the saved following preference',async({page})=>{
  const gap=await page.evaluate(()=>{const view=window.readerRegression;view.reader.beforeRender('a');view.grow(250);view.emitScroll();view.reader.afterRender();view.flush();view.grow(150);view.render();return view.gap();});
  expect(gap).toBe(0);
});
test('manual history reading keeps its anchor through image growth and streaming',async({page})=>{
  const value=await page.evaluate(()=>{const view=window.readerRegression;view.scroll.scrollTop=450;view.emitScroll();const offset=500-view.scroll.scrollTop;view.grow(250);view.moveAnchor(250);view.render();const retainedOffset=750-view.scroll.scrollTop,hidden=view.latest.hidden;view.grow(100);view.render();return {offset,retainedOffset,hidden,top:view.scroll.scrollTop};});
  expect(value.retainedOffset).toBe(value.offset);expect(value.hidden).toBe(false);expect(value.top).toBe(700);
});
test('temporary content shrinkage does not turn a history reader into a follower',async({page})=>{
  const value=await page.evaluate(()=>{const view=window.readerRegression;view.scroll.scrollTop=450;view.emitScroll();view.grow(-300);view.resize();view.grow(300);view.render();return {top:view.scroll.scrollTop,hidden:view.latest.hidden};});
  expect(value.top).toBe(450);expect(value.hidden).toBe(false);
});
test('sending or returning to latest overrides a pending reading-position restore',async({page})=>{
  const gap=await page.evaluate(()=>{const view=window.readerRegression;view.scroll.scrollTop=450;view.emitScroll();view.reader.beforeRender('a');view.grow(250);view.reader.afterRender();view.reader.followLatest();view.flush();view.grow(100);view.render();return view.gap();});
  expect(gap).toBe(0);
});
test('conversation switching restores history position and following independently',async({page})=>{
  const value=await page.evaluate(()=>{const view=window.readerRegression;view.scroll.scrollTop=450;view.emitScroll();view.render('b');const gapB=view.gap();view.render('a');const topA=view.scroll.scrollTop;view.grow(250);view.render('b');return {gapB,topA,finalGap:view.gap()};});
  expect(value.gapB).toBe(0);expect(value.topA).toBe(450);expect(value.finalGap).toBe(0);
});
