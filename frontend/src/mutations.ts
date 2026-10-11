import type { ApiRequest, ApiMutate } from './api.ts';

// A committed operation and a refreshed snapshot have separate outcomes.
// Never invite a retry of a successful write when only the following read failed.
export function createMutations(api: {
  request: ApiRequest; refresh: () => Promise<void>; busy: () => boolean;
  setBusy: (busy: boolean) => void; error: (message: string) => void; render: () => void;
}): ApiMutate {
  return async (path, payload, onResponse) => {
    if (api.busy()) return false;
    api.setBusy(true);
    api.error('');
    api.render();
    try {
      const response = await api.request(path, payload);
      try {
        onResponse?.(response);
        await api.refresh();
      } catch (reason) {
        api.error(`Change saved. Waiting for the local service to refresh: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
      return true;
    } catch (reason) {
      api.error(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      api.setBusy(false);
      api.render();
    }
  };
}
