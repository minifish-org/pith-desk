const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const imageExtension = /\.(?:png|jpe?g|gif|webp)$/i;

export function isImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  return imageTypes.has(file.type) || (!file.type && imageExtension.test(file.name));
}

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

export function insertWorkspaceReferences(value: string, start: number, end: number, paths: string[]): { value: string; cursor: number } {
  const references = paths.map(formatWorkspaceReference).join(' ');
  const before = value.slice(0, start);
  const after = value.slice(end);
  const inserted = (before && !/\s$/.test(before) ? ' ' : '') + references + (after && !/^\s/.test(after) ? ' ' : '');
  return { value: before + inserted + after, cursor: before.length + inserted.length };
}

export function formatWorkspaceReference(path: string): string {
  // CommonMark code spans can contain backticks when the delimiter is longer.
  const length = Math.max(0, ...Array.from(path.matchAll(/`+/g), (match) => match[0].length)) + 1;
  const delimiter = '`'.repeat(length);
  const padded = /^`|`$|^ | $/.test(path) && !/^ +$/.test(path);
  return delimiter + (padded ? ` ${path} ` : path) + delimiter;
}

interface DropOptions {
  form: HTMLElement;
  input: HTMLTextAreaElement;
  native: boolean;
  busy: () => boolean;
  context: () => string;
  workspaceID: () => string | undefined;
  disposed: () => boolean;
  resolve: (workspaceID: string, paths: string[]) => Promise<string[]>;
  images: (files: File[]) => Promise<void>;
  pending: (pending: boolean) => void;
  changed: () => void;
  error: (message: string) => void;
}

export function installWorkspaceFileDrop(options: DropOptions): void {
  const { form, input } = options;
  let pending = false;
  const addPaths = async (paths: string[]) => {
    if (!paths.length || options.busy() || pending) return;
    const workspaceID = options.workspaceID();
    if (!workspaceID) { options.error('Choose a workspace before dropping files.'); return; }
    const context = options.context();
    pending = true;
    options.pending(true);
    try {
      const refs = await options.resolve(workspaceID, paths);
      // A slow response must not insert into another workspace's draft.
      if (options.disposed() || context !== options.context()) return;
      const result = insertWorkspaceReferences(input.value, input.selectionStart, input.selectionEnd, refs);
      input.value = result.value;
      input.setSelectionRange(result.cursor, result.cursor);
      input.focus();
      options.changed();
    } catch (error) {
      if (!options.disposed() && context === options.context()) options.error(error instanceof Error ? error.message : String(error));
    } finally { pending = false; options.pending(false); }
  };
  form.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.some((type) => type === 'Files' || type === 'text/uri-list')) {
      event.preventDefault();
      if (!options.busy() && !pending) form.classList.add('drag-images');
    }
  });
  form.addEventListener('dragleave', () => form.classList.remove('drag-images'));
  form.addEventListener('drop', (event) => {
    event.preventDefault();
    form.classList.remove('drag-images');
    if (options.busy()) return;
    const files = Array.from(event.dataTransfer?.files || []);
    const images = files.filter(isImageFile);
    if (images.length) void options.images(images);
    if (options.native) return; // The native event supplies the actual paths.
    const paths = localFileURIs(event.dataTransfer?.getData('text/uri-list') || '').filter((path) => !isImagePath(path));
    if (paths.length) void addPaths(paths);
    else if (files.some((file) => !isImageFile(file))) options.error('Browser preview cannot identify this local file. Type its workspace-relative path, or drop it in the desktop app.');
  });
  window.addEventListener('pith:file-drop', (event) => {
    if (!options.native) return;
    const detail = (event as CustomEvent).detail as { paths?: unknown; x?: unknown; y?: unknown };
    if (!detail || !Array.isArray(detail.paths) || !detail.paths.every((path) => typeof path === 'string') || typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
    const target = document.elementFromPoint(detail.x, detail.y);
    if (!target || !form.contains(target)) return;
    void addPaths(detail.paths.filter((path: string) => !isImagePath(path)));
  });
}
