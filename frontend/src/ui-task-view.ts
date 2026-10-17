import { createText, createNotice, createButton, createActions, createStack, createSlot, createDisclosure, createList, createListRow, createKeyValue, createDocument, createCollectionState } from 'pith-ui';
import type { Control, ButtonState, KeyValueState, Disclosure } from 'pith-ui';
import type { WorkspaceScene, WorkspaceCallbacks, ApprovalPanelState, TaskFailureState, RuntimePanelState, CostRequestDisplay, CompletionNoticeDisplay, WorkspaceAvailability } from './ui-types';
import type { SessionHub } from './ui-sessions';
export function createTaskView(hub: SessionHub, callbacks: WorkspaceCallbacks) {
    const fail = callbacks.onError ?? hub.report, approval = createSlot({ hidden: true }), failure = createSlot({ hidden: true }), notices = createList({ items: [] }), noticeSlot = createSlot({ content: notices, hidden: true }), costBody = createSlot(), costs = createDisclosure({ title: 'Request breakdown', content: costBody, onToggle: () => callbacks.onCostsChange?.() }), costSlot = createSlot({ content: costs, hidden: true }), values = createList({ items: [] }), runtime = createDisclosure({ title: 'Run details', content: createStack({ children: [values, createText({ role: 'description', text: 'Duration and average speed cover the latest task, including tools and waits. Speed uses reported output tokens, including reasoning, retries and summaries. Session token figures come from Pith records. Context excludes system instructions and tool schemas. Costs estimate recorded requests, not a provider bill.' }), costSlot] }), onToggle: () => callbacks.onCostsChange?.() }), runtimeSlot = createSlot({ content: runtime, hidden: true });
    const rows = new Map<string, Control<KeyValueState>>(), ledger = new Map<string, {
        control: Control;
        heading: ReturnType<typeof createText>;
        tokens: ReturnType<typeof createText>;
        source: ReturnType<typeof createText>;
        price: ReturnType<typeof createText>;
    }>(), costList = createList({ items: [] });
    let costMounted = false;
    const costStatus = createNotice({ tone: 'info', message: '' }), costNote = createText({ role: 'description', text: '' });
    costBody.set(createStack({ children: [costStatus, costNote, costList] }));
    costMounted = true;
    let approvalId = '', approvalState: ApprovalPanelState = { approval: null }, approvalParts: {
        warning: ReturnType<typeof createNotice>;
        preview: ReturnType<typeof createDocument>;
        previewSlot: ReturnType<typeof createSlot>;
        args: ReturnType<typeof createDocument>;
        arguments: Disclosure;
        argsSlot: ReturnType<typeof createSlot>;
        path: ReturnType<typeof createText>;
        note: ReturnType<typeof createText>;
        always: ReturnType<typeof createSlot>;
        buttons: Array<{
            control: Control<ButtonState>;
            label: string;
            intent?: 'primary';
        }>;
    } | undefined;
    let runtimeState: RuntimePanelState = { visible: false, summary: '', duration: '', speed: '', inputTokens: '', outputTokens: '', cacheRead: '', cacheWrite: '', contextTokens: '', contextWindow: '', compactions: '', toolFailures: '', recordedCost: '', latestCost: '' };
    let failureState: TaskFailureState = { visible: false, message: '', advice: '', canContinue: false }, availability: WorkspaceAvailability = {};
    const failureMessage = createNotice({ tone: 'error', message: '' }), failureAdvice = createText({ text: '' }), recover = createButton({ label: 'Review and continue', onAction: () => callbacks.onAction?.(failureState.canContinue ? 'continue' : 'settings'), onError: fail }), diagnostics = createButton({ label: 'Save diagnostics', onAction: () => callbacks.onAction?.('diagnostics'), onError: fail });
    failure.set(createStack({ children: [failureMessage, failureAdvice, createActions({ children: [recover, diagnostics] })] }));
    const syncFailure = () => { const blocked = !!availability.busy || !!availability.workspaces?.includes(failureState.workspaceId ?? ''); recover.update({ label: failureState.canContinue ? 'Review and continue' : 'Check model settings', disabled: blocked }); diagnostics.update({ label: 'Save diagnostics', disabled: availability.busy }); };
    const noticeRows = new Map<string, {
        control: Control;
        line: ReturnType<typeof createListRow>;
    }>();
    function updateApproval(state: ApprovalPanelState) {
        const next = state.approval;
        if (next?.id !== approvalId) {
            approvalId = next?.id ?? '';
            approvalParts = undefined;
            if (!next) {
                approval.set(undefined);
                approval.update({ hidden: true });
                return;
            }
            const id = next.id, warning = createNotice({ message: '', tone: 'warning' }), path = createText({ role: 'code', text: '' }), preview = createDocument({ text: '', format: 'diff' }), previewSlot = createSlot({ content: preview, hidden: true }), args = createDocument({ text: next.argsText, format: 'text' }), argumentsDisclosure = createDisclosure({ title: 'Tool arguments', open: !!next.preview?.error, content: args }), argsSlot = createSlot({ content: argumentsDisclosure }), note = createText({ role: 'description', text: '' });
            const buttons: Array<{
                control: Control<ButtonState>;
                label: string;
                intent?: 'primary';
            }> = [];
            const action = (action: 'deny' | 'always' | 'allow', label: string, intent?: 'primary') => { const control = createButton({ label, intent, onAction: () => callbacks.onApproval?.(id, action), onError: fail }); buttons.push({ control, label, intent }); return control; }, deny = action('deny', 'Deny'), alwaysButton = action('always', 'Always allow workspace changes'), always = createSlot({ content: alwaysButton, hidden: !next.canAlwaysAllow }), allow = action('allow', 'Allow this action', 'primary');
            approvalParts = { warning, path, preview, previewSlot, args, arguments: argumentsDisclosure, argsSlot, note, always, buttons };
            approval.update({ hidden: false });
            approval.set(createStack({ label: 'Tool approval required', children: [createText({ role: 'heading', text: 'Pith needs your permission · ' + next.toolName }), createText({ role: 'description', text: 'Review this action before it runs.' }), warning, path, previewSlot, argsSlot, note, createActions({ children: [deny, always, allow] })] }));
        }
        approvalState = state;
        if (!next || !approvalParts)
            return;
        const parts = approvalParts;
        parts.warning.update({ message: next.warning ?? '', tone: 'warning' });
        parts.path.update({ role: 'code', text: next.preview ? `${next.preview.kind === 'create' ? 'Create file' : 'Modify file'} · ${next.preview.path}` : '' });
        parts.previewSlot.update({ hidden: !next.preview || !!next.preview.error });
        parts.preview.update({ text: next.preview?.diff || 'No content changes.', format: 'diff' });
        parts.args.update({ text: next.argsText, format: 'text' });
        if (!next.preview)
            parts.arguments.setOpen(true);
        parts.note.update({ role: 'description', text: [next.preview?.error, next.preview?.truncated ? 'Preview shortened. Expand Tool arguments for the complete change.' : '', next.canAlwaysAllow ? 'Workspace permission applies to this conversation. Commands and external connection tools still need approval.' : ''].filter(Boolean).join('\n') });
        parts.always.update({ hidden: !next.canAlwaysAllow });
        for (const button of parts.buttons)
            button.control.update({ label: button.label, intent: button.intent, disabled: state.disabled });
    }
    function updateRuntime(state: RuntimePanelState) { runtimeState = state; runtimeSlot.update({ hidden: !state.visible }); runtime.update({ title: state.summary || 'Run details' }); const fields: Array<[
        string,
        string
    ]> = [...(state.provider ? [['Provider', state.provider] as [
                string,
                string
            ]] : []), ...(state.thinkingLevel ? [['Thinking effort', state.thinkingLevel] as [
                string,
                string
            ]] : []), ['Latest task duration', state.duration], ['Avg. output tokens/s', state.speed], ['Session input / output', state.inputTokens + ' / ' + state.outputTokens], ['Cache read / write', state.cacheRead + ' / ' + state.cacheWrite], ['Estimated conversation context', '~' + state.contextTokens + ' / ' + state.contextWindow + ' tokens'], ['Context summaries', state.compactions], ['Tool failures recorded', state.toolFailures], ['Recorded cost (USD)', state.recordedCost], ['Latest task (USD)', state.latestCost], ['Execution', 'Codemode enabled · durable local task journal']]; const keep = new Set<string>(); values.update({ items: fields.map(([key, value]) => { keep.add(key); let row = rows.get(key); if (!row) {
            row = createKeyValue({ items: [{ key, label: key, value }] });
            rows.set(key, row);
        } row.update({ items: [{ key, label: key, value }] }); return { key, content: row }; }) }); for (const key of rows.keys())
        if (!keep.has(key))
            rows.delete(key); }
    const api: Pick<WorkspaceScene, 'updateApproval' | 'updateFailure' | 'updateRuntime' | 'updateTiming' | 'updateNotices' | 'readCosts' | 'updateCosts' | 'resetCosts'> = {
        updateApproval, updateRuntime, updateTiming(value) { updateRuntime({ ...runtimeState, ...value }); },
        updateFailure(state) { failureState = state; failure.update({ hidden: !state.visible }); failureMessage.update({ message: state.message, tone: 'error' }); failureAdvice.update({ text: state.advice }); syncFailure(); },
        updateNotices(entries) { noticeSlot.update({ hidden: entries.length === 0 }); const keep = new Set<string>(); notices.update({ items: entries.map(item => { keep.add(item.runID); let row = noticeRows.get(item.runID); if (!row) {
                const line = createListRow({ title: item.title, meta: item.workspace, actions: createActions({ children: [createButton({ label: 'Open completed conversation', onAction: () => callbacks.onCompletionOpen?.(item.id) }), createButton({ label: 'Dismiss completed task', onAction: () => callbacks.onCompletionDismiss?.(item.runID) })] }) });
                row = { control: line, line };
                noticeRows.set(item.runID, row);
            } row.line.update({ title: item.title, meta: item.workspace }); return { key: item.runID, content: row.control }; }) }); for (const key of noticeRows.keys())
            if (!keep.has(key))
                noticeRows.delete(key); },
        readCosts: () => ({ open: costs.isOpen(), runtimeOpen: runtime.isOpen() }),
        updateCosts(state) { costSlot.update({ hidden: !state.visible }); costStatus.update({ tone: state.error ? 'error' : 'info', message: state.error || state.loading ? 'Loading request breakdown…' : '' }); if (state.error) {
            costStatus.update({ tone: 'error', message: state.error });
            costList.update({ items: [] });
            ledger.clear();
            return;
        } if (state.loading || !state.report)
            return; costNote.update({ role: 'description', text: `USD estimates for recorded requests, not a provider bill. Prices are saved per request; retries and context summaries are included when usage is reported. ${state.report.unknownRequests} request(s) have unknown prices or usage and are excluded. Older requests made before recording began are not reconstructed.` }); const requests = state.report.requests ?? [], keep = new Set<string>(); costList.update({ items: requests.map(item => { keep.add(item.id); let row = ledger.get(item.id); if (!row) {
                const heading = createText({ role: 'heading', text: '' }), tokens = createText({ role: 'description', text: '' }), source = createText({ text: '' }), price = createText({ role: 'code', text: '' });
                row = { heading, tokens, source, price, control: createStack({ children: [heading, tokens, createDisclosure({ title: 'Price source and rates (USD / million tokens)', content: createStack({ children: [source, price] }) })] }) };
                ledger.set(item.id, row);
            } row.heading.update({ role: 'heading', text: `${item.purpose} · ${item.status} · ${item.providerName || item.provider} / ${item.modelName || item.model}` }); row.tokens.update({ role: 'description', text: `${item.time}\nInput: ${item.usage.input} · Output: ${item.usage.output} · Cache read / write: ${item.usage.cacheRead} / ${item.usage.cacheWrite} · Estimate: ${item.known ? '$' + item.usage.cost.total.toFixed(6) : 'Unknown'}${item.usage.reasoning == null ? '' : '\nReasoning tokens: ' + item.usage.reasoning + ' (included in output)'}` }); row.source.update({ text: item.source }); row.price.update({ role: 'code', text: JSON.stringify(item.price, null, 2) }); return { key: item.id, content: row.control }; }) }); for (const key of ledger.keys())
            if (!keep.has(key))
                ledger.delete(key); },
        resetCosts() { costs.setOpen(false); if (costMounted)
            costList.update({ items: [] }); ledger.clear(); },
    };
    return { api, availability(state: WorkspaceAvailability) { availability = state; syncFailure(); }, content: createStack({ children: [approval, failure, runtimeSlot, noticeSlot] }) };
}
