// Native ingress becomes pure data before it reaches application controllers.
export interface NativeDrop {paths: string[];x: number;y: number}
export type NativeMenuAction = 'new-conversation'|'choose-workspace'|'export-conversation'|'settings'|'check-updates';

export function readNativeDrop(input: unknown): NativeDrop | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string,unknown>;
  if (!Array.isArray(value.paths) || !value.paths.every(path => typeof path === 'string')) return;
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)) return;
  return {paths: value.paths,x: value.x,y: value.y};
}

export function readNativeMenuAction(input: unknown): NativeMenuAction | undefined {
  if (!input || typeof input !== 'object' || !('action' in input)) return;
  const action = input.action;
  if (action === 'new-conversation' || action === 'choose-workspace' || action === 'export-conversation' || action === 'settings' || action === 'check-updates') return action;
}

export function readDraftFlushCallback(input: unknown): ((saved: boolean) => void) | undefined {
  if (typeof input === 'function') return input as (saved: boolean) => void;
}
