import {test,expect,type Page} from '@playwright/test';
import type {Application} from '../src/ui-contract.ts';

interface DeskHarness {app: Application;events: boolean[];calls: string[];old?: {isOpen(): boolean;close(): void;destroy(): void};nested?: {isOpen(): boolean;close(): void;destroy(): void}}
declare global {interface Window {deskPartsHarness: DeskHarness}}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

async function openFixture(page: Page): Promise<void> {
  await page.route('**/assembly-test.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto('/assembly-test.html');await page.evaluate(async()=>{const styles='/node_modules/pith-ui/dist/styles.css';await import(styles);});
}

async function setup(page: Page,appearance: 'light'|'dark' = 'light'): Promise<void> {
  await openFixture(page);
  await page.emulateMedia({colorScheme: appearance === 'dark' ? 'light' : 'dark'});
  await page.evaluate(async ({appearance}) => {
    // The fixture's preview scope would shadow the old application's HTML
    // appearance owner; Desk itself has one application theme owner.
    document.body.classList.remove('pui');
    const mount = document.body.appendChild(document.createElement('div')),events: boolean[] = [],calls: string[] = [];
    const options = {appearance,brand: {name: 'Pith',qualifier: 'Desk',mark: {symbol: 'pith',alt: ''}},onUIStateChange(state: {hasModal: boolean}) {events.push(state.hasModal);},workspace: {onBusyAction(key: string) {calls.push(key);},onMessageAction(target: {action: string}) {calls.push(target.action);},onCopyCode() {calls.push('code');}}};
    const path = '/src/ui-application.ts',module = await import(path);
    const app = module.mountDesk(mount,options);
    window.deskPartsHarness = {app,events,calls};
  },{appearance});
}

for (const appearance of ['light','dark'] as const) test(`${appearance} desk wiring preserves busy/current target and inline error visibility`,async ({page}) => {
  await setup(page,appearance);await page.evaluate(() => window.deskPartsHarness.app.workspace.updateShell({busy: {key: 'running',message: 'A task is running 中文',actionLabel: 'Open running conversation'},error: {message: 'Visible error 中文'}}));
  await page.getByRole('button',{name: 'Open running conversation',exact: true}).click();expect(await page.evaluate(() => window.deskPartsHarness.calls)).toEqual(['running']);
  await page.evaluate(() => window.deskPartsHarness.app.workspace.updateShell({busy: {key: 'next',message: 'Next task',actionLabel: 'Open next'},error: {message: 'Suppressed duplicate',hidden: true}}));await page.getByRole('button',{name: 'Open next',exact: true}).click();expect(await page.evaluate(() => window.deskPartsHarness.calls)).toEqual(['running','next']);
  await expect(page.locator('.pui-inline-error')).toBeHidden();await page.evaluate(() => window.deskPartsHarness.app.workspace.updateShell({busy: null,error: {message: ''}}));await expect(page.locator('.pui-workspace-busy')).toBeHidden();await expect(page.locator('.pui-workspace-busy > button')).toHaveText('Open next');
});

for (const kind of ['fixed','feature'] as const) test(`nested ${kind} openings win over the superseded outer replacement in the assembled tree`,async ({page}) => {

    await setup(page);const result = await page.evaluate(kind => {
      const {app} = window.deskPartsHarness,events: string[] = [];
      const open = (label: string,onClose: () => void) => kind === 'fixed' ? app.settings.openSettings({baseUrl: `https://${label}.example/v1`,hasApiKey: true},{onClose}) : app.workspace.openHistory({nodes: [{id: label,role: 'assistant',text: `${label} branch`,active: true}]},{onClose});
      let nested: ReturnType<typeof open>|undefined;
      const previous = open('old',() => {events.push('old');nested = open('nested',() => events.push('nested'));});
      const outer = open('outer',() => events.push('outer'));previous.fail('Stale error');previous.close();previous.destroy();
      const before = {oldOpen: previous.isOpen(),outerOpen: outer.isOpen(),nestedOpen: nested!.isOpen(),events: [...events],openDialogs: document.querySelectorAll('dialog[open]').length,
        current: kind === 'fixed' ? (nested as ReturnType<typeof app.settings.openSettings>).read().baseUrl : document.querySelector('.pui-branch-node p')?.textContent,staleError: document.body.textContent!.includes('Stale error')};
      nested!.close();nested!.destroy();app.destroy();return {before,after: {events,openDialogs: document.querySelectorAll('dialog[open]').length}};
    },kind);
    expect(result).toEqual({before: {oldOpen: false,outerOpen: false,nestedOpen: true,events: ['old','outer'],openDialogs: 1,current: kind === 'fixed' ? 'https://nested.example/v1' : 'nested branch',staleError: false},after: {events: ['old','outer','nested'],openDialogs: 0}});
});

test('native dismissal retires the old feature before its close callback opens a replacement',async ({page}) => {

    await setup(page);await page.evaluate(() => {
      const h = window.deskPartsHarness;h.old = h.app.workspace.openHistory({nodes: []},{onClose() {h.calls.push('closed');h.nested = h.app.workspace.openHistory({nodes: [{id: 'nested',role: 'assistant',text: 'After dismissal',active: true}]});}});
    });await page.keyboard.press('Escape');await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(page.locator('.pui-branch-node p')).toHaveText('After dismissal');
    expect(await page.evaluate(() => ({nested: window.deskPartsHarness.nested!.isOpen(),calls: window.deskPartsHarness.calls}))).toEqual({nested: true,calls: ['closed']});
});

test('the feature loading slot is replaced across resources/history/custom while OAuth retains its own opening',async ({page}) => {

    await setup(page);const value = await page.evaluate(() => {
      const {app} = window.deskPartsHarness;
      const loading = app.resources.openEditorLoading({kind: 'skill'}),oauth = app.settings.openProviderLogin({phase: 'waiting',message: 'Waiting for sign-in'});
      const history = app.workspace.openHistory({nodes: []}),custom = app.settings.openConnectionLoading({editing: false});loading.fail('Retired loading');history.fail('Retired history');
      return {loading: loading.isOpen(),history: history.isOpen(),custom: custom.isOpen(),oauth: oauth.isOpen(),dialogs: document.querySelectorAll('dialog[open]').length,stale: document.body.textContent!.includes('Retired')};
    });expect(value).toEqual({loading: false,history: false,custom: true,oauth: true,dialogs: 2,stale: false});
});

test('image modal state participates in the same frame and conversation changes close the viewer',async ({page}) => {

    await setup(page);await page.evaluate(png => {const {app} = window.deskPartsHarness;app.workspace.updateConversation({id: 'a',messages: [],working: false});app.files.openPreview({owner: {kind: 'artifact',id: 'a'},name: 'Diagram',path: '/diagram.png',capabilities: {},content: {kind: 'image',imageSrc: png,imageAlt: 'Diagram'}});},png);
    await page.locator('.pui-file-preview-body img').click();await expect(page.locator('.pui-image-viewer[open]')).toHaveCount(1);expect(await page.evaluate(() => window.deskPartsHarness.app.read().hasModal)).toBe(true);
    await page.evaluate(() => window.deskPartsHarness.app.workspace.updateConversation({id: 'b',messages: [],working: false}));await expect(page.locator('.pui-image-viewer[open]')).toHaveCount(0);
    await page.keyboard.press('Escape');await expect.poll(() => page.evaluate(() => window.deskPartsHarness.app.read().hasModal)).toBe(false);expect(await page.evaluate(() => window.deskPartsHarness.events)).toContain(true);
});

test('root teardown wins over close callback reopening and exceptions without retaining owned dialogs',async ({page}) => {

    await setup(page);const value = await page.evaluate(() => {
      const {app} = window.deskPartsHarness;let reopened: ReturnType<typeof app.workspace.openHistory>|undefined;
      app.workspace.openHistory({nodes: []},{onClose() {reopened = app.workspace.openHistory({nodes: []});throw new Error('Cleanup failed');}});
      app.settings.openSettings({baseUrl: '',hasApiKey: false},{onClose() {throw new Error('Settings cleanup failed');}});app.destroy();app.destroy();
      return {open: app.read().hasModal,reopened: reopened?.isOpen(),dialogs: document.querySelectorAll('dialog[open]').length,frames: document.querySelectorAll('.pui-app').length};
    });expect(value).toEqual({open: false,reopened: false,dialogs: 0,frames: 0});
});

test('opening the assembled file preview retains its related artifact inspector through focus and native dismissal',async ({page}) => {

    await setup(page);await page.evaluate(() => {
      const {app} = window.deskPartsHarness;
      app.files.updateArtifacts({ownerId: 'active',files: [{name: 'Report.md',path: '/workspace/Report.md'}],loading: false,error: '',copyMode: 'path'},{onPreview(target) {app.files.openPreview({...target,capabilities: {open: true},content: {kind: 'text',text: 'A retained preview'}},{onFileAction() {}});},onFileAction() {}});
    });await page.getByRole('button',{name: /^Conversation files/}).click();await page.getByRole('button',{name: 'Preview',exact: true}).click();
    await expect(page.locator('dialog[open]')).toHaveCount(1);await expect.poll(() => page.evaluate(() => window.deskPartsHarness.app.files.areArtifactsOpen())).toBe(true);
    await page.locator('dialog[open]').getByRole('button',{name: 'Open',exact: true}).click();expect(await page.evaluate(() => window.deskPartsHarness.app.files.areArtifactsOpen())).toBe(true);
    await page.keyboard.press('Escape');await expect(page.locator('dialog[open]')).toHaveCount(0);expect(await page.evaluate(() => window.deskPartsHarness.app.files.areArtifactsOpen())).toBe(true);
});

test('assembled scoped availability preserves unrelated navigation and allowed historical copies',async ({page}) => {

    await setup(page);await page.evaluate(() => {
      const {app,calls} = window.deskPartsHarness;
      app.workspace.updateNavigation({groups: [{id: 'running-work',name: 'Running work',path: '/running',selected: true,children: [{id: 'running',title: 'Running chat',active: true}]},{id: 'idle-work',name: 'Idle work',path: '/idle',selected: true,children: [{id: 'idle',title: 'Idle chat',active: false}]}],empty: null});
      app.workspace.updateConversation({id: 'running',working: true,messages: [{id: 'message',role: 'assistant',text: 'Saved response\n\n```ts\nconst ready = true;\n```',actions: {copy: 'Copy response'}}]});
      app.workspace.updateMessageAvailability({copy: false,edit: true,branch: true});
      app.workspace.updateAvailability({global: true,active: true,conversations: ['running'],workspaces: ['running-work']});
      calls.push('projected');
    });await expect(page.getByRole('button',{name: 'Choose model',exact: true})).toBeDisabled();
    await page.getByRole('button',{name: 'Actions for Idle chat',exact: true}).click();await expect(page.getByRole('menuitem',{name: 'Rename',exact: true})).toBeEnabled();await page.keyboard.press('Escape');
    await page.getByRole('button',{name: 'Actions for Running chat',exact: true}).click();await expect(page.getByRole('menuitem',{name: 'Rename',exact: true})).toBeDisabled();await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name: 'Copy response',exact: true})).toBeEnabled();await expect(page.getByRole('button',{name: 'Copy code',exact: true})).toBeEnabled();
    // Source-backed baseline: copy's isDisabled option controls pending and
    // restoration; it does not gate the supplied action. Keep that behavior.
    await page.evaluate(() => window.deskPartsHarness.app.workspace.updateAvailability({busy: true}));await page.getByRole('button',{name: 'Copy response',exact: true}).click();await page.getByRole('button',{name: 'Copy code',exact: true}).click();expect(await page.evaluate(() => window.deskPartsHarness.calls)).toEqual(['projected','copy','code']);
});


