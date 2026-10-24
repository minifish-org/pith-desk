import type {ApiDownload, ApiMutate, ApiRequest, MutationInput, MutationPath, MutationResponse, RequestOptions} from '@/api.ts';
import {createMutations} from '@/mutations.ts';
import {app, runtime} from '@/lib/runtime.ts';
import {desk} from '@/stores/desk.ts';

const callRequest = (path: string, input?: unknown, options?: RequestOptions): Promise<unknown> =>
  (app().request as unknown as (p: string, i?: unknown, o?: RequestOptions) => Promise<unknown>)(path, input, options);

const callDownload = (path: string, query?: object): Promise<Blob> =>
  (app().download as unknown as (p: string, q?: object) => Promise<Blob>)(path, query);

export const request = ((path: string, input?: unknown, options?: RequestOptions) => callRequest(path, input, options)) as unknown as ApiRequest;
export const download = ((path: string, query?: object) => callDownload(path, query)) as unknown as ApiDownload;

let mutateImplementation: ApiMutate | undefined;

export function mutate<P extends MutationPath>(path: P, payload: MutationInput<P>, onResponse?: (response: MutationResponse<P>) => void): Promise<boolean> {
  mutateImplementation ??= createMutations({
    request: ((path: string, input?: unknown, options?: RequestOptions) => callRequest(path, input, options)) as unknown as ApiRequest,
    refresh: () => app().refresh(),
    busy: () => desk().activity.busy,
    setBusy: busy => desk().setBusy(busy),
    error: error => desk().setError(error),
    render: () => {},
  });
  return mutateImplementation(path, payload, onResponse);
}

export function setError(error: string): void {
  desk().setError(error);
}

export function busy(): boolean {
  return desk().activity.busy;
}


export function applyAppearance(appearance: 'system' | 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', appearance === 'dark' || (appearance === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
  root.dataset.appearance = appearance;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', root.classList.contains('dark') ? '#171717' : '#fbfbfb');
}

export async function copyText(text: string): Promise<void> {
  try {
    if (runtime.nativeClipboard) await request('/api/copy-text', {text});
    else await navigator.clipboard.writeText(text);
  } catch (error) {
    // Copy is a user-visible command; keep the control retryable and report why.
    desk().setError(error instanceof Error ? error.message : String(error));
  }
}
