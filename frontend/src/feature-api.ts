import type { createApp } from './app.ts';
// Read-only access to the app snapshot; features never keep another State owner.
export type AppView = Readonly<Pick<ReturnType<typeof createApp>, 'state' | 'loaded' | 'receivedAt'>>;
// The existing application-wide mutation gate and feedback, owned by main.
export interface UIActivity {
    busy: boolean;
    error: string;
}