test('task recovery retains the old selected workspace availability and active fallback in the complete assembly',async ({page}) => {
  const expected = [
    {name: 'selected workspace idle',continue: false,diagnostics: false},
    {name: 'another workspace running',continue: false,diagnostics: false},
    {name: 'selected workspace running',continue: true,diagnostics: false},
    {name: 'selected workspace clears',continue: false,diagnostics: false},
    {name: 'global idle does not gate workspace recovery',continue: false,diagnostics: false},
    {name: 'host busy gates workspace recovery',continue: true,diagnostics: false},
    {name: 'missing workspace uses active idle scope',continue: true,diagnostics: false},
    {name: 'missing workspace ignores unrelated workspace runs',continue: false,diagnostics: false},
    {name: 'new selected workspace uses its own availability',continue: true,diagnostics: false},
  ];

    await setup(page);
    const value = await page.evaluate(() => {
      const {app} = window.deskPartsHarness;
      const cases = [
        {name: 'selected workspace idle',workspaceId: 'selected',availability: {}},
        {name: 'another workspace running',workspaceId: 'selected',availability: {workspaces: ['other'],active: true}},
        {name: 'selected workspace running',workspaceId: 'selected',availability: {workspaces: ['selected']}},
        {name: 'selected workspace clears',workspaceId: 'selected',availability: {workspaces: []}},
        {name: 'global idle does not gate workspace recovery',workspaceId: 'selected',availability: {global: true,active: true}},
        {name: 'host busy gates workspace recovery',workspaceId: 'selected',availability: {busy: true}},
        {name: 'missing workspace uses active idle scope',availability: {active: true}},
        {name: 'missing workspace ignores unrelated workspace runs',availability: {workspaces: ['selected']}},
        {name: 'new selected workspace uses its own availability',workspaceId: 'other',availability: {workspaces: ['other']}},
      ];
      const rows = cases.map(entry => {
        app.workspace.updateFailure({visible: true,message: 'Task interrupted',advice: 'Review and continue.',canContinue: true,workspaceId: entry.workspaceId});
        app.workspace.updateAvailability(entry.availability);
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pui-task-failure button')];
        return {name: entry.name,continue: buttons.find(button => button.textContent === 'Review and continue')!.disabled,diagnostics: buttons.find(button => button.textContent === 'Save diagnostics')!.disabled};
      });
      app.workspace.updateFailure({visible: true,message: 'Task interrupted',advice: 'Check the model.',canContinue: false,workspaceId: 'selected'});
      app.workspace.updateAvailability({busy: true,global: true,active: true,workspaces: ['selected']});
      const settings = [...document.querySelectorAll<HTMLButtonElement>('.pui-task-failure button')].map(button => ({label: button.textContent,disabled: button.disabled}));
      app.destroy();return {rows,settings};
    });
    expect(value).toEqual({rows: expected,settings: [{label: 'Check model settings',disabled: false},{label: 'Save diagnostics',disabled: false}]});
});

