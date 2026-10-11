import type { ApiDownload, ApiMutate, ApiRequest } from './api.ts';
import type { PermissionMode, RuntimeStatus, Workspace } from './contract.generated.ts';
import { formatCost } from './costs.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { mountPagedPreview } from './paged-preview.ts';
import { escape, icon } from './ui.ts';
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
        $('run-status-summary').textContent = `${app.state.pendingApproval ? 'Waiting for approval' : phases[status.phase] || 'Ready'} · ${status.model} · ${tokens} tokens · ${formatCost(status.cost)}${timing?.startedAt ? ` · ${duration} · ${speed} output tokens/s` : ''}`;
        const durationValue = document.getElementById('runtime-duration');
        const speedValue = document.getElementById('runtime-speed');
        if (durationValue)
            durationValue.textContent = duration;
        if (speedValue)
            speedValue.textContent = speed;
    }
    function renderRuntime(): void {
        const status = app.state.runtime;
        $('run-status').hidden = !status?.model;
        if (status?.model) {
            const n = (value: number) => new Intl.NumberFormat().format(Math.round(value || 0));
            $('runtime-values').innerHTML = `<dl>${status.provider ? `<dt>Provider</dt><dd>${escape(status.provider)}</dd>` : ''}${status.thinkingLevel ? `<dt>Thinking effort</dt><dd>${escape(status.thinkingLevel)}</dd>` : ''}<dt>Latest task duration</dt><dd id="runtime-duration"></dd><dt>Avg. output tokens/s</dt><dd id="runtime-speed"></dd><dt>Session input / output</dt><dd>${n(status.usage.input)} / ${n(status.usage.output)}</dd><dt>Cache read / write</dt><dd>${n(status.usage.cacheRead)} / ${n(status.usage.cacheWrite)}</dd><dt>Estimated conversation context</dt><dd>~${n(status.contextTokens)} / ${n(status.contextWindow)} tokens</dd><dt>Context summaries</dt><dd>${n(status.compactions)}</dd><dt>Tool failures recorded</dt><dd>${n(status.toolFailures)}</dd><dt>Recorded cost (USD)</dt><dd>${escape(formatCost(status.cost))}</dd><dt>Latest task (USD)</dt><dd>${escape(formatCost(status.cost, true))}</dd><dt>Execution</dt><dd>Codemode enabled · durable local task journal</dd></dl><p>Duration and average speed cover the latest task, including tools and waits. Speed uses reported output tokens, including reasoning, retries and summaries; input, cache and earlier tasks are excluded. An interrupted checkpoint shows only a lower bound for duration. Session token figures come from Pith records. Context excludes system instructions and tool schemas. Costs estimate recorded requests; unknown prices and older unrecorded requests are excluded. This is not a provider bill.</p>`;
            renderRuntimeTiming();
        }
        api.renderCosts();
        const failure = app.state.failure;
        $('task-failure').hidden = !failure || app.state.running;
        $('task-failure').innerHTML = failure && !app.state.running ? `<strong>${escape(failure.message)}</strong><p>${escape(failure.advice)}</p><div>${failure.canContinue ? '<button class="secondary-button" type="button" data-action="continue" data-idle-action data-idle-workspace="${escape(selectedWorkspace()?.id)}">Review and continue</button>' : '<button class="secondary-button" type="button" data-action="settings">Check model settings</button>'}<button class="secondary-button" type="button" data-action="diagnostics">Save diagnostics</button></div>` : '';
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
        const canAlwaysAllow = approval?.toolName === 'write_file' || approval?.toolName === 'edit_file';
        const preview = approval?.preview;
        const previewBody = preview?.error ? `<p class="preview-note" role="status">${escape(preview.error)}</p>` : preview ? `<div id="approval-diff-preview"></div>${preview.truncated ? '<p class="preview-note">Preview shortened. Expand Tool arguments for the complete change.</p>' : ''}` : '';
        const previewMarkup = preview ? `<div class="approval-file"><strong>${preview.kind === 'create' ? 'Create file' : 'Modify file'}</strong><code>${escape(preview.path)}</code></div>${previewBody}` : '';
        const args = `<div id="approval-args-preview"></div>`;
        $('approval').innerHTML = approval ? `<section class="approval-card" aria-label="Tool approval required"><div class="approval-heading">${icon('shield')}<div><strong>Pith needs your permission</strong><span>Review this action before it runs.</span></div><span class="approval-badge">${escape(approval.toolName)}</span></div>${warning ? `<p class="approval-warning">${escape(warning)}</p>` : ''}${previewMarkup}${preview ? `<details class="approval-arguments" ${preview.error ? 'open' : ''}><summary>Tool arguments</summary>${args}</details>` : args}${canAlwaysAllow ? '<p class="approval-scope">Workspace permission applies to this conversation. Commands and external connection tools still need approval.</p>' : ''}<div class="approval-actions"><button class="secondary-button" data-approval="deny" ${activity.busy ? 'disabled' : ''}>Deny</button>${canAlwaysAllow ? `<button class="secondary-button always-allow-button" data-approval="always" ${activity.busy ? 'disabled' : ''}>Always allow workspace changes</button>` : ''}<button class="primary-button" data-approval="allow" ${activity.busy ? 'disabled' : ''}>${icon('check')}Allow this action</button></div></section>` : '';
        for (const button of $('approval').querySelectorAll<HTMLButtonElement>('[data-approval]'))
            button.dataset.approvalId = approval?.id || '';
        if (preview && !preview.error)
            mountPagedPreview($('approval-diff-preview'), preview.diff || 'No content changes.', 'diff');
        if (approval) {
            const argsContainer = $('approval-args-preview');
            const details = argsContainer.closest('details');
            let loaded = false;
            const showArgs = () => {
                if (loaded || (details && !details.open))
                    return;
                loaded = true;
                mountPagedPreview(argsContainer, typeof approval.args === 'string' ? approval.args : JSON.stringify(approval.args, null, 2), 'text');
            };
            details?.addEventListener('toggle', showArgs);
            showArgs();
        }
    }
    function renderPermissions(): void {
        const mode = activePermissionMode();
        const selector = $<HTMLSelectElement>('permission-mode');
        selector.value = mode;
        selector.disabled = !app.loaded || !app.state.activeId || activity.busy;
        $('permission-control').classList.toggle('full-access', mode === 'full-access');
        const descriptions: Record<PermissionMode, string> = {
            ask: 'Pith can read workspace files. Changes, commands, and external connection tools require approval.',
            'workspace-write': 'Workspace file changes are allowed. Commands and external connection tools still require approval.',
            'full-access': 'Full access: all enabled tools, including external connections, run without asking. There is no OS sandbox.',
        };
        $('permission-description').textContent = descriptions[mode];
        $('permission-description').classList.toggle('full-access-note', mode === 'full-access');
        const dialog = $<HTMLDialogElement>('permissions-dialog');
        if (dialog.open && fullAccessTargetId !== app.state.activeId) {
            dialog.close();
            activity.error = 'The active conversation changed. Choose its permissions again.';
        }
        const confirm = document.getElementById('enable-full-access') as HTMLButtonElement | null;
        if (confirm)
            confirm.disabled = activity.busy || !fullAccessTargetId || fullAccessTargetId !== app.state.activeId;
    }
    function confirmFullAccess(id: string): void {
        fullAccessTargetId = id;
        const conversation = app.state.conversations.find((entry) => entry.id === id);
        $('permissions-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">CONVERSATION PERMISSIONS</span><h2 id="full-access-title">Enable full access?</h2></div><button class="quiet-icon" data-close="permissions-dialog" aria-label="Cancel full access">${icon('close')}</button></div><p class="modal-description">Give Pith permission to run <strong>all enabled tools, including external MCP connections,</strong> without asking in <strong>${escape(conversation?.title || 'this conversation')}</strong>.</p><div class="full-access-explanation">${icon('shield')}<div><strong>This is access to your computer account and connected services.</strong><p>Commands can read, change, or delete files outside the workspace and access the network. External tools can act on their connected services. There is no OS sandbox.</p></div></div><p class="permission-revoke-note">This applies only to the current conversation and stays enabled across app restarts until you revoke it. To revoke it, choose “Ask before changes” or “Allow workspace changes” in the composer. Workspace permission alone never grants external MCP tools access.</p><div id="permissions-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="permissions-dialog">Cancel</button><button class="primary-button full-access-confirm" id="enable-full-access" type="button">Enable full access</button></div>`;
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
