/** Internal consumer recipe. Task recovery, configuration and diagnostics stay with the controller. */
import {createButtonPart,createCalloutPart,createStackPart,createTextPart,type ButtonPart,type CalloutPart,type StackPart,type TextPart} from 'pith-ui';

export type Result = {ok: true}|{ok: false;error: string};
export type FailureAction = 'continue'|'settings'|'diagnostics';
export interface TaskFailureState {visible: boolean;message: string;advice: string;canContinue: boolean;workspaceId?: string;disabled?: boolean}
export interface TaskFailureCallbacks {onAction?(action: FailureAction,workspaceId?: string): void|Result|Promise<void|Result>;onError?(message: string): void}
export interface TaskFailureComposition {readonly part: CalloutPart;update(state: Readonly<TaskFailureState>): void;destroy(): void}

export function composeTaskFailure(initial: Readonly<TaskFailureState>,callbacks: TaskFailureCallbacks = {}): TaskFailureComposition {
  let alive = true,state = initial,message: TextPart|undefined,advice: TextPart|undefined,actions: StackPart|undefined;
  const rows = new Map<FailureAction,ButtonPart>();
  const part = createCalloutPart({tone: 'neutral',announce: 'polite',hidden: !initial.visible,children: [],onDispose() {alive = false;rows.clear();}});
  async function run(action: FailureAction): Promise<void> {
    const workspace = action === 'continue' ? state.workspaceId : undefined;
    try {const result = await callbacks.onAction?.(action,workspace);if (result && !result.ok) throw new Error(result.error);}
    catch (error) {if (alive) callbacks.onError?.(error instanceof Error ? error.message : String(error));}
  }
  const update = (next: Readonly<TaskFailureState>) => {
    if (!alive) return;
    state = next;part.update({tone: 'neutral',announce: 'polite',hidden: !next.visible});if (!next.visible) return;
    if (!message) {
      message = createTextPart({role: 'strong',text: ''});advice = createTextPart({role: 'paragraph',text: ''});actions = createStackPart({children: []});part.replace([message,advice,actions]);
    }
    message.update({text: next.message});advice!.update({text: next.advice});
    const desired: Array<{action: FailureAction;label: string}> = [{action: next.canContinue ? 'continue' : 'settings',label: next.canContinue ? 'Review and continue' : 'Check model settings'},{action: 'diagnostics',label: 'Save diagnostics'}];
    for (const view of desired) if (!rows.has(view.action)) rows.set(view.action,createButtonPart({label: view.label,variant: 'secondary',onAction() {if (alive && (view.action !== 'continue' || !state.disabled)) void run(view.action);}}));
    for (const view of desired) rows.get(view.action)!.update({label: view.label,variant: 'secondary',disabled: view.action === 'continue' && !!next.disabled});
    actions!.replace(desired.map(view => rows.get(view.action)!));for (const action of rows.keys()) if (!desired.some(view => view.action === action)) rows.delete(action);
  };
  update(initial);return {part,update,destroy() {alive = false;part.destroy();rows.clear();}};
}
