/** Internal assembly: image viewport, status, actions and an empty modal part. */
import {
  createButtonPart, createDialogPart, createMediaToolbarPart, createTextPart,
  createZoomImagePart, mountParts, type DialogPart, type MountPartsOptions,
} from 'pith-ui';

export interface ImageViewerInput {src: string; alt?: string}
export interface ImageViewerCallbacks {onClose?(): void}
export interface ImageViewerComposition {
  readonly part: DialogPart;
  open(input: Readonly<ImageViewerInput>): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** Caller-owned orchestration only: all sizing and zoom behavior are image-part rules. */
export function composeImageViewer(callbacks: ImageViewerCallbacks = {}): ImageViewerComposition {
  let alive = true,opened = false;
  const status = createTextPart({text: ''});
  const image = createZoomImagePart({onStatus(value) {if (alive) status.update({text: value.label});}});
  const out = createButtonPart({variant: 'secondary',label: '−',accessibleLabel: 'Zoom out',onAction: image.zoomOut});
  const into = createButtonPart({variant: 'secondary',label: '+',accessibleLabel: 'Zoom in',onAction: image.zoomIn});
  const fit = createButtonPart({variant: 'secondary',label: 'Fit',onAction: image.fit});
  const original = createButtonPart({variant: 'secondary',label: 'Original size',onAction: image.original});
  const toolbar = createMediaToolbarPart({status,actions: [out,into,fit,original]});
  function closed(): void {
    if (!alive || !opened) return;
    opened = false;image.clear();callbacks.onClose?.();
  }
  function dispose(): void {
    if (!alive) return;
    const notify = opened;alive = false;opened = false;image.clear();if (notify) callbacks.onClose?.();
  }
  const dialog = createDialogPart({purpose: 'image',title: 'Image',closeLabel: 'Close image',children: [image,toolbar],onClose: closed,onDispose: dispose});
  return {
    part: dialog,
    open(input) {
      if (!alive || !input.src) return;
      image.update({src: input.src,alt: input.alt ?? ''});dialog.update({title: input.alt || 'Image',closeLabel: 'Close image'});
      dialog.open();opened = dialog.isOpen();if (opened) image.fit();
    },
    close() {if (alive) {dialog.close();closed();}},
    isOpen: () => alive && opened && dialog.isOpen(),
    destroy() {if (alive) {dialog.close();dispose();dialog.destroy();}},
  };
}

/** Standalone validation adapter. Applications compose the genuine dialog part. */
export function mountImageViewer(mount: HTMLElement,callbacks: ImageViewerCallbacks = {},appearance: MountPartsOptions = {}): ImageViewerComposition {
  const viewer = composeImageViewer(callbacks);mountParts(mount,viewer.part,appearance);return viewer;
}
