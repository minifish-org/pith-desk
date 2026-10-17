/** Internal compiled MCP recipe. Protocols, JSON validation and writes stay in the application. */
import {
  createButtonPart,createCardHeadingPart,createCardPart,createCheckboxPart,createCompactActionsPart,
  createDialogPart,createDisclosurePart,createFeedbackPart,createFieldLabelPart,createFooterPart,
  createFormPart,createInputPart,createLabelledFieldPart,createSecretLabelPart,createSectionHeadingPart,
  createSelectPart,createSeparatedSectionPart,createStackPart,createStatusPart,createTextareaPart,
  createTextPart,createToolbarPart,mountParts,
  type ButtonPart,type CardPart,type DialogPart,type FormPart,type MountPartsOptions,type Part,
} from 'pith-ui';

export type Result = {ok: true} | {ok: false;error: string};
type HostResult = void | Result | Promise<void | Result>;
export interface MCPState {error?: string;formError?: string;disabled?: boolean}
export interface MCPEditor {name: string;type: string;url?: string;oauth?: boolean;oauthClientId?: string;oauthScope?: string;command?: string;args?: readonly string[];enabled?: boolean;hasBearerToken?: boolean;envKeys?: readonly string[]}
export interface MCPDraft {name: string;type: 'http' | 'stdio';url: string;oauth: boolean;oauthClientId: string;oauthScope: string;command: string;args: string;enabled: boolean;bearerToken: string;clearBearerToken: boolean;env: string;clearEnv: boolean}
export interface MCPConnection extends MCPEditor {enabled: boolean;status?: string;statusLabel: string;error?: string;signedIn?: boolean}
export type MCPAction = 'mcp-login' | 'mcp-logout' | 'mcp-edit' | 'mcp-toggle' | 'mcp-remove';
export interface MCPCallbacks {
  onSubmit?(draft: MCPDraft): Result | Promise<Result>;
  onConnectionAction?(action: MCPAction,target: Readonly<{name: string}>): HostResult;
  onRefresh?(): HostResult;onNew?(): HostResult;onClose?(): void;
}
export interface MCPAssembly {
  read(): MCPDraft;update(state: Readonly<MCPState>): void;edit(value?: Readonly<MCPEditor>): void;
  setConnections(entries: readonly MCPConnection[]): void;clearBearerToken(): void;clearSecrets(): void;
  fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void;
}
export interface MCPComposition extends MCPAssembly {readonly part: DialogPart;open(): void}

/** Internal standalone adapter; the final application attaches the composed part
 * to its existing shared tree and retains one appearance/lifetime owner. */
export function mountMCPConnections(mount: HTMLElement,initial: Readonly<MCPState> = {},callbacks: MCPCallbacks = {},appearance: MountPartsOptions = {}): MCPAssembly {
  const connections = composeMCPConnections(initial,callbacks);
  try {mountParts(mount,connections.part,appearance);connections.open();return connections;}
  catch (error) {connections.destroy();throw error;}
}

