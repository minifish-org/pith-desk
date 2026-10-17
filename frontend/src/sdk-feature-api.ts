import type { ApiMutate, ApiRequest } from './api.ts';
import type { State } from './app-state.ts';
import type { Confirmation } from './confirmation.ts';
import type { Application } from './ui-contract.ts';
export type SDKFeatureAPI = {
    ui: Application;
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
