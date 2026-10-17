import { expect } from '@playwright/test';
import { test } from './host-fixture.mjs';

test('edit and resend replaces the active suffix, sends revised context once, and survives restart', async ({ page, host }) => {
  test.setTimeout(60000);
  await page.goto(host.url);
  const composer = page.getByRole('textbox', { name: 'Message Pith' });
  await expect(composer).toBeEditable();
  for (const [index, text] of ['Original question', 'Later follow-up'].entries()) {
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => {
      const {state} = await host.command('state');
      return {running: state.running, messageCount: state.messages.length};
    }).toEqual({running: false, messageCount: (index + 1) * 2});
  }
  const before = (await host.command('state')).state;
  expect(before.messages).toHaveLength(4);
  const original = before.messages[0];
  await page.locator(`[data-reading-id="${original.id}"]`).getByRole('button', {name: 'Edit message', exact: true}).click();
  await page.locator('.pui-text-edit textarea').fill('Revised question 中文');
  await page.getByRole('button', { name: 'Send again', exact: true }).click();
  await expect(page.locator('dialog:has(.pui-text-edit)')).not.toBeVisible();
  await expect.poll(async () => {
    const snapshot = await host.command('state');
    return {requests: snapshot.requests, running: snapshot.state.running, messages: snapshot.state.messages.map(message => message.text)};
  }).toEqual({requests: 3, running: false, messages: ['Revised question 中文', 'Fixture answer']});
  const finished = await host.command('state');
  expect(finished.requests).toBe(3);
  expect(finished.state.messages.map(message => message.text)).toEqual(['Revised question 中文', 'Fixture answer']);
  expect(finished.state.messages.map(message => message.id)).not.toContain(original.id);
  const context = JSON.stringify(finished.lastRequest.messages);
  expect(context).toContain('Revised question 中文');
  expect(context).not.toContain('Original question');
  expect(context).not.toContain('Later follow-up');
  expect(context).not.toContain('Fixture answer');
  const savedTimes = finished.state.messages.map(message => message.timestamp);
  expect(savedTimes.every(value => value > 0)).toBe(true);
  await expect(page.locator('.pui-messages time')).toHaveCount(2);
  const restarted = await host.command('restart');
  await page.goto(restarted.url);
  await expect(composer).toBeEditable();
  expect(restarted.state.messages.map(message => message.timestamp)).toEqual(savedTimes);
  await expect(page.locator('.pui-messages')).toContainText('Revised question 中文');
  await expect(page.locator('.pui-messages')).not.toContainText('Original question');
  await page.getByRole('button', {name: 'Actions for ' + (restarted.state.conversations.find(entry => entry.id === before.activeId)?.title || 'Untitled conversation'), exact: true}).click();
  await page.getByRole('menuitem', { name: 'Conversation branches' }).click();
  await expect(page.locator('dialog.pui-feature-modal')).toContainText('Original question');
  await expect(page.locator('dialog.pui-feature-modal')).toContainText('Later follow-up');
});