test('an open resource editor keeps the old workspace-scoped Save availability without changing Delete or the draft',async ({page}) => {
  const expected = [
    {name: 'resource workspace idle',saveDisabled: false},
    {name: 'another workspace running',saveDisabled: false},
    {name: 'resource workspace running',saveDisabled: true},
    {name: 'resource workspace clears',saveDisabled: false},
    {name: 'global and active scopes do not gate resource Save',saveDisabled: false},
    {name: 'host busy gates resource Save',saveDisabled: true},
    {name: 'host busy clears',saveDisabled: false},
  ];

    await setup(page);
    const value = await page.evaluate(() => {
      const {app} = window.deskPartsHarness;
      const editor = app.resources.openEditor({workspaceId: 'resource-workspace',workspacePath: '/resource-workspace',
        path: '/resource-workspace/AGENTS.md',kind: 'instructions',name: 'AGENTS.md',content: 'Original Markdown',editable: true,workspaceBusy: false});
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!,save = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!,
        remove = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete resource')!,
        cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!,body = dialog.querySelector('textarea')!;
      body.value = 'Unsaved Markdown 中文';body.focus();body.setSelectionRange(2,9);
      const presentation = (node: HTMLElement) => {const style = getComputedStyle(node),box = node.getBoundingClientRect();return {
        box: [box.x,box.y,box.width,box.height],styles: ['color','background-color','font-size','line-height','padding-top','padding-bottom','border-top-width'].map(property => style.getPropertyValue(property)),
      };};
      const before = {remove: presentation(remove),body: presentation(body)};
      const cases = [
        {name: 'resource workspace idle',availability: {}},
        {name: 'another workspace running',availability: {workspaces: ['other-workspace'],active: true}},
        {name: 'resource workspace running',availability: {workspaces: ['resource-workspace']}},
        {name: 'resource workspace clears',availability: {workspaces: []}},
        {name: 'global and active scopes do not gate resource Save',availability: {global: true,active: true,conversations: ['active']}},
        {name: 'host busy gates resource Save',availability: {busy: true}},
        {name: 'host busy clears',availability: {busy: false}},
      ];
      const rows = cases.map(entry => {
        app.workspace.updateAvailability(entry.availability);
        return {name: entry.name,saveDisabled: save.disabled,deleteDisabled: remove.disabled,cancelDisabled: cancel.disabled,
          readOnly: body.readOnly,bodyDisabled: body.disabled,draft: editor.read().content,selection: [body.selectionStart,body.selectionEnd],
          retained: save === dialog.querySelector('button[type="submit"]') && remove.isConnected && body === dialog.querySelector('textarea'),
          presentation: {remove: presentation(remove),body: presentation(body)}};
      });
      app.destroy();return {before,rows};
    });
    expect(value.rows).toEqual(expected.map(entry => ({...entry,deleteDisabled: false,cancelDisabled: false,readOnly: false,bodyDisabled: false,
      draft: 'Unsaved Markdown 中文',selection: [2,9],retained: true,presentation: value.before})));
});

