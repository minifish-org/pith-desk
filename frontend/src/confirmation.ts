import type { Application, ConfirmationState, SceneSession } from './ui-contract.ts';

export type Confirmation = {
  title: string; action: string; description: ConfirmationState['description']; hint?: string;
  scope?: { conversationId?: string; workspaceId?: string; global?: boolean };
  unavailable: () => boolean; run: () => Promise<boolean>; error: () => string;
};

// Business availability and request ownership remain with the application.
export function createConfirmation(ui: Application) {
  let current: Confirmation | undefined;
  let session: SceneSession<ConfirmationState> | undefined;
  let state: ConfirmationState | undefined;
  const open = (options: Confirmation): void => {
    current = options;
    state = {title: options.title, action: options.action, description: options.description, hint: options.hint, disabled: options.unavailable()};
    session = ui.workspace.openConfirmation(state, {
      async onConfirm() {
        if (current !== options || options.unavailable()) return {ok: false, error: 'This action is no longer available.'};
        const ok = await options.run();
        return ok ? {ok: true} : {ok: false, error: options.error()};
      },
      onClose() {if (current === options) {current = undefined; session = undefined; state = undefined;}},
    });
  };
  return Object.assign(open, {
    render() {
      if (!current || !session || !state) return;
      const disabled = current.unavailable();
      if (disabled !== state.disabled) {state = {...state, disabled}; session.update(state);}
    },
    destroy() {current = undefined; state = undefined; session?.destroy(); session = undefined;},
  });
}
