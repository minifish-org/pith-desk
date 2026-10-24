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
  await page.getByRole('combobox', {name: 'Connection type'}).click();
  await page.getByRole('option', {name: 'HTTP', exact: true}).click();
  await page.evaluate(() => {(window as any).review.failMutation = '/api/mcp/save';});
  await page.getByRole('button', {name: 'Save connection', exact: true}).click();
  await expect(connections.getByRole('alert')).toHaveText('Fixture action rejected');
  await expect(page.getByLabel('Bearer token')).toHaveValue('');
  const rejected = await page.evaluate(() => (window as any).review.requests.filter((request: any) => request.path === '/api/mcp/save'));
  expect(rejected).toHaveLength(1);
  expect(rejected[0].body).toMatchObject({type: 'http', bearerToken: 'one-shot-token'});
  await page.getByRole('combobox', {name: 'Connection type'}).click();
  await page.getByRole('option', {name: 'Local command (stdio)', exact: true}).click();
  await expect(page.getByLabel('Environment overrides')).toHaveValue('{"KEY":"private draft"}');
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
  await expect(settings).toBeVisible();
  await expect(settings.getByText('Provider saved.', {exact: true})).toBeVisible();
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
        fixture.providerSaveTarget = JSON.parse(init.body);
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
  expect(await page.evaluate(() => (window as any).providerSaveTarget)).toEqual({provider: 'custom-test', baseUrl: 'http://localhost/v1', apiKey: 'first-key'});
  expect(await page.evaluate(() => (window as any).reviewState.settings.provider)).toBe('custom-test');
});

for (const change of ['provider', 'key', 'endpoint', 'close']) test(`a connection test is retired when its ${change} changes`, async ({page}) => {
  await page.evaluate(() => {
    const fixture = window as any, original = window.fetch.bind(window);
    fixture.review.models.providers.push({...fixture.review.models.providers[0], id: 'second', name: 'Second provider', baseUrl: 'http://localhost/second'});
    let firstProbe = true;
    window.fetch = async (input: any, init: any) => {
      if (new URL(String(input), location.href).pathname === '/api/test-provider-connection' && firstProbe) {
        firstProbe = false;
        fixture.probeTarget = JSON.parse(init.body);
        init.signal.addEventListener('abort', () => {fixture.probeAborted = true;});
        // A late transport can still complete after cancellation.
        await new Promise<void>(resolve => {fixture.releaseOldProbe = resolve;});
        return Response.json({ok: false, message: 'Earlier connection failed'});
      }
      return original(input, init);
    };
  });
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await settings.getByLabel('API key', {exact: true}).fill('first-key');
  await settings.getByRole('button', {name: 'Test connection', exact: true}).click();
  await expect(settings.getByRole('button', {name: 'Cancel test', exact: true})).toBeVisible();
  if (change === 'provider') {
    await settings.getByRole('combobox', {name: 'Provider'}).click();
    await page.getByRole('option', {name: /Second provider/}).click();
  } else if (change === 'key') {
    await settings.getByLabel('API key', {exact: true}).fill('new-key-draft');
  } else if (change === 'endpoint') {
    await settings.getByText('Advanced connection settings', {exact: true}).click();
    await settings.getByLabel('API base URL', {exact: true}).fill('http://localhost/new-endpoint');
  } else {
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
  }
  await expect.poll(() => page.evaluate(() => (window as any).probeAborted)).toBe(true);
  await expect(settings.getByRole('status')).toHaveCount(0);
  await settings.getByRole('button', {name: 'Test connection', exact: true}).click();
  await expect(settings.getByRole('status')).toHaveText('Fixture connected');
  await page.evaluate(() => (window as any).releaseOldProbe());
  await expect(settings.getByRole('status')).toHaveText('Fixture connected');
  expect(await page.evaluate(() => (window as any).probeTarget.provider)).toBe('custom-test');
  if (change === 'key') await expect(settings.getByLabel('API key', {exact: true})).toHaveValue('new-key-draft');
  if (change === 'endpoint') await expect(settings.getByLabel('API base URL', {exact: true})).toHaveValue('http://localhost/new-endpoint');
});