test('an editor without a workspace ID retains the old active-scope Save fallback',async ({page}) => {

    await setup(page);
    const rows = await page.evaluate(() => {
      const {app} = window.deskPartsHarness;
      app.resources.openEditor({workspaceId: '',workspacePath: '/resource-workspace',path: '/resource-workspace/AGENTS.md',
        kind: 'instructions',content: 'Retained draft',editable: true,workspaceBusy: false});
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!,save = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!,
        remove = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete resource')!,body = dialog.querySelector('textarea')!;
      const cases = [
        {name: 'idle fallback',availability: {}},
        {name: 'active scope running',availability: {active: true}},
        {name: 'workspace and global scopes do not gate active fallback',availability: {active: false,global: true,workspaces: ['resource-workspace']}},
        {name: 'host busy gates active fallback',availability: {busy: true}},
        {name: 'active fallback clears',availability: {active: false,busy: false}},
      ];
      const result = cases.map(entry => {app.workspace.updateAvailability(entry.availability);return {name: entry.name,saveDisabled: save.disabled,
        deleteDisabled: remove.disabled,readOnly: body.readOnly,value: body.value};});
      app.destroy();return result;
    });
    expect(rows).toEqual([
      {name: 'idle fallback',saveDisabled: false},
      {name: 'active scope running',saveDisabled: true},
      {name: 'workspace and global scopes do not gate active fallback',saveDisabled: false},
      {name: 'host busy gates active fallback',saveDisabled: true},
      {name: 'active fallback clears',saveDisabled: false},
    ].map(entry => ({...entry,deleteDisabled: false,readOnly: false,value: 'Retained draft'})));
});

