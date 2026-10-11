import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('#composer-input').readOnly);
  await page.evaluate(() => {
    window.reviewState.messages = [{ id: 'download-answer', role: 'assistant', text: '[下载 Word 文档](output/报告%20v1.docx)', status: 'done' }];
    window.emitReview();
  });
});

test('local Word links download binary files with their Unicode names without entering the artifact list', async ({ page }, testInfo) => {
  const link = page.getByRole('link', { name: '下载 Word 文档' });
  await expect(link).toHaveAttribute('data-download-path', 'output/报告 v1.docx');
  await expect(page.locator('#artifacts-control')).toBeHidden();
  const received = page.waitForEvent('download');
  await link.click();
  const download = await received;
  expect(download.suggestedFilename()).toBe('报告 v1.docx');
  const destination = testInfo.outputPath('saved.docx');
  await download.saveAs(destination);
  expect(await readFile(destination)).toEqual(Buffer.from([80, 75, 3, 4, 0, 255]));
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/conversation-file').map(r => ({ method: r.method, input: r.body || r.query })))).toEqual([
    { method: 'POST', input: { id: 'a', path: 'output/报告 v1.docx' } },
    { method: 'GET', input: { id: 'a', path: 'output/报告 v1.docx' } },
  ]);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('native save cancellation and failure never fall back to an automatic browser download', async ({ page }) => {
  await page.evaluate(() => { window.review.nativeDownload = true; });
  await page.getByRole('link', { name: '下载 Word 文档' }).click();
  await expect(page.getByRole('link', { name: '下载 Word 文档' })).toHaveAttribute('aria-disabled', 'false');
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/conversation-file').map(r => r.method))).toEqual(['POST']);
  await page.evaluate(() => { window.review.failMutation = '/api/conversation-file'; });
  await page.getByRole('link', { name: '下载 Word 文档' }).click();
  await expect(page.locator('#inline-error')).toContainText('Fixture action rejected');
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/conversation-file').map(r => r.method))).toEqual(['POST', 'POST']);
});

test('a delayed save retains its original conversation after another workspace becomes active', async ({ page }) => {
  await page.evaluate(() => { window.review.holdSave = true; });
  await page.getByRole('link', { name: '下载 Word 文档' }).click();
  await page.waitForFunction(() => !!window.releaseSave);
  await page.evaluate(() => {
    window.reviewState.conversations.find(c => c.id === 'b').workspaceId = 'other';
    window.reviewState.activeId = 'b';
    window.reviewState.messages = [];
    window.emitReview();
  });
  const received = page.waitForEvent('download');
  await page.evaluate(() => window.releaseSave());
  await received;
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/conversation-file').map(r => r.body?.id || r.query.id))).toEqual(['a', 'a']);
});

test('file URLs use the local save action while external links and Markdown sanitization retain their behavior', async ({ page }) => {
  await page.evaluate(() => {
    window.reviewState.messages[0].text = '[Absolute](/tmp/work/report.docx) [File URI](file:///tmp/work/report%20v1.docx) [Website](https://example.com/report) [Bad](javascript:alert(1)) <a href="javascript:alert(1)" data-download-path="/secret">Forged</a><img src="https://example.com/track"><script>window.unsafeLink=true</script>';
    window.emitReview();
  });
  await expect(page.getByRole('link', { name: 'Absolute', exact: true })).toHaveAttribute('data-download-path', '/tmp/work/report.docx');
  await expect(page.getByRole('link', { name: 'File URI', exact: true })).toHaveAttribute('data-download-path', '/tmp/work/report v1.docx');
  const website = page.getByRole('link', { name: 'Website', exact: true });
  await expect(website).toHaveAttribute('href', 'https://example.com/report');
  await expect(website).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.markdown img, .markdown script')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Forged', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.unsafeLink)).toBeUndefined();
});
