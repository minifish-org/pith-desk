import { installConversationReader as installReader } from 'pith-ui';
export { findRanges, type TextRange } from 'pith-ui';

export function installConversationReader(scroll: HTMLElement, messages: HTMLElement, bar: HTMLElement, latest: HTMLButtonElement) {
  return installReader(scroll, messages, bar, latest, {
    isKeyboardBlocked: () => !!document.querySelector('dialog[open]'),
  });
}
