import type { ApiMutate, ApiRequest } from './api.ts';
import type { State } from './app-state.ts';
import type { Confirmation } from './confirmation.ts';
export type SDKFeatureAPI = {
    confirm: (options: Confirmation) => void;
    state: () => State;
    busy: () => boolean;
    request: ApiRequest;
    mutate: ApiMutate;
    error: () => string;
    workspaceBusy: (id: string) => boolean;
    draft: (text: string) => void;
    refreshResources: () => Promise<void>;
    settings: () => void;
    refreshProviderAuth: (provider: string) => void;
    refreshMCP: () => Promise<void>;
};
