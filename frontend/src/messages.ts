import type { Application, ConversationActionAvailability, ImageTarget } from './ui-contract.ts';
import type { ApiDownload } from './api.ts';
import type { Workspace } from './contract.generated.ts';
import type { AppView } from './feature-api.ts';

type API = {
    ui: Application;
    view: AppView;
    download: ApiDownload;
    disposed: () => boolean;
    messageActionAvailability: () => ConversationActionAvailability;
};

export function createMessagesUI(api: API) {
    const { ui, view: app, download } = api;
    let messagesSignature = '';
    let imageGeneration = 0;
    function renderWelcome(workspace?: Workspace): void {
        ui.workspace.updateWelcome({ workspace, hasApiKey: app.state.settings.hasApiKey, hasConnections: app.state.settings.hasConnections, modelName: app.state.settings.modelName || app.state.settings.model });
    }
    function clearHistoryImages(): void { imageGeneration++; }
    async function loadImage(target: ImageTarget): Promise<Blob | null> {
        const generation = imageGeneration;
        const blob = await download('/api/image', { id: target.conversationId, message: target.messageId, index: target.index });
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type))
            throw new Error('Invalid image attachment.');
        return generation === imageGeneration && !api.disposed() ? blob : null;
    }
    function renderMessages(workspace?: Workspace): void {
        ui.workspace.updateMessageAvailability(api.messageActionAvailability());
        const hasMessages = app.state.messages.length > 0;
        const signature = JSON.stringify([app.state.activeId, app.state.messages, app.state.running, app.state.pendingApproval?.id]);
        if (signature !== messagesSignature) {
            ui.workspace.updateConversation({
                id: app.state.activeId || '',
                messages: app.state.messages.map(message => ({
                    ...message,
                    actions: {
                        copy: (message.role === 'user' || (message.role === 'assistant' && message.status !== 'streaming')) && !!message.text ? message.role === 'user' ? 'Copy message' : 'Copy response' : false,
                        edit: message.role === 'user',
                        branch: message.role === 'assistant' && message.branchNodeId ? { key: message.branchNodeId } : undefined,
                    },
                })),
                working: app.state.running && !app.state.pendingApproval,
            });
            messagesSignature = signature;
            ui.workspace.pruneConversations(app.state.conversations.map(entry => entry.id));
        }
        if (!hasMessages) renderWelcome(workspace);
    }
    return {
        renderMessages, clearHistoryImages, loadImage, followLatest: ui.workspace.followLatest,
        destroy(): void { clearHistoryImages(); },
    };
}
