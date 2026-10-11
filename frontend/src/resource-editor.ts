import type { SDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { escape } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type API = Pick<SDKFeatureAPI, 'state' | 'request' | 'workspaceBusy' | 'busy' | 'refreshResources' | 'confirm' | 'error'>;
export function createResourceUI(api: API, dialog: SDKDialog) {
    const { open, act, fail } = dialog;
    async function resource(workspaceId: string, kind: string, path?: string) {
        const workspace = api.state().workspaces.find((entry) => entry.id === workspaceId);
        if (!workspace)
            return;
        const seq = open(path ? 'Edit workspace resource' : `Create ${kind}`, '<p>Loading…</p>');
        const content = path ? (await api.request('/api/resource-content', { query: { workspaceId: workspace.id, path } })).content : kind === 'skill' ? '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n' : kind === 'template' ? '---\ndescription: Describe this prompt.\n---\n\nHelp me with $@.\n' : '# Project instructions\n\n';
        if (!dialog.current(seq))
            return;
        const editable = !api.workspaceBusy(workspace.id) && (!path || path.startsWith(workspace.path.replace(/\/$/, '') + '/'));
        open(editable ? (path ? 'Edit workspace resource' : `Create ${kind}`) : 'Workspace resource', `<p class="file-path">${escape(path || workspace.path)}</p>${!editable ? `<p>${api.workspaceBusy(workspace.id) ? 'Stop this workspace’s task before editing resources.' : 'Inherited instructions are read-only here. Add workspace instructions to specialize them.'}</p>` : ''}<form id="resource-form">${!path && kind !== 'instructions' ? '<label class="field-label">Name<input id="resource-name" required pattern="[A-Za-z0-9]([A-Za-z0-9_]|-)*" placeholder="my-resource" /></label>' : ''}<label class="field-label" for="resource-body">Markdown</label><textarea id="resource-body" class="resource-editor" ${!editable ? 'readonly' : ''}>${escape(content)}</textarea><div class="modal-footer">${path && editable ? '<button type="button" id="delete-resource" class="secondary-button destructive-button">Delete resource</button>' : ''}<button type="button" class="secondary-button" data-close="sdk-dialog">${editable ? 'Cancel' : 'Close'}</button>${editable ? `<button type="submit" class="primary-button" data-idle-action data-idle-workspace="${escape(workspace.id)}">Save</button>` : ''}</div></form>`);
        const save = async (remove = false) => {
            const name = ($('resource-name') as HTMLInputElement | null)?.value || '';
            let content = $<HTMLTextAreaElement>('resource-body').value;
            if (!path && kind === 'skill')
                content = content.replace(/^name: my-skill$/m, `name: ${name}`);
            if (api.workspaceBusy(workspace.id) || api.busy())
                return false;
            if (await act('/api/resource', { workspaceId: workspace.id, kind, path: path || '', name, content, remove })) {
                $<HTMLDialogElement>('sdk-dialog').close();
                await api.refreshResources();
                return true;
            }
            return false;
        };
        $('resource-form').onsubmit = (e) => { e.preventDefault(); void save(); };
        const remove = document.getElementById('delete-resource');
        if (remove)
            remove.onclick = () => api.confirm({ title: 'Delete resource?', action: 'Delete resource', description: `Permanently delete <strong>${escape(path)}</strong> from this workspace?`, hint: 'The Markdown file will be removed from your computer.', scope: { workspaceId: workspace.id }, unavailable: () => api.busy() || api.workspaceBusy(workspace.id), run: () => save(true), error: api.error });
    }
    return { resource };
}
