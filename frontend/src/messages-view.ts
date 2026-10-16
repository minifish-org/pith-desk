import type { Message } from './contract.generated.ts';
import { createConversationView, type ConversationViewOptions } from 'pith-ui';
import { localFilePath } from './local-file-links.ts';

// Copy eligibility remains a host policy; action rendering and events belong to the view.
export function createMessageView(container: HTMLElement, options: Pick<ConversationViewOptions, 'onAction' | 'onCopyCode'> = {}) {
  const block = createConversationView({ ...options, container, markdown: (conversationId) => ({
    resolveLocalLink: (href) => {
      const path = conversationId ? localFilePath(href) : null;
      return path ? { path, conversationId } : null;
    },
  }) });
  return {
    update(id: string, messages: Message[], working: boolean, folds: Map<string, boolean>): void {
      block.update({ id, working, folds, messages: messages.map((message) => ({
        ...message,
        actions: {
          copy: (message.role === 'user' || (message.role === 'assistant' && message.status !== 'streaming')) && !!message.text ? message.role === 'user' ? 'Copy message' : 'Copy response' : false,
          edit: message.role === 'user',
          branch: message.role === 'assistant' && message.branchNodeId ? { key: message.branchNodeId } : undefined,
        },
      })) });
    },
    updateActionAvailability: block.updateActionAvailability,
    images: block.images,
    setImageState: block.setImageState,
    destroy: block.destroy,
  };
}
