// Native ingress becomes pure data before it reaches application controllers.
export interface NativeDropImage {name: string;mimeType: string;data: string}
export interface NativeDrop {paths: string[];images: NativeDropImage[];notice: string;x: number;y: number}
export type NativeMenuAction = 'new-conversation'|'choose-workspace'|'export-conversation'|'settings'|'check-updates';

const dropImageTypes = ['image/png','image/jpeg','image/gif','image/webp'];
// The native bridge carries image bytes: bound the batch before decoding it.
const dropImageCharacters = 24 * 1024 * 1024;

export function readNativeDrop(input: unknown): NativeDrop | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string,unknown>;
  if (!Array.isArray(value.paths) || !value.paths.every(path => typeof path === 'string')) return;
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)) return;
  const images: NativeDropImage[] = [];
  let remaining = dropImageCharacters;
  for (const entry of Array.isArray(value.images) ? value.images : []) {
    if (images.length >= 8) break;
    if (!entry || typeof entry !== 'object') continue;
    const image = entry as Record<string,unknown>;
    if (typeof image.name !== 'string' || !image.name || image.name.length > 255) continue;
    if (typeof image.mimeType !== 'string' || !dropImageTypes.includes(image.mimeType)) continue;
    if (typeof image.data !== 'string' || !image.data || image.data.length > remaining) continue;
    remaining -= image.data.length;
    images.push({name: image.name,mimeType: image.mimeType,data: image.data});
  }
  const notice = typeof value.notice === 'string' ? value.notice.slice(0,500) : '';
  return {paths: value.paths,images,notice,x: value.x,y: value.y};
}

export function readNativeMenuAction(input: unknown): NativeMenuAction | undefined {
  if (!input || typeof input !== 'object' || !('action' in input)) return;
  const action = input.action;
  if (action === 'new-conversation' || action === 'choose-workspace' || action === 'export-conversation' || action === 'settings' || action === 'check-updates') return action;
}

export function readDraftFlushCallback(input: unknown): ((saved: boolean) => void) | undefined {
  if (typeof input === 'function') return input as (saved: boolean) => void;
}
