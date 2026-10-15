import type { Message } from './contract.generated.ts';
import { createConversationView } from 'pith-ui';
import { localFilePath } from './local-file-links.ts';

// Preserve host action policy and existing event routing while sharing rendering.
export function createMessageView(container: HTMLElement) {
  const block = createConversationView({ container, markdown: (conversationId) => ({
    resolveLocalLink: (href) => {
      const path = conversationId ? localFilePath(href) : null;
      return path ? { path, conversationId } : null;
    },
  }) });
  const decorated = new WeakSet<HTMLButtonElement>();
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
      for (const action of container.querySelectorAll<HTMLButtonElement>('[data-message-action]')) {
        if (decorated.has(action)) continue;
        decorated.add(action);
        if (action.dataset.messageAction === 'copy') action.dataset.copyMessage = action.dataset.messageActionId;
        if (action.dataset.messageAction === 'edit') { action.dataset.editMessage = action.dataset.messageActionId; action.dataset.idleAction = ''; }
        if (action.dataset.messageAction === 'branch') { action.dataset.sdk = 'branch'; action.dataset.sdkIdle = ''; action.dataset.node = action.dataset.branchKey; }
      }
    },
    destroy: block.destroy,
  };
}
