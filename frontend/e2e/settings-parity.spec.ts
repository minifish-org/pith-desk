import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test.beforeEach(async ({page}) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => {
    const fixture = window as any;
    return fixture.reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!.readOnly;
  });
});

test('a failed MCP write clears the bearer token and retains the environment draft', async ({page}) => {
  await page.getByRole('button', {name: 'Connections', exact: true}).click();
  const connections = page.getByRole('dialog', {name: 'Connections', exact: true});
  await connections.getByRole('button', {name: 'New connection', exact: true}).click();
  await page.getByLabel('Connection name').fill('local-tools');
  await page.getByLabel('Connection URL').fill('http://localhost/mcp');
  await page.getByLabel('Bearer token').fill('one-shot-token');
  await page.getByRole('combobox', {name: 'Connection type'}).click();
  await page.getByRole('option', {name: 'Local command (stdio)', exact: true}).click();
  await page.getByLabel('Command', {exact: true}).fill('/usr/bin/tools');
  await page.getByLabel('Environment overrides').fill('{"KEY":"private draft"}');
  await page.evaluate(() => {(window as any).review.failMutation = '/api/mcp/save';});
  await page.getByRole('button', {name: 'Save connection', exact: true}).click();
  await expect(connections.getByRole('alert')).toHaveText('Fixture action rejected');
  await expect(page.getByLabel('Environment overrides')).toHaveValue('{"KEY":"private draft"}');
  expect(await page.getByLabel('Bearer token').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).review.requests.filter((request: any) => request.path === '/api/mcp/save').length)).toBe(1);
  // A second, explicit user submission commits once even when its snapshot read fails.
  await page.evaluate(() => {const fixture = window as any; fixture.review.failMutation = ''; fixture.review.failState = true;});
  await page.getByRole('button', {name: 'Save connection', exact: true}).click();
  await expect(page.getByText('Change saved.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Save connection', exact: true})).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).review.requests.filter((request: any) => request.path === '/api/mcp/save'));
  expect(writes).toHaveLength(2);
  expect(writes[1].body.env).toEqual({KEY: 'private draft'});
  expect(writes[1].body.bearerToken).toBeUndefined();
});

test('OAuth hides an earlier API key from connection tests and provider saves', async ({page}) => {
  await page.evaluate(() => {
    const fixture = window as any;
    Object.assign(fixture.review.models.providers[0], {oauth: true, apiKeySupported: true, baseUrl: 'http://localhost/v1'});
  });
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
  await settings.getByLabel('API key').fill('earlier-key-draft');
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.review.models.providers[0].signedIn = true;
    fixture.reviewState.login = {id: 'signed-in', provider: 'custom-test', phase: 'complete', message: 'Signed in'};
    fixture.emitReview();
  });
  await expect(settings.getByLabel('API key')).toHaveCount(0);
  await settings.getByRole('button', {name: 'Test connection', exact: true}).click();
  await expect(settings.getByRole('status')).toHaveText('Fixture connected');
  expect(await page.evaluate(() => (window as any).review.requests.find((request: any) => request.path === '/api/test-provider-connection').body.apiKey)).toBeUndefined();
  await settings.getByRole('button', {name: 'Save settings', exact: true}).click();
  await expect(settings).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).review.requests.find((request: any) => request.path === '/api/provider-config').body)).toEqual({provider: 'custom-test', baseUrl: 'http://localhost/v1'});
});

test('resource creation availability follows its original workspace during loading and later snapshots', async ({page}) => {
  await page.evaluate(() => {
    const fixture = window as any, original = window.fetch.bind(window);
    window.fetch = async (input: any, init: any) => {
      if (new URL(String(input), location.href).pathname === '/api/resources') await new Promise<void>(resolve => {fixture.releaseResources = resolve;});
      return original(input, init);
    };
    fixture.reviewState.runs = [{conversationId: 'b', workspaceId: 'w', phase: 'working', needsApproval: false}];
    fixture.emitReview();
  });
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  const resources = page.getByRole('dialog', {name: 'Workspace resources', exact: true});
  const skill = resources.getByRole('button', {name: 'Add skill', exact: true});
  const template = resources.getByRole('button', {name: 'Add template', exact: true});
  const instructions = resources.getByRole('button', {name: 'Create AGENTS.md in this workspace', exact: true});
  await expect(skill).toBeDisabled();
  await expect(template).toBeDisabled();
  await expect(resources.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
  await page.evaluate(() => {const fixture = window as any; fixture.reviewState.runtime.contextTokens++; fixture.emitReview(); fixture.releaseResources();});
  await expect(instructions).toBeDisabled();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.reviewState.conversations.find((entry: any) => entry.id === 'b').workspaceId = 'other';
    fixture.reviewState.activeId = 'b';
    fixture.emitReview();
  });
  await expect(skill).toBeDisabled();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.reviewState.runs = [{conversationId: 'b', workspaceId: 'other', phase: 'working', needsApproval: false}];
    fixture.emitReview();
  });
  await expect(skill).toBeEnabled();
  await expect(template).toBeEnabled();
  await expect(instructions).toBeEnabled();
  await page.evaluate(() => {
    const fixture = window as any, original = window.fetch.bind(window);
    window.fetch = async (input: any, init: any) => {
      if (new URL(String(input), location.href).pathname === '/api/conversations') await new Promise<void>(resolve => {fixture.releaseCreate = resolve;});
      return original(input, init);
    };
    document.querySelector<HTMLButtonElement>('[aria-label="New conversation in Review workspace"]')!.click();
  });
  await expect(skill).toBeDisabled();
  await expect(template).toBeDisabled();
  await expect(instructions).toBeDisabled();
  await page.evaluate(() => (window as any).releaseCreate());
  await expect(skill).toBeEnabled();
});

for (const success of [false, true]) test(`an earlier provider ${success ? 'save' : 'failure'} cannot close or clear the next provider draft`, async ({page}) => {
  await page.evaluate(success => {
    const fixture = window as any, provider = fixture.review.models.providers[0], original = window.fetch.bind(window);
    provider.baseUrl = 'http://localhost/v1';
    fixture.review.models.providers.push({...provider, id: 'second', name: 'Second provider', baseUrl: 'http://localhost/second'});
    window.fetch = async (input: any, init: any) => {
      if (new URL(String(input), location.href).pathname === '/api/provider-config' && init?.method === 'POST') {
        await new Promise<void>(resolve => {fixture.releaseProviderSave = resolve;});
        if (!success) return Response.json({error: 'Earlier provider rejected'}, {status: 409});
      }
      return original(input, init);
    };
  }, success);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
  await settings.getByLabel('API key').fill('first-key');
  await settings.getByRole('button', {name: 'Save settings', exact: true}).click();
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeDisabled();
  await settings.getByRole('combobox', {name: 'Provider'}).click();
  await page.getByRole('option', {name: /Second provider/}).click();
  await settings.getByLabel('API key').fill('second-key-draft');
  await page.evaluate(() => (window as any).releaseProviderSave());
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('combobox', {name: 'Provider'})).toContainText('Second provider');
  await expect(settings.getByLabel('API key')).toHaveValue('second-key-draft');
  await expect(settings.getByRole('alert')).toHaveCount(0);
});
