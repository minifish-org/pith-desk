// Availability combines component readiness with host/task constraints.
// Snapshot rendering must not clear a dialog's loading or probing state.
export function controlDisabled(button: Pick<HTMLButtonElement, 'dataset'>, unavailable: boolean): boolean {
  return unavailable || !!button.dataset.controlPending || !!button.dataset.copyPending;
}

export function setControlPending(button: HTMLButtonElement, pending: boolean): void {
  if (pending) { button.dataset.controlPending = 'true'; button.disabled = true; }
  else delete button.dataset.controlPending;
}
