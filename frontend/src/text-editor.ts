import {createTextEditDialog, type TextEditDialog, type TextEditOptions} from 'pith-ui';
import type {Application} from './ui-types';

export type TextEditor = Pick<TextEditDialog, 'update' | 'read' | 'focus' | 'close' | 'isOpen' | 'destroy'>;

/** Coordinate application ownership; the library owns all fields and interaction. */
export function openTextEditor(ui: Application, value: string, options: TextEditOptions): TextEditor {
  let owner: {destroy(): void} | undefined;
  const dialog = createTextEditDialog({...options, onClose() {owner?.destroy(); owner = undefined; options.onClose?.();}});
  owner = ui.attachDialog(dialog);
  dialog.open({value});
  return {update: dialog.update, read: dialog.read, focus: dialog.focus, close: dialog.close, isOpen: dialog.isOpen,
    destroy() {owner?.destroy(); owner = undefined;}};
}
