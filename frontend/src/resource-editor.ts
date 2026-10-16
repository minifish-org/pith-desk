import { createFeatureStatus, createResourceEditor } from 'pith-ui';
import type { SDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { escape } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type API = Pick<SDKFeatureAPI, 'state' | 'request' | 'mutate' | 'workspaceBusy' | 'busy' | 'refreshResources' | 'confirm' | 'error'>;
export function createResourceUI(api: API, dialog: SDKDialog) {
    const { open } = dialog;
    async function resource(workspaceId: string, kind: string, path?: string) {
        const workspace = api.state().workspaces.find((entry) => entry.id === workspaceId);
        if (!workspace)
            return;
        const seq = open(path ? 'Edit workspace resource' : `Create ${kind}`, createFeatureStatus({message: 'Loading…'}));
        const content = path ? (await api.request('/api/resource-content', { query: { workspaceId: workspace.id, path } })).content : kind === 'skill' ? '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n' : kind === 'template' ? '---\ndescription: Describe this prompt.\n---\n\nHelp me with $@.\n' : '# Project instructions\n\n';
        if (!dialog.current(seq))
            return;
        const editable = !api.workspaceBusy(workspace.id) && (!path || path.startsWith(workspace.path.replace(/\/$/, '') + '/'));
        const editor = createResourceEditor({workspaceId: workspace.id, workspacePath: workspace.path, path, kind, content, editable, workspaceBusy: api.workspaceBusy(workspace.id)}, {idPrefix: '',onSubmit:async () => await save() ? {ok:true} : {ok:false,error:api.error()},onDelete:() => api.confirm({ title: 'Delete resource?', action: 'Delete resource', description: `Permanently delete <strong>${escape(path)}</strong> from this workspace?`, hint: 'The Markdown file will be removed from your computer.', scope: { workspaceId: workspace.id }, unavailable: () => api.busy() || api.workspaceBusy(workspace.id), run: () => save(true), error: api.error })});
        const editorSequence = open(editable ? (path ? 'Edit workspace resource' : `Create ${kind}`) : 'Workspace resource', editor);
        const save = async (remove = false) => {
            const draft = editor.read();
            const name = draft.name;
            let content = draft.content;
            if (!path && kind === 'skill')
                content = content.replace(/^name: my-skill$/m, `name: ${name}`);
            if (api.workspaceBusy(workspace.id) || api.busy())
                return false;
            if (await api.mutate('/api/resource', { workspaceId: workspace.id, kind, path: path || '', name, content, remove })) {
                if (!dialog.current(editorSequence)) return true;
                $<HTMLDialogElement>('sdk-dialog').close();
                await api.refreshResources();
                return true;
            }
            return false;
        };
    }
    return { resource };
}
