import {createConfirmDialog, type ConfirmationMessage, type ConfirmDialog, type ConfirmState} from 'pith-ui';
import type {Application} from './ui-types';

export type Confirmation = {
  title: string; action: string; description: ConfirmationMessage; hint?: string;
  scope?: { conversationId?: string; workspaceId?: string; global?: boolean };
  unavailable: () => boolean; run: () => Promise<boolean>; error: () => string;
};

// Business availability and request ownership remain with the application.
export function createConfirmation(ui: Application) {
  let current: Confirmation | undefined;
  let session: ConfirmDialog | undefined;
  let owner: {destroy(): void} | undefined;
  let state: ConfirmState | undefined;
  const open = (options: Confirmation): void => {
    owner?.destroy(); owner = undefined;
    current = options;
    state = {title: options.title, confirmLabel: options.action, message: options.description, hint: options.hint, disabled: options.unavailable()};
    session = createConfirmDialog({...state,
      unavailable: () => current !== options || options.unavailable(),
      async onConfirm() {
        if (current !== options || options.unavailable()) return {ok: false, error: 'This action is no longer available.'};
        const ok = await options.run();
        return ok ? {ok: true} : {ok: false, error: options.error()};
      },
      onClose() {if (current === options) {current = undefined; session = undefined; state = undefined; owner?.destroy(); owner = undefined;}},
    });
    owner = ui.attachDialog(session);
    session.open();
  };
  return Object.assign(open, {
    render() {
      if (!current || !session || !state) return;
      const disabled = current.unavailable();
      if (disabled !== state.disabled) {state = {...state, disabled}; session.update(state);}
    },
    destroy() {current = undefined; state = undefined; owner?.destroy(); owner = undefined; session = undefined;},
  });
}
