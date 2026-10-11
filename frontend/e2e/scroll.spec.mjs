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
  expect(Math.max(result.switchedGap, result.resumedGap, result.resizedComposerGap)).toBeLessThanOrEqual(1);
});
