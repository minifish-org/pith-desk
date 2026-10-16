import {test,expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test.beforeEach(async ({page})=>{
  await page.addInitScript(installFixture); await page.goto('/');
  await page.waitForFunction(()=>{const fixture=window as any;return fixture.reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('[id$=composer-input]')!.readOnly;});
});

test('a failed MCP write clears the bearer token and retains the environment draft',async ({page})=>{
  await page.locator('[data-action=connections]').click();
  await page.locator('[id$=mcp-name]').fill('local-tools'); await page.locator('[id$=mcp-url]').fill('http://localhost/mcp'); await page.locator('[id$=mcp-token]').fill('one-shot-token'); await page.locator('[id$=mcp-type]').selectOption('stdio');
  await page.locator('[id$=mcp-command]').fill('/usr/bin/tools'); await page.locator('[id$=mcp-env]').fill('{"KEY":"private draft"}');
  await page.evaluate(()=>{(window as any).review.failMutation='/api/mcp/save';});
  await page.getByRole('button',{name:'Save connection',exact:true}).click();
  await expect(page.locator('[id$=mcp-form-error]')).toHaveText('Fixture action rejected');
  await expect(page.locator('[id$=mcp-env]')).toHaveValue('{"KEY":"private draft"}');
  await expect(page.locator('[id$=mcp-token]')).toHaveValue('');
  expect(await page.evaluate(()=>(window as any).review.requests.filter((request:any)=>request.path==='/api/mcp/save').length)).toBe(1);
  // A second, explicit user submission commits once even when its snapshot read fails.
  await page.evaluate(()=>{const fixture=window as any;fixture.review.failMutation='';fixture.review.failState=true;});
  await page.getByRole('button',{name:'Save connection',exact:true}).click();
  await expect(page.locator('[id$=inline-error]')).toContainText('Change saved.');
  await expect(page.locator('[id$=mcp-env]')).toHaveValue('');
  const writes=await page.evaluate(()=>(window as any).review.requests.filter((request:any)=>request.path==='/api/mcp/save'));
  expect(writes).toHaveLength(2); expect(writes[1].body.env).toEqual({KEY:'private draft'});
});

test('OAuth disables and excludes an earlier API key from connection tests and provider saves',async ({page})=>{
  await page.evaluate(()=>{const fixture=window as any;Object.assign(fixture.review.models.providers[0],{oauth:true,apiKeySupported:true,baseUrl:'http://localhost/v1'});});
  await page.locator('[id$=sidebar] [data-action=settings]').click(); await expect(page.locator('[id$=save-settings]')).toBeEnabled();
  await page.locator('input[id$=api-key]').fill('earlier-key-draft');
  await page.evaluate(()=>{const fixture=window as any;fixture.review.models.providers[0].signedIn=true;fixture.reviewState.login={id:'signed-in',provider:'custom-test',phase:'complete',message:'Signed in'};fixture.emitReview();});
  await expect(page.locator('input[id$=api-key]')).toBeDisabled(); await page.locator('[id$=oauth-dialog]').getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('[id$=test-connection]').click(); await expect(page.locator('[id$=connection-test-result]')).toHaveText('Fixture connected');
  expect(await page.evaluate(()=>(window as any).review.requests.find((request:any)=>request.path==='/api/test-provider-connection').body.apiKey)).toBe('');
  await page.locator('[id$=save-settings]').click(); await expect(page.locator('[id$=settings-dialog]')).not.toBeVisible();
  expect(await page.evaluate(()=>(window as any).review.requests.find((request:any)=>request.path==='/api/provider-config').body)).toEqual({provider:'custom-test',baseUrl:'http://localhost/v1'});
});

test('resource creation availability follows its original workspace during loading and later snapshots',async ({page})=>{
  await page.evaluate(()=>{
    const fixture=window as any,original=window.fetch.bind(window);
    window.fetch=async(input,init)=>{if(new URL(String(input),location.href).pathname==='/api/resources')await new Promise<void>(resolve=>{fixture.releaseResources=resolve;});return original(input,init);};
    fixture.reviewState.runs=[{conversationId:'b',workspaceId:'w',phase:'working',needsApproval:false}];fixture.emitReview();
  });
  await page.locator('[data-action=resources]').click();
  const skill=page.locator('[id$=resources-content]').getByRole('button',{name:'Add skill',exact:true}),template=page.getByRole('button',{name:'Add prompt template',exact:true});
  await expect(skill).toBeDisabled(); await expect(template).toBeDisabled();
  await expect(page.locator('[id$=resources-content]').getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  await page.evaluate(()=>{const fixture=window as any;fixture.reviewState.runtime.contextTokens++;fixture.emitReview();fixture.releaseResources();});
  const instructions=page.getByRole('button',{name:'Create AGENTS.md in this workspace',exact:true}); await expect(instructions).toBeDisabled();
  await page.evaluate(()=>{const fixture=window as any;fixture.reviewState.conversations.find((entry:any)=>entry.id==='b').workspaceId='other';fixture.reviewState.activeId='b';fixture.emitReview();});
  await expect(skill).toBeDisabled();
  await page.evaluate(()=>{const fixture=window as any;fixture.reviewState.runs=[{conversationId:'b',workspaceId:'other',phase:'working',needsApproval:false}];fixture.emitReview();});
  await expect(skill).toBeEnabled(); await expect(template).toBeEnabled(); await expect(instructions).toBeEnabled();
  await page.evaluate(()=>{
    const fixture=window as any,original=window.fetch.bind(window);
    window.fetch=async(input,init)=>{if(new URL(String(input),location.href).pathname==='/api/conversations')await new Promise<void>(resolve=>{fixture.releaseCreate=resolve;});return original(input,init);};
    document.querySelector<HTMLButtonElement>('[data-new-workspace="w"]')!.click();
  });
  await expect(skill).toBeDisabled(); await expect(template).toBeDisabled(); await expect(instructions).toBeDisabled();
  await page.evaluate(()=>(window as any).releaseCreate());
  await expect(skill).toBeEnabled();
});

for (const success of [false,true]) test(`an earlier provider ${success ? 'save' : 'failure'} cannot close or clear the next provider draft`,async ({page})=>{
  await page.evaluate(success=>{
    const fixture=window as any,provider=fixture.review.models.providers[0],original=window.fetch.bind(window);
    provider.baseUrl='http://localhost/v1'; fixture.review.models.providers.push({...provider,id:'second',name:'Second provider',baseUrl:'http://localhost/second'});
    window.fetch=async(input,init)=>{if(new URL(String(input),location.href).pathname==='/api/provider-config' && init?.method==='POST') {await new Promise<void>(resolve=>{fixture.releaseProviderSave=resolve;}); if(!success)return Response.json({error:'Earlier provider rejected'},{status:409});}return original(input,init);};
  },success);
  await page.locator('[id$=sidebar] [data-action=settings]').click(); await expect(page.locator('[id$=save-settings]')).toBeEnabled();
  await page.locator('input[id$=api-key]').fill('first-key'); await page.locator('[id$=save-settings]').click(); await expect(page.locator('[id$=save-settings]')).toBeDisabled();
  await page.locator('[id$=settings-provider]').selectOption('second'); await page.locator('input[id$=api-key]').fill('second-key-draft');
  await page.evaluate(()=>(window as any).releaseProviderSave());
  await expect(page.locator('[id$=save-settings]')).toBeEnabled();
  await expect(page.locator('[id$=settings-dialog]')).toBeVisible(); await expect(page.locator('[id$=settings-provider]')).toHaveValue('second');
  await expect(page.locator('input[id$=api-key]')).toHaveValue('second-key-draft'); await expect(page.locator('[id$=settings-error]')).toHaveText('');
});
