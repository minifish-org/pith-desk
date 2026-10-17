import { createText, createNotice, createButton, createTextInput, createSecretInput, createSelect, createSlot, createStack, createForm } from 'pith-ui';
import type { Control, Input, Select, Form } from 'pith-ui';
import type { ProviderLoginState, ProviderLoginCallbacks, ProviderLoginSession } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
export function openProviderLogin(hub: SessionHub, initial: ProviderLoginState, callbacks: ProviderLoginCallbacks): ProviderLoginSession {
    let state = initial, surface: Surface, disposed = false, signature = '', generation = 0, input: Input | Select | undefined, form: Form | undefined, localError = '';
    const active = () => !disposed && !!surface?.isOpen();
    const status = createNotice({ message: initial.message, tone: 'info' }), error = createNotice({ message: '', tone: 'error' }), code = createText({ text: '', role: 'code' }), prompt = createSlot(), link = createButton({ label: 'Open sign-in page in your browser ↗', onAction: () => hub.external(state.url ?? '') }), linkSlot = createSlot({ content: link, hidden: true });
    const close = createButton({ label: 'Close', onAction: () => surface.close() }), cancel = createButton({ label: 'Cancel sign-in', onAction: () => { const task = resultOf(callbacks.onCancel); surface.close(); void task.then(result => { if (!result.ok)
            hub.report(result.error); }); } }), closeSlot = createSlot({ content: close, hidden: true }), cancelSlot = createSlot({ content: cancel });
    function render(): void {
        if (disposed)
            return;
        const next = JSON.stringify([state.phase, state.prompt, state.promptType, state.options]);
        if (next !== signature) {
            generation++;
            input?.reset('');
            signature = next;
            localError = '';
            input = undefined;
            form = undefined;
            if (state.phase === 'prompt') {
                input = state.options?.length ? createSelect({ label: state.prompt ?? 'Answer', options: state.options.map(item => ({ value: item.id, label: item.label })) }) : (state.promptType === 'secret' ? createSecretInput : createTextInput)({ label: state.prompt ?? 'Answer', required: true, autocomplete: 'off' });
                const currentInput = input, currentGeneration = generation;
                form = createForm({ children: [input], submitLabel: 'Continue', onSubmit: async () => { const result = await resultOf(() => callbacks.onAnswer?.(currentInput.read())); if (active() && generation === currentGeneration && !result.ok) {
                        localError = result.error;
                        render();
                    } return result; } });
                prompt.set(form);
            }
            else
                prompt.set(undefined);
        }
        status.update({ message: state.message, tone: state.phase === 'error' ? 'error' : 'info' });
        error.update({ message: state.error || localError, tone: 'error' });
        code.update({ role: 'code', text: state.code ? 'Verification code: ' + state.code : '' });
        let valid = false;
        try {
            valid = ['http:', 'https:'].includes(new URL(state.url ?? '').protocol);
        }
        catch { }
        linkSlot.update({ hidden: !valid });
        link.update({ label: 'Open sign-in page in your browser ↗', disabled: state.disabled });
        const complete = ['complete', 'error'].includes(state.phase);
        closeSlot.update({ hidden: !complete });
        cancelSlot.update({ hidden: complete });
        cancel.update({ label: 'Cancel sign-in', disabled: state.disabled });
        form?.update({ submitLabel: 'Continue', disabled: state.disabled });
    }
    surface = hub.open('oauth', 'Provider sign-in', createStack({ children: [status, linkSlot, code, prompt, error, closeSlot, cancelSlot] }), callbacks.onClose, () => { generation++; input?.reset(''); disposed = true; });
    render();
    return { ...surface, update(next) { if (active()) {
            state = next;
            render();
        } }, fail(message) { if (active()) {
            localError = message;
            render();
        } } };
}
