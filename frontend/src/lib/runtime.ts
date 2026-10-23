import type {createApp} from '@/app.ts';

export type DeskApp = ReturnType<typeof createApp>;

// One page owns one application transport instance. Modules read it through
// this handle so UI modules never import each other's initializers.
export const runtime: {
  app?: DeskApp;
  server: boolean;
  nativeBrowser: boolean;
  nativeClipboard: boolean;
  nativeFileDrop: boolean;
  nativeMenus: boolean;
  titlebar: 'overlay' | undefined;
  session?: {
    login(token: string): Promise<void>;
    continueHere(): Promise<void>;
    dismiss(): void;
    logout(): Promise<void>;
  };
  unloading: boolean;
  protocols: () => string[];
  checkAccess: () => Promise<void>;
} = {
  unloading: false,
  protocols: () => ['pith-desk'],
  checkAccess: () => Promise.resolve(),
  server: false,
  nativeBrowser: false,
  nativeClipboard: false,
  nativeFileDrop: false,
  nativeMenus: false,
  titlebar: undefined,
};

export function app(): DeskApp {
  if (!runtime.app) throw new Error('The application is not ready.');
  return runtime.app;
}
