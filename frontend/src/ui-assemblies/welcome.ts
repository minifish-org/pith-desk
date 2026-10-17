/** Internal local composition of the existing welcome/setup structure. */
import {
  createBrandMarkPart,createBrandTilePart,createButtonPart,createCenteredContentPart,createContextLinePart,createIconNotePart,createIconPart,
  createResponsiveLeadPart,createStepActionPart,createStepGroupPart,createSuggestionGroupPart,createTextFlowPart,createTextPart,
  type BrandMarkOptions,type CenteredContentPart,type LayoutPart,type Part,type StepActionPart,type StepGroupPart,type SuggestionGroupPart,type TextFlowPart,
} from 'pith-ui';

export interface WelcomeState {workspace?: {name: string;path: string};hasApiKey: boolean;hasConnections: boolean;modelName: string;hidden?: boolean}
export type WelcomeResult = void|{ok: true}|{ok: false;error: string};
export interface WelcomeCallbacks {
  onAction?(action: 'model'|'settings'|'workspace'): WelcomeResult|Promise<WelcomeResult>;
  canPrompt?(): boolean;
  onPrompt?(text: string): void;
  onError?(message: string): void;
}
export interface WelcomeComposition {readonly part: CenteredContentPart;update(state: Readonly<WelcomeState>): void;destroy(): void}

/** All setup/ready decisions and suggested prompt content remain local. */
export function composeWelcome(initial: Readonly<WelcomeState>,callbacks: WelcomeCallbacks = {},mark: BrandMarkOptions = {symbol: 'pith',alt: ''}): WelcomeComposition {
  let state = initial,alive = true,mode: 'setup'|'ready'|undefined;
  let setup: {part: StepGroupPart;model: StepActionPart;workspace: StepActionPart}|undefined;
  let ready: {line: LayoutPart;workspace: TextFlowPart;suggestions: SuggestionGroupPart}|undefined;
  const fail = (error: unknown) => {if (alive) callbacks.onError?.(error instanceof Error ? error.message : String(error));};
  const run = (action: 'model'|'settings'|'workspace') => {
    if (!alive || !callbacks.onAction) return;
    const accept = (result: WelcomeResult) => {if (alive && result && !result.ok) fail(result.error);};
    try {const result = callbacks.onAction(action);if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).then(accept).catch(fail);else accept(result);} catch (error) {fail(error);}
  };
  const tile = createBrandTilePart({mark: createBrandMarkPart(mark)}),eyebrow = createTextPart({role: 'eyebrow-paragraph',text: 'YOUR LOCAL WORK COMPANION'});
  const title = createTextPart({role: 'display-heading',text: ''}),lead = createResponsiveLeadPart({lines: ['An agent that works alongside you, with your files',' and the tools you choose.']}),note = createIconNotePart({icon: 'shield',text: 'Local workspace. Your choice of model.'});
  const part = createCenteredContentPart({children: [],onDispose() {alive = false;setup = undefined;ready = undefined;}});
  function update(next: Readonly<WelcomeState>): void {
    if (!alive) return;state = next;const nextMode = state.workspace && state.hasApiKey ? 'ready' : 'setup';
    title.update({text: nextMode === 'ready' ? 'What are we working on?' : 'Your work. A little more possible.'});
    const middle: Part[] = [];
    if (nextMode === 'setup') {
      if (mode !== 'setup') {
        const model = createStepActionPart({step: '1',completed: false,label: '',description: '',onAction() {run(state.hasConnections ? 'model' : 'settings');}}),workspace = createStepActionPart({step: '2',completed: false,label: '',description: '',onAction() {run('workspace');}});
        setup = {model,workspace,part: createStepGroupPart({title: 'Make yourself at home',summary: 'Two quick steps',children: [model,workspace]})};ready = undefined;
      }
      setup!.model.update({step: '1',completed: state.hasApiKey,label: state.hasApiKey ? 'Model selected' : state.hasConnections ? 'Choose a model' : 'Connect a provider',description: state.hasApiKey ? state.modelName : state.hasConnections ? 'Your provider connection is ready' : 'Bring your provider API key'});
      setup!.workspace.update({step: '2',completed: !!state.workspace,label: state.workspace?.name ?? 'Choose a workspace',description: state.workspace?.path ?? 'A folder Pith can help you work in'});middle.push(setup!.part);
    } else {
      if (mode !== 'ready') {
        const workspace = createTextFlowPart({role: 'inline',segments: []}),change = createButtonPart({label: 'Change',variant: 'secondary',onAction() {run('workspace');}}),line = createContextLinePart({children: [createIconPart({name: 'folder'}),workspace,change]});
        const suggestions = createSuggestionGroupPart({children: ([
          ['file','Explore my workspace','Explore this workspace and give me a concise overview of its files.'],
          ['chat','Think through a task','Help me plan a task. Start by asking what I want to accomplish.'],
          ['plus','Create something',"I'd like help creating a document in this workspace. Ask me what it should cover."],
        ] as const).map(([icon,label,prompt]) => createButtonPart({variant: 'suggestion',icon,label,onAction() {if (alive && callbacks.canPrompt?.() !== false) callbacks.onPrompt?.(prompt);}}))});
        ready = {workspace,line,suggestions};setup = undefined;
      }
      ready!.workspace.update({segments: [{text: 'Working in '},{text: state.workspace!.name,emphasis: 'strong'}]});middle.push(ready!.line,ready!.suggestions);
    }
    mode = nextMode;part.replace([tile,eyebrow,title,lead,...middle,note]);part.update({hidden: !!state.hidden});
  }
  update(initial);return {part,update,destroy() {part.destroy();}};
}
