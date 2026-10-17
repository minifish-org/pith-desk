import type { Application, WorkspaceCallbacks } from './ui-types';
const imageExtension = /\.(?:png|jpe?g|gif|webp)$/i;

export function isImagePath(path: string): boolean {
  try { if (/^file:/i.test(path)) path = new URL(path).pathname; } catch { return false; }
  return imageExtension.test(path);
}

// File.name and webkitRelativePath do not establish a local file's identity.
// Only complete file URIs are sent to the host, which validates every path.
export function localFileURIs(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || line.startsWith('#')) return false;
    try {
      const url = new URL(line);
      return url.protocol === 'file:' && !url.username && !url.password && (!url.host || url.host === 'localhost') && !url.search && !url.hash;
    } catch { return false; }
  });
}

interface DropOptions {
  ui: Application;
  native: boolean;
  busy: () => boolean;
  context: () => string;
  workspaceID: () => string | undefined;
  disposed: () => boolean;
  resolve: (workspaceID: string, paths: string[]) => Promise<string[]>;
  pending: (pending: boolean) => void;
  changed: () => void;
  error: (message: string) => void;
}

export function installWorkspaceFileDrop(options: DropOptions) {
  let pending = false;
  let destroyed = false;
  const addPaths = async (paths: string[]) => {
    if (destroyed || !paths.length || options.busy() || pending) return;
    const workspaceID = options.workspaceID();
    if (!workspaceID) { options.error('Choose a workspace before dropping files.'); return; }
    const context = options.context();
    pending = true;
    options.ui.workspace.setDropPending(true);
    options.pending(true);
    let released = false;
    try {
      const refs = await options.resolve(workspaceID, paths);
      // A slow response must not insert into another workspace's draft.
      if (destroyed || options.disposed() || context !== options.context()) return;
      // Resolving has finished. The scene can now perform its own selection
      // insertion while this controller still rejects a second resolver.
      options.ui.workspace.setDropPending(false);
      options.pending(false);
      released = true;
      options.ui.workspace.insertReferences(refs);
      options.changed();
    } catch (error) {
      if (!destroyed && !options.disposed() && context === options.context()) options.error(error instanceof Error ? error.message : String(error));
    } finally {
      pending = false;
      if (!destroyed && !released) { options.ui.workspace.setDropPending(false); options.pending(false); }
    }
  };
  function references(input: Parameters<NonNullable<WorkspaceCallbacks['onDropReferences']>>[0]): void {
    if (destroyed || options.busy() || pending) return;
    if (options.native) {
      if (input.paths.length) void addPaths(input.paths.filter(path => !isImagePath(path)));
      return;
    }
    const paths = localFileURIs(input.uris || '').filter(path => !isImagePath(path));
    if (paths.length) void addPaths(paths);
    else if (input.hasUnidentifiedFiles) options.error('Browser preview cannot identify this local file. Type its workspace-relative path, or drop it in the desktop app.');
  }
  return {
    references,
    destroy(): void { destroyed = true; options.ui.workspace.setDropPending(false); },
  };
}
