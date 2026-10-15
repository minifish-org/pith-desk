import { createApprovalPanel, createPermissionControl, createFullAccessConfirmation, createRuntimePanel, createTaskFailure } from 'pith-ui';
import type { ApiDownload, ApiMutate, ApiRequest } from './api.ts';
import type { PermissionMode, RuntimeStatus, Workspace } from './contract.generated.ts';
import { formatCost } from './costs.ts';
import type { AppView, UIActivity } from './feature-api.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type API = {
    view: AppView;
    activity: UIActivity;
    request: ApiRequest;
    download: ApiDownload;
    mutate: ApiMutate;
    render: () => void;
    selectedWorkspace: () => Workspace | undefined;
    renderCosts: () => void;
};
export function createTaskControls(api: API) {
    const { view: app, activity, request, download, mutate, render, selectedWorkspace } = api;
    let approvalSignature = '';
    let fullAccessTargetId: string | null = null;
    const emptyRuntime = {visible: false, summary: '', duration: '', speed: '', inputTokens: '', outputTokens: '', cacheRead: '', cacheWrite: '', contextTokens: '', contextWindow: '', compactions: '', toolFailures: '', recordedCost: '', latestCost: ''};
    const runtimePanel = createRuntimePanel(emptyRuntime, {element: $('run-status'), idPrefix: ''});
    const failurePanel = createTaskFailure({visible: false, message: '', advice: '', canContinue: false}, {element: $('task-failure')});
    const approvalPanel = createApprovalPanel({approval: null}, {element: $('approval'), idPrefix: ''});
    const permissionControl = createPermissionControl({mode: 'ask', description: '', disabled: true}, {element: $('permission-control'), descriptionElement: $('permission-description')});
    let fullAccessPanel: ReturnType<typeof createFullAccessConfirmation> | undefined;
    const activeRunPhases = new Set(['starting', 'working', 'tool', 'retrying', 'compacting']);
    function activePermissionMode(): PermissionMode {
        const mode = app.state.conversations.find((entry) => entry.id === app.state.activeId)?.permissionMode;
        return mode === 'workspace-write' || mode === 'full-access' ? mode : 'ask';
    }
    function taskElapsedMs(status: RuntimeStatus): number {
        const timing = status.timing;
        if (!timing?.startedAt)
            return 0;
        // Anchor to the host's monotonic duration; app downtime never becomes run time.
        const live = app.state.running && activeRunPhases.has(status.phase) && !timing.partial;
        return Math.max(0, timing.elapsedMs + (live ? performance.now() - app.receivedAt : 0));
    }
    function formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60)
            return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return `${minutes}m ${seconds % 60}s`;
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
    }
    function renderRuntimeTiming(): void {
        const status = app.state.runtime;
        if (!status?.model)
            return;
        const phases: Record<string, string> = { starting: 'Starting', working: 'Working', tool: 'Using a tool', retrying: 'Retrying model request', compacting: 'Summarizing context', complete: 'Finished', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Needs attention' };
        const timing = status.timing;
        const elapsed = taskElapsedMs(status);
        const duration = timing?.startedAt ? `${timing.partial ? '≥' : ''}${formatDuration(elapsed)}` : 'Not recorded';
        const speed = timing?.startedAt && !timing.partial && timing.outputTokens > 0 && elapsed > 0
            ? new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(timing.outputTokens * 1000 / elapsed) : '—';
        const tokens = new Intl.NumberFormat().format(Math.round(status.usage.total || 0));
        runtimePanel.updateTiming({summary: `${app.state.pendingApproval ? 'Waiting for approval' : phases[status.phase] || 'Ready'} · ${status.model} · ${tokens} tokens · ${formatCost(status.cost)}${timing?.startedAt ? ` · ${duration} · ${speed} output tokens/s` : ''}`, duration, speed});
    }

    function renderRuntime(): void {
        const status = app.state.runtime;
        if (status?.model) {
            const n = (value: number) => new Intl.NumberFormat().format(Math.round(value || 0));
            runtimePanel.update({...emptyRuntime, visible: true, provider: status.provider, thinkingLevel: status.thinkingLevel, inputTokens: n(status.usage.input), outputTokens: n(status.usage.output), cacheRead: n(status.usage.cacheRead), cacheWrite: n(status.usage.cacheWrite), contextTokens: n(status.contextTokens), contextWindow: n(status.contextWindow), compactions: n(status.compactions), toolFailures: n(status.toolFailures), recordedCost: formatCost(status.cost), latestCost: formatCost(status.cost, true)});
            renderRuntimeTiming();
        } else runtimePanel.update(emptyRuntime);
        api.renderCosts();
        const failure = app.state.failure;
        failurePanel.update({visible: !!failure && !app.state.running, message: failure?.message || '', advice: failure?.advice || '', canContinue: !!failure?.canContinue, workspaceId: selectedWorkspace()?.id});
    }

    async function exportDiagnostics(): Promise<void> {
        if (activity.busy)
            return;
        activity.busy = true;
        render();
        try {
            const result = await request('/api/diagnostics', {});
            if (!result.native) {
                const url = URL.createObjectURL(await download('/api/diagnostics'));
                const link = document.createElement('a');
                link.href = url;
                link.download = 'pith-desk-diagnostics.json';
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        }
        catch (error) {
            activity.error = error instanceof Error ? error.message : String(error);
        }
        finally {
            activity.busy = false;
            render();
        }
    }
    function renderApproval(): void {
        const approval = app.state.pendingApproval;
        const signature = JSON.stringify([approval, activity.busy]);
        if (signature === approvalSignature)
            return;
        approvalSignature = signature;
        const warning = approval?.warning || (approval?.toolName === 'run_command' ? 'This command runs with your normal computer permissions. It may access or change files outside this workspace.' : '');
        approvalPanel.update({approval: approval ? {...approval, warning, canAlwaysAllow: approval.toolName === 'write_file' || approval.toolName === 'edit_file', argsText: typeof approval.args === 'string' ? approval.args : JSON.stringify(approval.args, null, 2)} : null, disabled: activity.busy});
    }

    function renderPermissions(): void {
        const mode = activePermissionMode();
        const descriptions: Record<PermissionMode, string> = {
            ask: 'Pith can read workspace files. Changes, commands, and external connection tools require approval.',
            'workspace-write': 'Workspace file changes are allowed. Commands and external connection tools still require approval.',
            'full-access': 'Full access: all enabled tools, including external connections, run without asking. There is no OS sandbox.',
        };
        permissionControl.update({mode, description: descriptions[mode], disabled: !app.loaded || !app.state.activeId || activity.busy});
        const dialog = $<HTMLDialogElement>('permissions-dialog');
        if (dialog.open && fullAccessTargetId !== app.state.activeId) {
            dialog.close();
            activity.error = 'The active conversation changed. Choose its permissions again.';
        }
        fullAccessPanel?.update({disabled: activity.busy || !fullAccessTargetId || fullAccessTargetId !== app.state.activeId});
    }

    function confirmFullAccess(id: string): void {
        fullAccessTargetId = id;
        const conversation = app.state.conversations.find((entry) => entry.id === id);
        fullAccessPanel?.destroy();
        fullAccessPanel = createFullAccessConfirmation({title: conversation?.title || 'this conversation'}, {idPrefix: ''});
        $('permissions-content').replaceChildren(fullAccessPanel.element);
        $<HTMLDialogElement>('permissions-dialog').showModal();
        $('enable-full-access').addEventListener('click', async () => {
            const targetId = fullAccessTargetId;
            if (!targetId || targetId !== app.state.activeId || activity.busy)
                return;
            if (await mutate('/api/permissions', { id: targetId, mode: 'full-access' }))
                $<HTMLDialogElement>('permissions-dialog').close();
            else if ($<HTMLDialogElement>('permissions-dialog').open)
                $('permissions-error').textContent = activity.error;
        });
    }
    return { activePermissionMode, taskElapsedMs, formatDuration, renderRuntimeTiming, renderRuntime, exportDiagnostics, renderApproval, renderPermissions, confirmFullAccess, closePermissions() { fullAccessTargetId = null; }, tick() { if (app.state.running && app.state.runtime && activeRunPhases.has(app.state.runtime.phase))
            renderRuntimeTiming(); } };
}
