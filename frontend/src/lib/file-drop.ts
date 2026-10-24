/** Browser file drop reads images locally; other files must resolve to
 * workspace-relative paths through the host. Native drops arrive separately
 * through `installNativeDrop`. */
export function installBrowserFileDrop(options: {
  pending: (pending: boolean) => void;
  images: (files: File[]) => void;
  references: (input: {uris: string; hasUnidentifiedFiles: boolean}) => void;
}): () => void {
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    options.pending(true);
  };
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget) return;
    options.pending(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    const files = [...event.dataTransfer.files];
    const uris = event.dataTransfer.getData('text/uri-list');
    if (!files.length && !uris) return;
    event.preventDefault();
    options.pending(false);
    const images = files.filter(file => file.type.startsWith('image/'));
    if (images.length) options.images(images);
    const nonImages = files.filter(file => !file.type.startsWith('image/'));
    options.references({uris, hasUnidentifiedFiles: nonImages.length > 0});
  };
  const clearPending = () => options.pending(false);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('dragend', clearPending);
  return () => {
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('dragend', clearPending);
  };
}