test('local file links keep conversation scope and copy feedback keeps the old host-busy restoration policy',async ({page}) => {

    await openFixture(page);
    const value = await page.evaluate(async () => {
      document.body.classList.remove('pui');
      const path = '/src/ui-application.ts',module = await import(path),calls: string[] = [];
      const options = {workspace: {
        resolveLocalLink(href: string,conversationId: string) {return {path: href,conversationId};},
        onLocalFile(target: {path: string;conversationId: string}) {calls.push(`file:${target.conversationId}:${target.path}`);},
        onCopyCode() {calls.push('code');return {ok: false,error: 'Clipboard unavailable'};},
        onError(message: string) {calls.push(message);},
      }};
      const mount = document.body.appendChild(document.createElement('div')),app = module.mountDesk(mount,options);
      app.workspace.updateConversation({id: 'chat',working: true,messages: [{id: 'response',role: 'assistant',text: '[Result](result.txt)\n\n```ts\nconst ready = true;\n```'}]});
      const link = mount.querySelector<HTMLAnchorElement>('a[data-download-path]')!,code = mount.querySelector<HTMLButtonElement>('[data-copy-code]')!;
      const sample = () => ({link: link.getAttribute('aria-disabled'),codeDisabled: code.disabled});
      app.workspace.updateAvailability({});const idle = sample();link.click();
      app.workspace.updateAvailability({global: true,active: true,conversations: ['chat']});const conversation = sample();
      app.workspace.updateAvailability({global: true,active: true,conversations: ['other']});const unrelated = sample();
      app.workspace.updateAvailability({busy: true});const busy = sample();
      // Existing source-backed behavior: busy affects copy feedback/restoration,
      // while the first copy activation still executes its callback.
      code.click();await new Promise(resolve => setTimeout(resolve,0));const restoredDisabled = code.disabled;
      app.workspace.updateAvailability({});const clearedLink = link.getAttribute('aria-disabled');
      const retained = link === mount.querySelector('a[data-download-path]') && code === mount.querySelector('[data-copy-code]');
      app.destroy();return {idle,conversation,unrelated,busy,restoredDisabled,clearedLink,retained,calls};
    });
    expect(value).toEqual({idle: {link: 'false',codeDisabled: false},conversation: {link: 'true',codeDisabled: false},unrelated: {link: 'false',codeDisabled: false},
      busy: {link: 'true',codeDisabled: false},restoredDisabled: true,clearedLink: 'false',retained: true,calls: ['file:chat:result.txt','code','Clipboard unavailable']});
});
