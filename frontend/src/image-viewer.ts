// Decode locally in small pieces so large previews can yield or be cancelled.
export async function imagePreviewBlob(data: string, mimeType: string, active: () => boolean = () => true): Promise<Blob | null> {
  const parts: BlobPart[] = [];
  const chunkSize = 256 * 1024; // Base64 boundaries must be a multiple of four.
  for (let offset = 0, chunk = 0; offset < data.length; offset += chunkSize, chunk++) {
    if (!active()) return null;
    const decoded = atob(data.slice(offset, offset + chunkSize));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    parts.push(bytes);
    if (chunk % 8 === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return active() ? new Blob(parts, { type: mimeType }) : null;
}

// A separate dialog works above the generated-file preview as well as in chat.
export function installImageViewer(dialog: HTMLDialogElement) {
  const image = dialog.querySelector<HTMLImageElement>('img')!;
  const viewport = dialog.querySelector<HTMLElement>('.image-viewer-viewport')!;
  const title = dialog.querySelector<HTMLElement>('h2')!;
  const status = dialog.querySelector<HTMLElement>('[data-image-scale]')!;
  let scale = 1, fitted = true, source: HTMLImageElement | null = null;
  function update(): void {
    if (!image.naturalWidth) return;
    if (fitted) scale = Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
    image.style.width = `${image.naturalWidth * scale}px`;
    image.style.height = `${image.naturalHeight * scale}px`;
    status.textContent = `${Math.round(scale * 100)}% · ${image.naturalWidth} × ${image.naturalHeight}`;
  }
  function resize(factor: number): void { fitted = false; const next = scale * factor; if (Number.isFinite(next) && next > 0) scale = next; update(); }
  dialog.querySelector('[data-image-fit]')!.addEventListener('click', () => { fitted = true; update(); });
  dialog.querySelector('[data-image-original]')!.addEventListener('click', () => { fitted = false; scale = 1; update(); });
  dialog.querySelector('[data-image-in]')!.addEventListener('click', () => resize(1.25));
  dialog.querySelector('[data-image-out]')!.addEventListener('click', () => resize(1 / 1.25));
  dialog.querySelector('[data-image-close]')!.addEventListener('click', () => dialog.close());
  image.addEventListener('load', update);
  const observer = new ResizeObserver(() => { if (dialog.open && fitted) update(); });
  observer.observe(viewport);
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    image.removeAttribute('style');
    source?.focus({ preventScroll: true });
    source = null;
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.addEventListener('keydown', (event) => {
    if (!dialog.open || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); resize(1.25); }
    if (event.key === '-') { event.preventDefault(); resize(1 / 1.25); }
  });
  return {
    open(target: HTMLImageElement): void {
      if (!target.getAttribute('src') || target.classList.contains('image-unavailable')) return;
      source = target;
      title.textContent = target.alt || 'Image';
      image.alt = target.alt;
      scale = 1;
      fitted = true;
      status.textContent = 'Loading…';
      image.src = target.src;
      if (!dialog.open) dialog.showModal();
      viewport.scrollTop = viewport.scrollLeft = 0;
      update();
    },
    close: () => { if (dialog.open) dialog.close(); },
  };
}
