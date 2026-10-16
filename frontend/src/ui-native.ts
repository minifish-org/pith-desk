type NativeDrop = {paths: string[]; x: number; y: number};

function readNativeDrop(input: unknown): NativeDrop | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.paths) || !value.paths.every(path => typeof path === 'string')) return;
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)) return;
  return {paths: value.paths, x: value.x, y: value.y};
}

export function isForeground(): boolean {return document.visibilityState === 'visible' && document.hasFocus();}

// Native coordinates are data; only the library tests interface bounds.
export function installNativeDrop(enabled: boolean, receive: (drop: NativeDrop) => void): () => void {
  const onDrop = (event: Event) => {
    if (!enabled) return;
    const drop = readNativeDrop((event as CustomEvent<unknown>).detail);
    if (drop) receive(drop);
  };
  if (enabled) window.addEventListener('pith:file-drop', onDrop);
  return () => window.removeEventListener('pith:file-drop', onDrop);
}
