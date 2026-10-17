import { createSelect, createListSelect, createSearchInput, createText, createSlot, createForm, createStack, createTextInput, createURLInput, createSecretInput, createNumberInput, createCheckbox, createButton, createList, createFormSection, createDisclosure, customModelDefaults, thinkingLabel } from 'pith-ui';
import type { Control, Input } from 'pith-ui';
import type { ModelPickerState, ModelCallbacks, ModelSession, ModelSelection, CustomConnectionState, CustomConnectionCallbacks, CustomConnectionSession, CustomConnectionDraft, CustomModelValue, CustomModelDraft } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
export function openModels(hub: SessionHub, initial: ModelPickerState, callbacks: ModelCallbacks): ModelSession {
    let state = initial, surface: Surface, initialized = false, signature = '', selected = '', revision = 0, localError = '', disposed = false;
    const active = () => !disposed && !!surface?.isOpen();
    const provider = createSelect({ label: 'Provider', required: true, options: [], onChange: () => chooseProvider() });
    const search = createSearchInput({ label: 'Model', placeholder: 'Search by model name or ID', onInput: () => renderModels() });
    const models = createListSelect({ label: 'Choose model', required: true, options: [], onChange: () => capabilities() });
    const effort = createSelect({ label: 'Thinking effort', options: [] }), effortSlot = createSlot({ content: effort }), info = createText({ text: '', role: 'description' });
    const read = (): ModelSelection => ({ provider: provider.read(), model: models.read(), thinkingLevel: effort.read() });
    const form = createForm({ children: [provider, search, models, info, effortSlot], submitLabel: 'Use model', onCancel: () => surface.close(), onSubmit: async () => { const submittedRevision = revision, result = await resultOf(() => callbacks.onSubmit?.(read())); if (active() && submittedRevision === revision) {
            if (result.ok)
                surface.close();
            else {
                localError = result.error;
                render();
            }
        } return result; } });
    function capabilities(preferred = effort.read()): void {
        selected = models.read();
        const entry = state.editor?.models?.find(item => item.provider === provider.read() && item.id === selected), levels = entry?.thinkingLevels?.length ? entry.thinkingLevels : ['off'];
        effort.update({ label: 'Thinking effort', options: levels.map(value => ({ value, label: thinkingLabel(value) })), disabled: !!state.disabled || !!state.editor?.disabled || levels.length < 2 });
        effort.reset(levels.includes(preferred) ? preferred : levels.includes('high') ? 'high' : levels.includes('medium') ? 'medium' : levels[0]);
        effortSlot.update({ hidden: levels.length < 2 });
        info.update({ text: entry ? `${entry.supportsImages ? 'Text + images' : 'Text only'} · ${new Intl.NumberFormat('en').format(entry.contextWindow)} context tokens · ${new Intl.NumberFormat('en').format(entry.maxTokens)} max output tokens` : 'No matching models.', role: 'description' });
    }
    function renderModels(preferred = effort.read()): void {
        const query = search.read().trim().toLowerCase(), entries = (state.editor?.models ?? []).filter(item => item.provider === provider.read() && (item.id === selected || `${item.name} ${item.id}`.toLowerCase().includes(query)));
        models.update({ label: 'Choose model', required: true, options: entries.map(item => ({ value: item.id, label: `${item.name} — ${item.id}` })), disabled: !!state.disabled || !!state.editor?.disabled || !entries.length });
        models.reset(entries.some(item => item.id === selected) ? selected : entries[0]?.id ?? '');
        capabilities(preferred);
    }
    function chooseProvider(selection?: ModelSelection): void {
        const entry = state.editor?.providers?.find(item => item.id === provider.read());
        search.reset('');
        selected = selection?.provider === provider.read() ? selection.model : entry?.model ?? '';
        renderModels(selection?.provider === provider.read() ? selection.thinkingLevel : entry?.thinkingLevel ?? 'high');
    }
    function reset(selection: ModelSelection): void {
        if (disposed)
            return;
        revision++;
        form.resetSubmission();
        provider.reset(state.editor?.providers?.some(item => item.id === selection.provider) ? selection.provider : state.editor?.providers?.[0]?.id ?? '');
        chooseProvider(selection);
    }
    function render(): void {
        const draft = read(), nextSignature = JSON.stringify([state.editor?.providers, state.editor?.models]);
        provider.update({ label: 'Provider', required: true, options: (state.editor?.providers ?? []).map(item => ({ value: item.id, label: item.name })), disabled: !!state.disabled || !!state.editor?.disabled || !state.editor?.providers?.length });
        if (nextSignature !== signature) {
            signature = nextSignature;
            if (!initialized || !draft.provider)
                reset(state.editor?.selection ?? { provider: '', model: '', thinkingLevel: '' });
            else {
                provider.reset(state.editor?.providers?.some(item => item.id === draft.provider) ? draft.provider : state.editor?.providers?.[0]?.id ?? '');
                selected = draft.model;
                renderModels(draft.thinkingLevel);
            }
            initialized = true;
        }
        else
            renderModels(draft.thinkingLevel);
        search.update({ label: 'Model', placeholder: 'Search by model name or ID', disabled: !!state.disabled || !!state.editor?.disabled });
        form.update({ submitLabel: 'Use model', submitDisabled: !!state.disabled || !!state.loading || !state.editor || !models.read(), error: localError || state.error });
    }
    surface = hub.open('model', 'Choose a model', form, callbacks.onClose, () => { disposed = true; revision++; });
    render();
    search.focus();
    return { ...surface, read, update(next) { if (active()) {
            state = next;
            render();
        } }, reset(selection) { if (active())
            reset(selection); }, focus: search.focus, fail(message) { if (active()) {
            localError = message;
            render();
        } } };
}
export function openCustomConnection(hub: SessionHub, initial: CustomConnectionState, callbacks: CustomConnectionCallbacks): CustomConnectionSession {
    let state = initial, surface: Surface, disposed = false, writing = false, localError = '', nextIndex = 0;
    const active = () => !disposed && !!surface?.isOpen();
    const name = createTextInput({ label: 'Connection name', value: initial.name, required: true }), url = createURLInput({ label: 'API base URL', value: initial.baseUrl, required: true, placeholder: 'https://example.com/v1' });
    const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'];
    const protocol = createSelect({ label: 'API protocol', options: protocols.map(value => ({ value, label: value })), value: initial.api });
    const key = createSecretInput({ label: 'API key', autocomplete: 'new-password', placeholder: initial.editing ? 'Leave blank to keep the key at the same endpoint' : 'API key (optional for local endpoints)' });
    type Row = {
        content: Control;
        fields: Input[];
        remove: ReturnType<typeof createButton>;
        read(): CustomModelDraft;
    };
    const rows = new Map<number, Row>(), list = createList({ items: [] });
    const refresh = () => list.update({ items: [...rows].map(([key, row]) => ({ key: String(key), content: row.content })) });
    function add(model: CustomModelValue): void {
        const index = nextIndex++, id = createTextInput({ label: 'Model ID', value: model.id, required: true }), label = createTextInput({ label: 'Display name', value: model.name ?? '' });
        const context = createNumberInput({ label: 'Context tokens', value: model.contextWindow === undefined ? '' : String(model.contextWindow), min: 1, required: true }), max = createNumberInput({ label: 'Max output tokens', value: model.maxTokens === undefined ? '' : String(model.maxTokens), min: 1, required: true });
        const reasoning = createCheckbox({ label: 'Thinking effort', checked: !!model.reasoning }), images = createCheckbox({ label: 'Images', checked: !!model.input?.includes('image') });
        const names = { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write' } as const;
        const rates = Object.fromEntries((Object.keys(names) as Array<keyof typeof names>).map(rate => [rate, createNumberInput({ label: names[rate], value: model.cost?.[rate] === undefined ? '' : String(model.cost[rate]), min: 0, step: 'any' })])) as Record<keyof typeof names, Input>;
        const remove = createButton({ label: 'Remove model', intent: 'danger', onAction() { if (state.disabled || writing)
                return; rows.delete(index); refresh(); } });
        const content = createFormSection({ title: `Model ${index + 1}`, children: [id, label, context, max, reasoning, images, createDisclosure({ title: 'Price estimate (optional)', content: createStack({ children: Object.values(rates) }) }), remove] });
        rows.set(index, { content, fields: [id, label, context, max, ...Object.values(rates)], remove, read: () => ({ sourceIndex: index, id: id.read().trim(), name: label.read().trim(), contextWindow: Number(context.read()), maxTokens: Number(max.read()), reasoning: reasoning.read(), images: images.read(), prices: { input: rates.input.read(), output: rates.output.read(), cacheRead: rates.cacheRead.read(), cacheWrite: rates.cacheWrite.read() } }) });
        refresh();
    }
    for (const model of initial.models)
        add(model);
    const addButton = createButton({ label: 'Add model', onAction() { if (!state.disabled && !writing)
            add(customModelDefaults()); } });
    const read = (): CustomConnectionDraft => ({ name: name.read(), baseUrl: url.read(), api: protocol.read(), apiKey: key.read(), models: [...rows.values()].map(row => row.read()) });
    const form = createForm({ children: [name, url, protocol, key, list, addButton, createText({ role: 'description', text: 'Limits and capabilities are provided by you. Prices are USD per million tokens. Fill all four rates (0 for free/unused), or leave all four blank for unknown prices.' })], submitLabel: 'Save connection', onCancel: () => surface.close(), onSubmit: async () => { if (state.disabled || writing)
            return { ok: false, error: 'This action is unavailable.' }; writing = true; render(); const result = await resultOf(() => callbacks.onSubmit?.(read())); if (active()) {
            writing = false;
            if (result.ok)
                surface.close();
            else {
                localError = result.error;
                render();
            }
        } return result; } });
    const render = () => { form.update({ submitLabel: 'Save connection', submitDisabled: state.disabled, pending: writing, error: localError || state.error }); addButton.update({ label: 'Add model', disabled: !!state.disabled || writing }); };
    surface = hub.open('feature', initial.editing ? 'Edit model connection' : 'Add model connection', form, callbacks.onClose, () => { key.reset(''); disposed = true; });
    render();
    return { ...surface, read, update(next) { if (active()) {
            state = next;
            render();
        } }, clearSecrets() { key.reset(''); }, fail(message) { if (active()) {
            localError = message;
            render();
        } } };
}