test('custom model connection editor returns to Settings', async ({page}) => {
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await expect(settings).toBeVisible();

  await settings.getByRole('button', {name: 'Add independent model connection', exact: true}).click();
  const add = page.getByRole('dialog', {name: 'Add independent model connection', exact: true});
  await expect(add).toBeVisible();
  expect(await page.locator('[data-slot="dialog-content"]').count()).toBe(2);
  await add.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(add).toHaveCount(0);
  await expect(settings).toBeVisible();

  await settings.getByRole('button', {name: 'Add independent model connection', exact: true}).click();
  await add.getByLabel('Connection name').fill('Local fixture');
  await add.getByLabel('API base URL').fill('http://localhost:8080/v1');
  await add.getByLabel('Model 1 ID').fill('fixture-model');
  await add.getByRole('button', {name: 'Save connection', exact: true}).click();
  await expect(add).toHaveCount(0);
  await expect(settings).toBeVisible();

  await settings.getByRole('button', {name: 'Edit connection', exact: true}).click();
  const edit = page.getByRole('dialog', {name: 'Edit model connection', exact: true});
  await expect(edit).toBeVisible();
  await edit.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(edit).toHaveCount(0);
  await expect(settings).toBeVisible();
});
test('removing a saved API key keeps Settings open', async ({page}) => {
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await expect(settings.getByRole('button', {name: 'Remove saved key', exact: true})).toBeVisible();
  await settings.getByRole('button', {name: 'Remove saved key', exact: true}).click();
  await expect(settings).toBeVisible();
  await expect(settings.getByText('API key removed.', {exact: true})).toBeVisible();
});

test('an existing resource stays read-only after a failed read and can retry without writing', async ({page}) => {
  await page.evaluate(() => {
    const fixture = window as any, original = window.fetch.bind(window);
    fixture.review.resources = {instructions: [{name: 'AGENTS.md', path: '/tmp/pith-review/AGENTS.md'}], skills: [], templates: [], diagnostics: []};
    fixture.resourceReads = 0;
    window.fetch = async (input: any, init: any) => {
      if (new URL(String(input), location.href).pathname === '/api/resource-content') {
        fixture.resourceReads++;
        if (fixture.resourceReads === 1) return Response.json({error: 'Temporary resource read failure'}, {status: 503});
        await new Promise<void>(resolve => {fixture.releaseResourceRead = resolve;});
      }
      return original(input, init);
    };
  });
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.getByRole('dialog', {name: 'Workspace resources', exact: true}).getByRole('button', {name: 'Edit', exact: true}).click();
  const editor = page.getByRole('dialog', {name: 'Edit resource', exact: true});
  await expect(editor.getByRole('alert')).toHaveText('Temporary resource read failure');
  await expect(editor.getByRole('button', {name: 'Save resource', exact: true})).toBeDisabled();
  await expect(editor.getByLabel('Markdown', {exact: true})).not.toBeEditable();
  await editor.getByRole('button', {name: 'Retry loading', exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).resourceReads)).toBe(2);
  await expect(editor.getByRole('button', {name: 'Save resource', exact: true})).toBeDisabled();
  expect(await page.evaluate(() => (window as any).review.requests.filter((entry: any) => entry.path === '/api/resource'))).toHaveLength(0);
  await page.evaluate(() => (window as any).releaseResourceRead());
  await expect(editor.getByLabel('Markdown', {exact: true})).toHaveValue('# Saved instructions');
  await editor.getByLabel('Markdown', {exact: true}).fill('# Revised saved instructions');
  await editor.getByRole('button', {name: 'Save resource', exact: true}).click();
  await expect(editor).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).review.requests.filter((entry: any) => entry.path === '/api/resource'));
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({workspaceId: 'w', path: '/tmp/pith-review/AGENTS.md', content: '# Revised saved instructions', remove: false});
});

for (const success of [false, true]) test(`an earlier key-removal ${success ? 'success' : 'failure'} preserves the next provider draft`, async ({page}) => {
  await page.evaluate(success => {
    const fixture = window as any, original = window.fetch.bind(window);
    fixture.review.models.providers.push({...fixture.review.models.providers[0], id: 'second', name: 'Second provider', baseUrl: 'http://localhost/second'});
    window.fetch = async (input: any, init: any) => {
      if (new URL(String(input), location.href).pathname === '/api/provider-config' && JSON.parse(init?.body || '{}').clearApiKey) {
        fixture.keyRemovalTarget = JSON.parse(init.body);
        await new Promise<void>(resolve => {fixture.releaseKeyRemoval = resolve;});
        if (!success) return Response.json({error: 'Earlier key removal rejected'}, {status: 503});
      }
      return original(input, init);
    };
  }, success);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await settings.getByRole('button', {name: 'Remove saved key', exact: true}).click();
  await settings.getByRole('combobox', {name: 'Provider'}).click();
  await page.getByRole('option', {name: /Second provider/}).click();
  await settings.getByLabel('API key', {exact: true}).fill('second-key-draft');
  await page.evaluate(() => (window as any).releaseKeyRemoval());
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
  await expect(settings.getByLabel('API key', {exact: true})).toHaveValue('second-key-draft');
  await expect(settings.getByText('API key removed.', {exact: true})).toHaveCount(0);
  await expect(settings.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).keyRemovalTarget)).toEqual({provider: 'custom-test', baseUrl: '', clearApiKey: true});
  expect(await page.evaluate(() => (window as any).reviewState.settings.provider)).toBe('custom-test');
});
