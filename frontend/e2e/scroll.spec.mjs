import { test, expect } from '@playwright/test';
import { verifyScroll } from './scroll-fixture.mjs';

test('text, image decoding and composer resizing follow latest while manual reading stays anchored', async ({ page }) => {
  test.setTimeout(60000);
  const result = await verifyScroll(page);
  expect(Math.max(...result.text, ...result.image), JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.imageNodesReused).toBe(true);
  expect(result.imageRenderRaceGap).toBeLessThanOrEqual(1);
  expect(result.reading.drift).toBe(0);
  expect(result.reading.latestVisible).toBe(true);
  expect(result.switchedReadingDrift).toBe(0);
  expect(Math.max(result.switchedGap, result.resumedGap)).toBeLessThanOrEqual(1);

  const composer = page.getByRole('textbox', {name: 'Message Pith'});
  const scroll = page.locator('[data-conversation-scroll]');
  const height = () => composer.evaluate(element => element.getBoundingClientRect().height);
  const gap = () => scroll.evaluate(element => Math.round(element.scrollHeight - element.clientHeight - element.scrollTop));
  const shortHeight = await height();
  const multiline = 'A multi-line draft\n'.repeat(8);
  await composer.fill(multiline);
  await expect(composer).toHaveValue(multiline);
  await expect.poll(height).toBeGreaterThan(shortHeight);
  await expect.poll(gap).toBeLessThanOrEqual(1);

  await scroll.evaluate(element => {element.scrollTop -= 450;});
  await expect(page.getByRole('button', {name: 'Jump to latest'})).toBeVisible();
  const readingTop = await scroll.evaluate(element => element.scrollTop);
  await composer.fill('Short draft');
  await expect.poll(height).toBe(shortHeight);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(readingTop);
  await composer.fill(multiline);
  await expect.poll(height).toBeGreaterThan(shortHeight);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(readingTop);
  await expect(page.getByRole('button', {name: 'Jump to latest'})).toBeVisible();
});
