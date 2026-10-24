// Page-local signals between the action layer and interface surfaces. They carry
// no state: the store and host snapshot remain the source of truth. Native
// ingress events are validated in `native-protocol.ts` and are not listed here.
const eventNames = {
  focusComposer: 'pith:focus-composer',
  followLatest: 'pith:follow-latest',
  mcpRefresh: 'pith:mcp-refresh',
  modelConnectionsChanged: 'pith:model-connections-changed',
  resourcesChanged: 'pith:resources-changed',
} as const;

export type AppEvent = keyof typeof eventNames;

export function emitAppEvent(event: AppEvent): void {
  window.dispatchEvent(new Event(eventNames[event]));
}

export function onAppEvent(event: AppEvent, handler: () => void): () => void {
  const name = eventNames[event];
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
