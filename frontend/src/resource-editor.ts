import type {AppResourceKind, ResourceDraft} from 'pith-ui/app';
import type {SDKFeatureAPI} from './sdk-feature-api.ts';

type API = Pick<SDKFeatureAPI, 'ui' | 'state' | 'request' | 'mutate' | 'workspaceBusy' | 'busy' | 'refreshResources' | 'confirm' | 'error'>;
export function createResourceUI(api: API) {
    let generation = 0;
    async function resource(workspaceId: string, kind: AppResourceKind, path?: string): Promise<void> {
        const workspace = api.state().workspaces.find(entry => entry.id === workspaceId);
        if (!workspace) return;
        const sequence = ++generation;
        const loading = api.ui.resources.openEditorLoading({kind, path});
        const currentLoading = () => sequence === generation && loading.isOpen() && api.state().workspaces.some(entry => entry.id === workspace.id);
        let content: string;
        try {
            content = path ? (await api.request('/api/resource-content', {query: {workspaceId: workspace.id, path}})).content : kind === 'skill' ? '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n' : kind === 'template' ? '---\ndescription: Describe this prompt.\n---\n\nHelp me with $@.\n' : '# Project instructions\n\n';
        } catch (error) {if (currentLoading()) loading.fail(error instanceof Error ? error.message : String(error)); return;}
        if (!currentLoading()) return;
        const editable = !api.workspaceBusy(workspace.id) && (!path || path.startsWith(workspace.path.replace(/\/$/, '') + '/'));
        const editor = api.ui.resources.openEditor({workspaceId: workspace.id, workspacePath: workspace.path, path, kind, content, editable, workspaceBusy: api.workspaceBusy(workspace.id)}, {
            onSubmit: async draft => await save(draft) ? {ok: true} : {ok: false, error: api.error()},
            onDelete: () => api.confirm({title: 'Delete resource?', action: 'Delete resource', description: {before: 'Permanently delete ', subject: path, after: ' from this workspace?'}, hint: 'The Markdown file will be removed from your computer.', scope: {workspaceId: workspace.id}, unavailable: () => api.busy() || api.workspaceBusy(workspace.id), run: () => save(editor.read(), true), error: api.error}),
        });
        async function save(draft: ResourceDraft, remove = false): Promise<boolean> {
            const name = draft.name;
            let content = draft.content;
            if (!path && kind === 'skill') content = content.replace(/^name: my-skill$/m, `name: ${name}`);
            if (api.workspaceBusy(workspaceId) || api.busy()) return false;
            const saved = await api.mutate('/api/resource', {workspaceId, kind, path: path || '', name, content, remove});
            if (!saved) return false;
            if (sequence !== generation || !editor.isOpen()) return true;
            editor.close();
            // The write is complete even if its following inventory read fails.
            try {await api.refreshResources();} catch { /* Inventory reads report their own feedback; the write is already complete. */ }
            return true;
        }
    }
    return {resource, destroy() {generation++;}};
}