export function composeMCPConnections(initial: Readonly<MCPState> = {},callbacks: MCPCallbacks = {}): MCPComposition {
  let alive = true,state = initial,items: readonly MCPConnection[] = [],rendered = false,auxiliaryPending = false,auxiliaryRevision = 0;
  let form: FormPart,dialog: DialogPart;
  let saved: MCPDraft = {name: '',type: 'http',url: '',oauth: false,oauthClientId: '',oauthScope: '',command: '',args: '[]',enabled: true,bearerToken: '',clearBearerToken: false,env: '',clearEnv: false};
  const feedback = createFeedbackPart({message: initial.error ?? '',tone: 'error'}),formError = createFeedbackPart({message: initial.formError ?? '',tone: 'error'});
  const fail = (message: string) => {if (alive) feedback.update({message,tone: 'error'});};
  const runAuxiliary = (callback: (() => HostResult) | undefined) => {
    if (!alive || !dialog.isOpen() || auxiliaryPending || !callback) return;
    const sequence = ++auxiliaryRevision;auxiliaryPending = true;
    const current = () => alive && sequence === auxiliaryRevision;
    const complete = (result: void | Result) => {if (current() && result && !result.ok) fail(result.error);};
    const failed = (error: unknown) => {if (current()) fail(error instanceof Error ? error.message : String(error));};
    const finish = () => {if (current()) auxiliaryPending = false;};
    try {const result = callback();if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).then(complete).catch(failed).finally(finish);else {complete(result);finish();}}
    catch (error) {try {failed(error);} finally {finish();}}
  };
  const name = createInputPart({label: 'Name',name: 'name',required: true,placeholder: 'my-tools',autocomplete: 'off'});
  const transport = createSelectPart({label: 'Connection type',name: 'type',value: 'http',options: [{value: 'http',label: 'HTTP'},{value: 'stdio',label: 'Local command (stdio)'}],onChange() {renderTransport();}});
  const url = createInputPart({label: 'Server URL',kind: 'url',name: 'url',placeholder: 'https://example.com/mcp',autocomplete: 'off'});
  const oauth = createCheckboxPart({label: 'Sign in with OAuth'});
  const client = createInputPart({label: 'Registered client ID'}),scope = createInputPart({label: 'Scopes'});
  const oauthDetails = createDisclosurePart({purpose: 'advanced',title: 'OAuth settings (optional)',children: [
    createLabelledFieldPart({label: 'Registered client ID',control: client}),createLabelledFieldPart({label: 'Scopes',control: scope}),
    createTextPart({role: 'hint',text: 'Uses the server’s OAuth discovery and PKCE. The temporary callback listens on 127.0.0.1:54819.'}),
  ]});
  const token = createInputPart({label: 'Bearer token (optional)',name: 'bearerToken',kind: 'password',autocomplete: 'new-password',placeholder: 'Optional token'});
  const clearToken = createCheckboxPart({label: 'Remove saved bearer token',hidden: true});
  const http = createStackPart({children: [createFieldLabelPart({label: 'Server URL',control: url}),url,oauth,oauthDetails,
    createFieldLabelPart({label: 'Bearer token (optional)',control: token}),token,clearToken,
    createTextPart({role: 'hint',text: 'Saved tokens are never returned to this page. Leave this field blank to keep an existing token.'})]});
  const command = createInputPart({label: 'Installed executable',name: 'command',placeholder: '/path/to/mcp-server',autocomplete: 'off'});
  const args = createTextareaPart({purpose: 'json',label: 'Arguments (JSON array)',name: 'args',value: '[]'});
  const envHint = createTextPart({role: 'hint',text: 'Values stay private. Leave blank to keep saved overrides. Add a JSON object of string keys and values to set or replace individual overrides.'});
  const env = createTextareaPart({purpose: 'secret',name: 'env',autocomplete: 'off',placeholder: '{"API_KEY":"…"}',describedBy: [envHint]});
  const envLabel = createSecretLabelPart({label: 'Environment overrides (JSON object, optional)',control: env});
  const savedKeys = createTextPart({role: 'hint',text: '',hidden: true});
  const clearEnv = createCheckboxPart({label: 'Clear saved environment overrides',hidden: true});
  const stdio = createStackPart({hidden: true,children: [createFieldLabelPart({label: 'Installed executable',control: command}),command,
    createFieldLabelPart({label: 'Arguments (JSON array)',control: args}),args,
    createTextPart({role: 'hint',text: 'The executable and any runtime it needs must already be installed on your computer. Pith Desk does not bundle external runtimes or a marketplace.'}),
    envLabel,env,envHint,savedKeys,clearEnv]});
  const enabled = createCheckboxPart({label: 'Enable this connection',name: 'enabled',checked: true});
  const read = (): MCPDraft => alive ? {name: name.read().trim(),type: transport.read() === 'stdio' ? 'stdio' : 'http',url: url.read().trim(),oauth: oauth.read(),oauthClientId: client.read().trim(),oauthScope: scope.read().trim(),command: command.read().trim(),args: args.read(),enabled: enabled.read(),bearerToken: token.read().trim(),clearBearerToken: clearToken.read(),env: env.read(),clearEnv: clearEnv.read()} : {...saved};
  const release = () => {
    if (!alive) return;
    saved = {...read(),bearerToken: '',env: ''};alive = false;auxiliaryRevision++;auxiliaryPending = false;rows.clear();form.invalidate();dialog.destroy();
    try {callbacks.onClose?.();} catch {}
  };
  const close = () => {if (alive) {dialog.close();release();}};
  const save = createButtonPart({label: 'Save connection',variant: 'primary',type: 'submit'});
  const syncSave = () => {if (alive) save.update({label: 'Save connection',variant: 'primary',disabled: !!state.disabled,pending: form.isPending()});};
  form = createFormPart({children: [createFieldLabelPart({label: 'Name',control: name}),name,createFieldLabelPart({label: 'Connection type',control: transport}),transport,http,stdio,enabled,formError,
    createFooterPart({children: [createButtonPart({label: 'Close',variant: 'secondary',onAction: close}),save]})],disabled: !!initial.disabled,
    onPending: syncSave,onError(message) {if (alive) formError.update({message,tone: 'error'});},
    onSubmit() {formError.update({message: '',tone: 'error'});return callbacks.onSubmit?.(read()) ?? {ok: false,error: 'This action is unavailable.'};},
  });
  const editorTitle = createTextPart({text: 'Add connection'});
  const create = createButtonPart({label: 'New connection',variant: 'secondary',onAction() {resetEditor();runAuxiliary(callbacks.onNew);}});
  const editor = createSeparatedSectionPart({children: [createSectionHeadingPart({children: [editorTitle,create]}),form]});
  const list = createStackPart({children: [createTextPart({role: 'caption',text: 'Loading connections…'})]});
  const refresh = createButtonPart({label: 'Refresh',variant: 'secondary',onAction() {runAuxiliary(callbacks.onRefresh);}});
  const body = createStackPart({children: [createTextPart({role: 'description',text: 'Add an MCP server to give Pith access to its tools. Enabled connections connect automatically when a task starts. Disable a connection to stop using it in tasks. External tools require approval unless this conversation has full access.'}),
    createToolbarPart({purpose: 'feature',label: 'Connections actions',children: [refresh]}),list,feedback,editor]});
  dialog = createDialogPart({purpose: 'feature',title: 'Connections',eyebrow: 'EXTERNAL TOOLS',children: [body],onClose: release,onDispose: release});

  type Row = {part: CardPart;name: ReturnType<typeof createTextPart>;address: ReturnType<typeof createTextPart>;enabled: ReturnType<typeof createTextPart>;status: ReturnType<typeof createStatusPart>;env: ReturnType<typeof createTextPart>;error: ReturnType<typeof createFeedbackPart>;buttons: Map<MCPAction,ButtonPart>;localError: string};
  const rows = new Map<string,Row>();let empty: ReturnType<typeof createTextPart> | undefined;
  function makeRow(item: Readonly<MCPConnection>): Row {
    const title = createTextPart({role: 'strong',text: item.name}),address = createTextPart({role: 'path-paragraph',text: ''}),availability = createTextPart({role: 'caption',text: ''});
    const status = createStatusPart({presentation: 'paragraph',message: '',tone: 'neutral'}),environment = createTextPart({role: 'caption',text: '',hidden: true}),error = createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error'});
    const target = Object.freeze({name: item.name}),buttons = new Map<MCPAction,ButtonPart>();
    let row: Row;
    for (const [action,label] of [['mcp-login','Sign in'],['mcp-logout','Sign out'],['mcp-edit','Edit'],['mcp-toggle','Disable'],['mcp-remove','Delete']] as const) buttons.set(action,createButtonPart({label,variant: action === 'mcp-remove' ? 'danger' : 'secondary',onAction() {row.localError = '';error.update({message: '',tone: 'error'});return callbacks.onConnectionAction?.(action,target);},onError(message) {if (alive) {row.localError = message;error.update({message,tone: 'error'});}}}));
    const part = createCardPart({purpose: 'stacked',children: [createCardHeadingPart({children: [title]}),address,availability,status,environment,error,createCompactActionsPart({children: [...buttons.values()]})]});
    row = {part,name: title,address,enabled: availability,status,env: environment,error,buttons,localError: ''};return row;
  }
  function renderConnections(): void {
    if (!alive || !rendered) return;
    const retained = new Set<string>(),children: Part[] = [];
    for (const item of items) {
      retained.add(item.name);let row = rows.get(item.name);if (!row) {row = makeRow(item);rows.set(item.name,row);}
      row.name.update({text: item.name});row.address.update({text: item.type === 'http' ? item.url ?? '' : [item.command,...item.args ?? []].join(' ')});
      row.enabled.update({text: `${item.enabled ? 'Enabled' : 'Disabled'}${item.hasBearerToken ? ' · Token configured' : ''}`});
      row.status.update({message: item.statusLabel,tone: item.enabled && item.status === 'error' ? 'error' : 'neutral'});
      row.env.update({text: item.envKeys?.length ? `Saved environment keys: ${item.envKeys.join(', ')}` : '',hidden: !item.envKeys?.length});
      row.error.update({message: item.error || row.localError,tone: 'error'});
      for (const [action,button] of row.buttons) {
        const hidden = action === 'mcp-login' ? !item.oauth : action === 'mcp-logout' ? !item.oauth || !item.signedIn : false;
        button.update({label: action === 'mcp-login' ? item.signedIn ? 'Sign in again' : 'Sign in' : action === 'mcp-logout' ? 'Sign out' : action === 'mcp-edit' ? 'Edit' : action === 'mcp-toggle' ? item.enabled ? 'Disable' : 'Enable' : 'Delete',variant: action === 'mcp-remove' ? 'danger' : 'secondary',hidden,disabled: !!state.disabled || hidden});
      }
      children.push(row.part);
    }
    if (!items.length) {empty ??= createTextPart({role: 'caption',text: 'No connections yet. Add an HTTP server or an installed local MCP command below. Tools are discovered on demand using tool search and Codemode.'});children.push(empty);}
    // Keep the inventory's one original neutral container, with keyed cards as
    // direct children. Once mounted, update only that retained container.
    if (!inventory) {inventory = createStackPart({children});list.replace([inventory]);}
    else inventory.replace(children);
    for (const key of rows.keys()) if (!retained.has(key)) rows.delete(key);
    if (items.length) empty = undefined;
  }
  let inventory: ReturnType<typeof createStackPart> | undefined;
  function renderTransport(): void {
    if (!alive) return;
    const isHTTP = transport.read() === 'http';http.update({hidden: !isHTTP});stdio.update({hidden: isHTTP});
    for (const control of [url,client,scope,token]) control.update({disabled: !isHTTP});oauth.update({disabled: !isHTTP});clearToken.update({disabled: !isHTTP});
    for (const control of [command,args,env]) control.update({disabled: isHTTP});clearEnv.update({disabled: isHTTP});url.update({required: isHTTP});command.update({required: !isHTTP});
  }
  function resetEditor(entry?: Readonly<MCPEditor>): void {
    if (!alive) return;
    form.reset();envLabel.update({label: 'Environment overrides (JSON object, optional)',revealed: false});editorTitle.update({text: entry ? `Edit ${entry.name}` : 'Add connection'});
    name.reset(entry?.name ?? '');name.update({readOnly: !!entry});transport.reset(entry?.type || 'http');url.reset(entry?.url ?? '');oauth.reset(entry?.oauth ?? false);client.reset(entry?.oauthClientId ?? '');scope.reset(entry?.oauthScope ?? '');
    command.reset(entry?.command ?? '');args.reset(JSON.stringify(entry?.args ?? [],null,2));enabled.reset(entry?.enabled ?? true);token.update({placeholder: entry?.hasBearerToken ? 'Leave blank to keep your saved token' : 'Optional token'});
    clearToken.update({hidden: !entry?.hasBearerToken});const keys = entry?.envKeys ?? [];clearEnv.update({hidden: !keys.length});savedKeys.update({text: `Saved environment keys: ${keys.join(', ')}`,hidden: !keys.length});
    state = {...state,formError: ''};formError.update({message: '',tone: 'error'});renderTransport();syncSave();(entry ? entry.type === 'stdio' ? command : url : name).focus();
  }
  function update(next: Readonly<MCPState>): void {
    if (!alive) return;
    state = next;if (next.error !== undefined) fail(next.error);if (next.formError !== undefined) formError.update({message: next.formError,tone: 'error'});
    form.update({disabled: !!next.disabled});syncSave();renderConnections();
  }
  renderTransport();update(initial);
  return {part: dialog,open() {if (alive) dialog.open();},read,update,
    edit(entry) {if (alive) {auxiliaryRevision++;auxiliaryPending = false;resetEditor(entry);}},
    setConnections(next) {if (alive) {items = next;rendered = true;renderConnections();}},
    clearBearerToken() {if (alive) token.reset('');saved.bearerToken = '';},
    clearSecrets() {if (alive) {token.reset('');env.reset('');}saved.bearerToken = '';saved.env = '';},
    fail,close,isOpen: () => alive && dialog.isOpen(),destroy: close};
}
