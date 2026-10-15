import type { ApiDownload } from './api.ts';
import type { Workspace } from './contract.generated.ts';
import { installConversationReader } from './conversation-reader.ts';
import type { AppView } from './feature-api.ts';
import { createMessageView } from './messages-view.ts';
import { createWelcomeView } from 'pith-ui';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type API = {
    view: AppView;
    download: ApiDownload;
    logo: string;
    disposed: () => boolean;
};
export function createMessagesUI(api: API) {
    const { view: app, download, logo } = api;
    let messagesSignature = '';
    let renderedActiveId: string | null = null;
    const conversationFolds = new Map<string, Map<string, boolean>>();
    const historyImages = new Map<string, Promise<string>>();
    let imageGeneration = 0;
    const reader = installConversationReader($('chat-scroll'), $('messages'), $('conversation-find'), $<HTMLButtonElement>('back-to-latest'));
    const messageView = createMessageView($('messages'));
    const logoTemplate = document.createElement('template');
    logoTemplate.innerHTML = logo;
    const welcome = createWelcomeView({ container: $('welcome'), logo: logoTemplate.content });
    function renderWelcome(workspace?: Workspace): void {
        welcome.update({ workspace, hasApiKey: app.state.settings.hasApiKey, hasConnections: app.state.settings.hasConnections, modelName: app.state.settings.modelName || app.state.settings.model });
        for (const button of welcome.element.querySelectorAll<HTMLElement>('[data-welcome-action]')) button.dataset.action = button.dataset.welcomeAction;
    }
    function clearHistoryImages(): void {
        imageGeneration++;
        for (const value of historyImages.values())
            void value.then((url) => URL.revokeObjectURL(url)).catch(() => { });
        historyImages.clear();
    }
    function loadHistoryImages(): void {
        for (const image of $('messages').querySelectorAll<HTMLImageElement>('img[data-image-key]')) {
            if (image.hasAttribute('src'))
                continue;
            const key = image.dataset.imageKey!;
            let value = historyImages.get(key);
            if (!value) {
                const generation = imageGeneration;
                value = download('/api/image', { id: app.state.activeId, message: image.dataset.messageId!, index: Number(image.dataset.imageIndex) }).then((blob) => {
                    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type))
                        throw new Error('Invalid image attachment.');
                    if (generation !== imageGeneration || api.disposed())
                        throw new Error('Conversation changed.');
                    return URL.createObjectURL(blob);
                });
                historyImages.set(key, value);
                const pending = value;
                void pending.catch(() => { if (historyImages.get(key) === pending)
                    historyImages.delete(key); });
            }
            void value.then((url) => { if (image.isConnected)
                image.src = url; }).catch(() => { if (image.isConnected) {
                image.alt = 'Image unavailable';
                image.classList.add('pui-image-unavailable');
            } });
        }
    }
    function renderMessages(workspace?: Workspace): void {
        const hasMessages = app.state.messages.length > 0;
        const signature = JSON.stringify([app.state.activeId, app.state.messages, app.state.running, app.state.pendingApproval?.id]);
        if (signature !== messagesSignature) {
            const changedConversation = renderedActiveId !== app.state.activeId;
            reader.beforeRender(app.state.activeId || '');
            $('welcome').hidden = hasMessages;
            $('messages').hidden = !hasMessages;
            const currentFolds = new Map(Array.from($('messages').querySelectorAll<HTMLDetailsElement>('[data-tool-fold]'), (element) => [element.dataset.toolFold!, element.open] as const));
            if (renderedActiveId)
                conversationFolds.set(renderedActiveId, currentFolds);
            const folds = changedConversation ? conversationFolds.get(app.state.activeId || '') || new Map<string, boolean>() : currentFolds;
            messageView.update(app.state.activeId || '', app.state.messages, app.state.running && !app.state.pendingApproval, folds);
            messagesSignature = signature;
            renderedActiveId = app.state.activeId;
            loadHistoryImages();
            reader.afterRender();
            reader.prune(app.state.conversations.map((entry) => entry.id));
            for (const id of conversationFolds.keys())
                if (!app.state.conversations.some((entry) => entry.id === id))
                    conversationFolds.delete(id);
        }
        if (!hasMessages)
            renderWelcome(workspace);
    }
    return {
        renderMessages, clearHistoryImages, followLatest: reader.followLatest,
        destroy(): void { clearHistoryImages(); reader.destroy(); messageView.destroy(); welcome.destroy(); },
    };
}
