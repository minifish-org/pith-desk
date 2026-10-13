import type { ApiDownload } from './api.ts';
import type { Workspace } from './contract.generated.ts';
import { installConversationReader } from './conversation-reader.ts';
import type { AppView } from './feature-api.ts';
import { createMessageView } from './messages-view.ts';
import { escape, icon } from './ui.ts';
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
    function renderWelcome(workspace?: Workspace): void {
        const ready = !!workspace && app.state.settings.hasApiKey;
        $('welcome').innerHTML = `
    <div class="welcome-mark">${logo}</div>
    <p class="eyebrow">YOUR LOCAL WORK COMPANION</p>
    <h1>${ready ? 'What are we working on?' : 'Your work. A little more possible.'}</h1>
    <p class="welcome-description">An agent that works alongside you, with your files<br class="desktop-break"> and the tools you choose.</p>
    ${!ready ? `<div class="setup-card">
      <div class="setup-card-heading">Make yourself at home <span>Two quick steps</span></div>
      <button class="setup-step" data-action="${app.state.settings.hasConnections ? 'model' : 'settings'}"><span class="step-number ${app.state.settings.hasApiKey ? 'complete' : ''}">${app.state.settings.hasApiKey ? icon('check') : '1'}</span><span><strong>${app.state.settings.hasApiKey ? 'Model selected' : app.state.settings.hasConnections ? 'Choose a model' : 'Connect a provider'}</strong><small>${app.state.settings.hasApiKey ? escape(app.state.settings.modelName || app.state.settings.model) : app.state.settings.hasConnections ? 'Your provider connection is ready' : 'Bring your provider API key'}</small></span>${icon('chevron')}</button>
      <button class="setup-step" data-action="workspace"><span class="step-number ${workspace ? 'complete' : ''}">${workspace ? icon('check') : '2'}</span><span><strong>${workspace ? escape(workspace.name) : 'Choose a workspace'}</strong><small>${workspace ? escape(workspace.path) : 'A folder Pith can help you work in'}</small></span>${icon('chevron')}</button>
    </div>` : `<div class="welcome-workspace">${icon('folder')}<span>Working in <strong>${escape(workspace.name)}</strong></span><button class="secondary-button" type="button" data-action="workspace">Change</button></div>
    <div class="suggestions"><button data-prompt="Explore this workspace and give me a concise overview of its files.">${icon('file')}Explore my workspace</button><button data-prompt="Help me plan a task. Start by asking what I want to accomplish.">${icon('chat')}Think through a task</button><button data-prompt="I'd like help creating a document in this workspace. Ask me what it should cover.">${icon('plus')}Create something</button></div>`}
    <div class="welcome-footnote">${icon('shield')}Local workspace. Your choice of model.</div>
  `;
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
                image.classList.add('image-unavailable');
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
            messageView.update(app.state.activeId || '', app.state.messages, app.state.running, folds, app.state.running && !app.state.pendingApproval);
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
    return { renderMessages, clearHistoryImages, followLatest: reader.followLatest };
}
