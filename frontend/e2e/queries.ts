/** Test-only semantic driver. It reads real controls; it never changes their DOM or state. */
export function controlQueries() {
    type Root = Document | Element | DocumentFragment;
    const all = (root: Root, selector: string) => Array.from(root.querySelectorAll(selector));
    const field = (root: Root, name: string) => all(root, 'label').filter((label) => label.textContent?.trim().replace(/\s*\*$/, '') === name).map(label => (label as HTMLLabelElement).control).filter((item): item is HTMLElement => item instanceof HTMLElement);
    const button = (root: Root, name: string) => all(root, 'button').filter(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name);
    const dialog = (root: Root, title?: string) => all(root, 'dialog').filter(item => !title || item.getAttribute('aria-label') === title || item.querySelector('h2,h3')?.textContent?.trim() === title);
    const error = (root: Root) => { const errors = all(root, '[role="alert"]'); return errors.filter(item => item.textContent?.trim()).slice(0, 1).concat(errors.some(item => item.textContent?.trim()) ? [] : errors.slice(0, 1)); };
    const labelNames: Record<string, string> = { 'composer-input': 'Message', 'history-search': 'Search conversation titles', 'mcp-name': 'Name', 'mcp-type': 'Connection type', 'mcp-url': 'Server URL', 'mcp-token': 'Bearer token (optional)', 'mcp-command': 'Installed executable', 'mcp-env': 'Environment overrides (JSON object, optional)', 'settings-provider': 'Provider', 'api-key': 'API key', 'base-url': 'API base URL', 'picker-provider': 'Provider', 'picker-model': 'Choose model', 'resource-name': 'Name', 'image-picker': '__native_picker' };
    const buttons: Record<string, string> = { 'save-settings': 'Save settings', 'send-button': 'Send message', 'choose-model': 'Use model', 'test-connection': 'Test connection', 'add-custom-model': 'Add model', 'delete-resource': 'Delete resource' };
    const modals: Record<string, string> = { 'settings-dialog': 'Settings', 'model-dialog': 'Choose a model', 'connections-dialog': 'Connections', 'workspace-dialog': 'Workspaces', 'oauth-dialog': 'Provider sign-in' };
    const rename: Record<string, string> = { '.pui-messages': '.pui-reading-area .pui-control-list', '.pui-message-footer': '.pui-message-frame-meta', '.pui-user-text': '.pui-message-frame[data-role="user"] .pui-message-frame-body > .pui-control-stack > .pui-control-text p', '.pui-draft-image': '.pui-image-attachment', '.pui-brand': '.pui-split-navigation .pui-pane-header > .pui-control-stack > .pui-actions', '.pui-topbar': '[aria-label="Conversation navigation"]', '.pui-composer-panels': '[aria-label="Task status and pending messages"]', '.pui-approval-arguments': '.pui-disclosure:has(>summary:text-is("Tool arguments"))', '.pui-user-message': '.pui-message-frame[data-role="user"]', '.pui-assistant-message': '.pui-message-frame[data-role="assistant"]', '.pui-history-row': '.pui-list-row', '.pui-composer': '.pui-drop-area', '.pui-tool-group': '.pui-disclosure', '.pui-tool-message': '.pui-disclosure', '.pui-history-image': '.pui-image-content img', '.pui-provider-login-status': 'dialog[open] .pui-notice:first-child', '.pui-owned-controls': 'dialog[open]' };
    function byID(root: Root, key: string): Element[] {
        if (labelNames[key]) {
            if (key === 'image-picker')
                return all(root, 'input[type=file]');
            if (key === 'composer-input')
                return all(root, '.pui-prompt textarea');
            return field(root, labelNames[key]);
        }
        if (buttons[key]) {
            if (key === 'send-button')
                return ['Send message', 'Queue message', 'Stop agent'].flatMap(name => button(root, name));
            if (key === 'test-connection')
                return ['Test connection', 'Cancel test'].flatMap(name => button(root, name));
            return button(root, buttons[key]);
        }
        if (modals[key])
            return dialog(root, modals[key]);
        if (['sdk-dialog', 'sdk-content'].includes(key))
            return dialog(root).filter(item => !['Settings', 'Connections', 'Workspaces', 'Provider sign-in', 'Choose a model'].includes(item.querySelector('h2,h3')?.textContent?.trim() ?? '') && !item.querySelector('h2,h3')?.textContent?.startsWith('Workspace resources') && !item.classList.contains('pui-image-viewer'));
        if (key === 'sidebar')
            return all(root, '.pui-split-navigation');
        if (key === 'chat-scroll')
            return all(root, '.pui-reader-scroll');
        if (key === 'conversation-find')
            return all(root, '.pui-reader-find');
        if (key === 'back-to-latest')
            return button(root, 'Back to latest');
        if (key === 'conversation-label')
            return all(root, '[aria-label="Conversation navigation"] .pui-control-text').slice(1, 2);
        if (key === 'composer-model')
            return all(root, '[aria-label="Message actions"] button').filter(item => !['Attach images', 'Send message', 'Queue message', 'Stop agent'].includes(item.getAttribute('aria-label') ?? '') && !item.closest('.pui-field'));
        if (key === 'oauth-value')
            return all(root, 'dialog[open] form input,dialog[open] form select');
        if (key === 'oauth-answer')
            return all(root, 'dialog[open] form');
        if (key === 'image-dialog')
            return all(root, '.pui-image-viewer');
        if (key === 'resources-dialog' || key === 'resources-content')
            return dialog(root).filter(item => item.querySelector('h2,h3')?.textContent?.startsWith('Workspace resources'));
        if (key === 'provider-advanced')
            return all(root, 'dialog[open] details').filter(item => item.querySelector('summary')?.textContent === 'Advanced');
        if (key === 'mcp-form-title')
            return all(root, 'dialog[open] .pui-control-text h3').filter(item => /^(?:Add connection|Edit )/.test(item.textContent ?? ''));
        if (key === 'mcp-env-visibility') {
            const input = field(root, labelNames['mcp-env'])[0];
            return input?.parentElement ? button(input.parentElement, 'Show').concat(button(input.parentElement, 'Hide')) : [];
        }
        if (key === 'custom-models')
            return all(root, 'dialog[open] .pui-control-list');
        if (key === 'appearance-error') {
            const node = field(root, 'Appearance')[0];
            return node?.closest('.pui-field') ? all(node.closest('.pui-field')!, '[role=alert]') : [];
        }
        if (key === 'resource-form')
            return all(root, 'dialog[open] form');
        if (key === 'run-status')
            return all(root, '.pui-disclosure').filter(item => /^(?:Run details|Finished|Working|Stopped|Starting|Waiting for approval)/.test(item.querySelector('summary')?.textContent ?? ''));
        if (key === 'artifacts-control')
            return all(root, '.pui-pane-header .pui-popover').map(node => node.parentElement!).filter(Boolean);
        if (key === 'image-guidance')
            return all(root, '.pui-pane-footer .pui-notice').filter(item => /image|attachment/i.test(item.textContent ?? ''));
        if (key === 'connection-status')
            return all(root, '.pui-split-navigation [role=status]');
        if (key === 'task-failure')
            return all(root, '.pui-pane-footer .pui-notice-error').filter(item => !!item.textContent?.trim());
        if (key === 'connection-test-result')
            return all(root, 'dialog[open] .pui-notice').filter(item => /connected|connection/i.test(item.textContent ?? ''));
        if (key.endsWith('error'))
            return error(key === 'inline-error' ? root : dialog(root).find(item => (item as HTMLDialogElement).open) ?? root);
        return [];
    }
    function queryAll(root: Root, selector: string): Element[] {
        const id = /^([\w.-]*)\[id\$=["']?([\w-]+)["']?\](.*)$/.exec(selector);
        if (id) {
            let nodes = byID(root, id[2]);
            if (id[1])
                nodes = nodes.filter(node => node.matches(id[1]));
            const rest = id[3].trim();
            if (!rest)
                return nodes;
            if (id[2] === 'custom-models' && rest === 'fieldset')
                return nodes.flatMap(node => all(node, ':scope > .pui-form-section'));
            return nodes.flatMap(node => queryAll(node, rest));
        }
        if (selector === '[data-approval="deny"]')
            return button(root, 'Deny');
        if (selector === '[data-approval="always"]')
            return button(root, 'Always allow workspace changes');
        if (selector === '[data-approval="allow"]')
            return button(root, 'Allow this action');
        if (selector === '.pui-branch-node')
            return all(dialog(root, 'Conversation branches')[0] ?? root, '.pui-list-row');
        if (selector === '.pui-branch-node p')
            return all(dialog(root, 'Conversation branches')[0] ?? root, '.pui-control-list > .pui-control-stack > .pui-control-text p');
        if (selector === '.pui-provider-login-status')
            return all(dialog(root, 'Provider sign-in')[0] ?? root, '.pui-notice').filter(node => !!node.textContent?.trim()).slice(0, 1);
        if (selector === '.pui-approval-arguments')
            return all(root, 'details').filter(node => node.querySelector('summary')?.textContent === 'Tool arguments');
        if (selector === '.pui-owned-controls dialog[open]')
            return dialog(root).filter(node => (node as HTMLDialogElement).open);
        if (selector === '[data-close]')
            return all(root, '.pui-dialog-heading button[aria-label^="Close "]').concat(button(root, 'Close')).slice(0, 1);
        if (selector === '[data-mcp-remove]')
            return all(dialog(root, 'Connections')[0] ?? root, '.pui-control-list').flatMap(node => button(node, 'Delete')).slice(0, 1);
        if (selector === '.pui-tool-group > summary')
            return all(root, '.pui-reader-scroll > .pui-control-list > .pui-control-stack > details > summary');
        if (selector === '.pui-tool-group')
            return all(root, '.pui-reader-scroll > .pui-control-list > .pui-control-stack > details');
        if (selector === '.pui-tool-message > summary')
            return all(root, '.pui-reader-scroll > .pui-control-list > .pui-control-stack > details details > summary');
        if (selector === '[data-reading-id="tool-a"]')
            return all(root, '.pui-reader-scroll details details').filter(node => node.textContent?.includes('Completed tool'));
        if (selector === '.pui-draft-image img')
            return all(root, '.pui-image-attachment > button > img');
        if (selector === '.pui-file-path')
            return all(root, ':scope > .pui-dialog-body > .pui-control-stack > .pui-control-stack > .pui-control-text > pre');
        const sdk = /^\[data-sdk=["']([^"']+)["']\](?:\[data-path\])?$/.exec(selector);
        if (sdk) {
            const names: Record<string, string> = { login: 'Sign in with provider', custom: 'Edit models and prices', 'remove-connection': 'Remove connection', resource: 'Edit workspace instructions' };
            return button(root, names[sdk[1]] ?? sdk[1]);
        }
        const mcp = /^\[data-mcp-(edit|remove)\]$/.exec(selector);
        if (mcp)
            return button(dialog(root, 'Connections')[0] ?? root, mcp[1] === 'edit' ? 'Edit' : 'Delete');
        const named = /^\[data-(conversation|new-workspace|conversation-menu)=["']([^"']+)["']\]$/.exec(selector);
        if (named) {
            if (named[1] === 'conversation')
                return button(root, named[2] === 'other-conversation' ? 'Other conversation' : 'Conversation ' + named[2]);
            if (named[1] === 'new-workspace')
                return button(root, 'New conversation in Review workspace');
            return button(root, 'Conversation actions for Conversation ' + named[2]);
        }
        const action = /^\[data-action=["']?(\w[\w-]*)["']?\]$/.exec(selector);
        if (action) {
            const names: Record<string, string> = { settings: 'Settings', connections: 'Connections', resources: 'Workspace resources', workspace: 'Manage workspaces', model: 'Choose model', history: 'Conversation branches', continue: 'Review and continue', 'new-mcp': 'New connection', 'refresh-mcp': 'Refresh' };
            return button(root, names[action[1]] ?? action[1]);
        }
        const messageAction = /^\[data-(copy-message|edit-message)=["']([^"']+)["']\]$/.exec(selector);
        if (messageAction) {
            const row = root.querySelector('[data-reading-id="' + CSS.escape(messageAction[2]) + '"]');
            return row ? button(row, messageAction[1] === 'edit-message' ? 'Edit message' : row.getAttribute('data-role') === 'assistant' ? 'Copy response' : 'Copy message') : [];
        }
        const queue = /^\[data-queue-action=["'](edit|delete|steer)["']\]$/.exec(selector);
        if (queue)
            return button(root, { edit: 'Edit pending message', delete: 'Remove pending message', steer: 'Send as steering' }[queue[1]]);
        for (const [from, to] of Object.entries(rename))
            selector = selector.replaceAll(from, to);
        try {
            return all(root, selector);
        }
        catch {
            return [];
        }
    }
    return { query: (root: Root, selector: string) => queryAll(root, selector)[0] ?? null, queryAll };
}
declare global {
    interface Window {
        uiQuery<T extends Element = HTMLElement>(selector: string): T | null;
        uiQueryAll<T extends Element = HTMLElement>(selector: string): T[];
    }
}
