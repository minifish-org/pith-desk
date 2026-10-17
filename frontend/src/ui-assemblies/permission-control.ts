/** Internal consumer recipe. Permission policy and confirmation remain with the application. */
import {createCompactSelectPart,createContextNotePart,type CompactSelectPart,type ContextNotePart} from 'pith-ui';

export interface PermissionState {mode: string;description: string;disabled?: boolean}
export interface PermissionComposition {readonly control: CompactSelectPart;readonly description: ContextNotePart;update(state: Readonly<PermissionState>): void;destroy(): void}
/** The control and note occupy separate existing composer slots under one owner. */
export function composePermissionControl(initial: Readonly<PermissionState>,callbacks: {onChange?(mode: string): void} = {}): PermissionComposition {
  let alive = true;
  const description = createContextNotePart({text: initial.description,tone: initial.mode === 'full-access' ? 'warning' : 'neutral'});
  const control = createCompactSelectPart({label: 'Conversation permissions',icon: 'shield',value: initial.mode,describedBy: [description],tone: initial.mode === 'full-access' ? 'warning' : 'standard',disabled: !!initial.disabled,
    options: [{value: 'ask',label: 'Ask before changes'},{value: 'workspace-write',label: 'Allow workspace changes'},{value: 'full-access',label: 'Full access'}],onChange(value) {if (alive) callbacks.onChange?.(value);}});
  const update = (state: Readonly<PermissionState>) => {
    if (!alive) return;
    control.reset(state.mode);control.update({disabled: !!state.disabled,tone: state.mode === 'full-access' ? 'warning' : 'standard'});
    description.update({text: state.description,tone: state.mode === 'full-access' ? 'warning' : 'neutral'});
  };
  return {control,description,update,destroy() {if (alive) {alive = false;control.destroy();description.destroy();}}};
}
