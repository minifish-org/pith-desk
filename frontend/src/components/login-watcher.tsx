import {useEffect} from 'react';
import {desk, useDesk} from '@/stores/desk.ts';

/** Opens the provider sign-in dialog when the host reports a login that needs
 * an interface. Completion belongs to the provider form, so it is skipped. */
export function LoginWatcher() {
  const login = useDesk(store => store.state.login);
  useEffect(() => {
    if (!login) return;
    if (desk().modals.some(modal => modal.kind === 'provider-login')) return;
    // Completion is reflected by the provider form; prompts and failures need
    // an explicit surface of their own.
    if (login.phase === 'complete') return;
    desk().openModal({kind: 'provider-login', id: `login-${login.id}`, provider: login.provider});
  }, [login]);
  return null;
}
