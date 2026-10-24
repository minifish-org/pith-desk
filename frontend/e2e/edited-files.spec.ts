import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

const files = Array.from({length: 7}, (_, index) => ({
  path: `/tmp/pith-review/src/feature-${index}.ts`,
  name: `feature-${index}.ts`,
  additions: index + 1,
  deletions: index,
}));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(files => {
    const fixture = (window as any).review;
    fixture.artifacts = files;
    fixture.artifactDiff = {
      changes: [{patch: '--- a/src/feature-0.ts\n+++ b/src/feature-0.ts\n@@ -1 +1,2 @@\n-original\n+first\n+second\n', additions: 2, deletions: 1}],
    };
    fixture.artifactPreview = {kind: 'text', text: 'first\nsecond\n'};
  }, files);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!.readOnly);
});

test('conversation edits read as one summary card with totals and an expandable file list', async ({ page }) => {
  const card = page.locator('[data-edited-files]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-edited-files-title]')).toHaveText('Edited 7 files');
  await expect(card.locator('[data-edit-totals]')).toContainText('+28');
  await expect(card.locator('[data-edit-totals]')).toContainText('-21');
  await expect(card.locator('[data-edited-file]')).toHaveCount(4);
  await expect(card.locator('[data-edited-file]').first()).toHaveAccessibleName('Preview src/feature-0.ts');
  await expect(card.locator('[data-edited-file]').nth(1)).toContainText('+2');
  await expect(card.locator('[data-edited-file]').nth(1)).toContainText('-1');
  const toggle = card.locator('[data-edited-files-toggle]');
  await expect(toggle).toHaveText('Show all 7 files');
  await toggle.click();
  await expect(card.locator('[data-edited-file]')).toHaveCount(7);
  await expect(toggle).toHaveText('Show fewer files');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(card.locator('[data-edited-file]')).toHaveCount(4);

  await card.locator('[data-edited-file]').first().click();
  const preview = page.getByRole('dialog', {name: 'feature-0.ts', exact: true});
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('/tmp/pith-review/src/feature-0.ts');
  await expect(preview.locator('[data-preview-mode]')).toContainText('1 change');
  await expect(preview.locator('[data-preview-diff]')).toContainText('+first');
  await expect(preview.locator('[data-preview-diff]')).toContainText('-original');
  await preview.getByRole('button', {name: 'File', exact: true}).click();
  await expect(preview.locator('[data-file-preview-text]')).toContainText('second');
  await expect(preview.locator('[data-preview-diff]')).toHaveCount(0);
  await preview.getByRole('button', {name: 'Diff', exact: true}).click();
  await expect(preview.locator('[data-preview-diff]')).toContainText('+first');
  await preview.getByRole('button', {name: 'Open', exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).review.requests.filter((request: any) => request.path === '/api/file').map((request: any) => request.body))).toEqual([
    {kind: 'artifact', id: 'a', path: '/tmp/pith-review/src/feature-0.ts', action: 'open'},
  ]);
});

test('recorded changes are listed in order and legacy files fall back to the complete file', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).review.artifactDiff = {changes: [
      {patch: '@@ -1 +1 @@\n-first\n+one\n', additions: 1, deletions: 1},
      {patch: '@@ -1 +1 @@\n-one\n+two\n', additions: 2, deletions: 1},
    ]};
  });
  await page.locator('[data-edited-file]').first().click();
  const preview = page.getByRole('dialog', {name: 'feature-0.ts', exact: true});
  await expect(preview.locator('[data-preview-change]')).toHaveCount(2);
  await expect(preview.locator('[data-preview-change]').nth(0)).toContainText('Change 1 of 2');
  await expect(preview.locator('[data-preview-change]').nth(0)).toContainText('+one');
  await expect(preview.locator('[data-preview-change]').nth(1)).toContainText('Change 2 of 2');
  await expect(preview.locator('[data-preview-change]').nth(1)).toContainText('+two');
  await expect(preview.locator('[data-preview-mode]')).toContainText('2 changes');

  await preview.getByRole('button', {name: 'Close', exact: true}).first().click();
  await page.evaluate(() => {(window as any).review.artifactDiff = {changes: []};});
  await page.locator('[data-edited-file]').first().click();
  const legacy = page.getByRole('dialog', {name: 'feature-0.ts', exact: true});
  await expect(legacy.locator('[data-preview-no-diff]')).toContainText('No diff was recorded');
  await expect(legacy.locator('[data-file-preview-text]')).toContainText('second');
  await expect(legacy.locator('[data-preview-mode]')).toHaveCount(0);
});

for (const outcome of ['failure', 'success']) {
  test(`retired artifact ${outcome} cannot replace the current conversation result`, async ({page}) => {
    await expect(page.locator('[data-edited-files]')).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as any).review;
      fixture.pendingArtifacts = [];
      const original = window.fetch;
      window.fetch = (url, options) => {
        const target = new URL(String(url), location.href);
        if (target.pathname !== '/api/artifacts') return original(url, options);
        return new Promise<Response>(resolve => fixture.pendingArtifacts.push({id: target.searchParams.get('id'), resolve}));
      };
    });
    await page.locator('button[title="Conversation b"]').click();
    await page.waitForFunction(() => (window as any).review.pendingArtifacts.length === 1);
    await page.locator('button[title="Conversation a"]').click();
    await page.waitForFunction(() => (window as any).review.pendingArtifacts.length === 2);

    if (outcome === 'success') {
      await page.locator('button[title="Conversation b"]').click();
      await page.waitForFunction(() => (window as any).review.pendingArtifacts.length === 3);
      await page.evaluate(() => {
        const pending = (window as any).review.pendingArtifacts;
        pending[2].resolve(Response.json([{path: '/tmp/pith-review/new.txt', name: 'new.txt'}]));
      });
      await expect(page.locator('[data-edited-file]')).toHaveAccessibleName('Preview new.txt');
    }
    await page.evaluate(async outcome => {
      const pending = (window as any).review.pendingArtifacts;
      pending[1].resolve(Response.json([]));
      pending[0].resolve(outcome === 'failure'
        ? Response.json({error: 'Retired conversation failed'}, {status: 503})
        : Response.json([{path: '/tmp/pith-review/old.txt', name: 'old.txt'}]));
      // Let both released responses and their React updates reach the screen.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, outcome);
    await expect(page.locator('[data-artifacts-error]')).toHaveCount(0);
    if (outcome === 'success') await expect(page.locator('[data-edited-file]')).toHaveAccessibleName('Preview new.txt');
    else await expect(page.locator('[data-edited-files]')).toHaveCount(0);
  });
}
