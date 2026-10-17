import { copyNativeText, openExternalURL } from './ui-native-io';
import { createDialog, createNotice, createStack, createCollectionState } from 'pith-ui';
import type { Control, Dialog, Mount } from 'pith-ui';
import type { ActionResult, ApplicationOptions, ApplicationDialog, ApplicationState, HostResult, LoadingSession, LoadingState } from './ui-types';
export const resultOf = async (task: (() => HostResult) | undefined): Promise<ActionResult> => {
    if (!task)
        return { ok: false, error: 'This action is unavailable.' };
    try {
        return await task() || { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
};
export interface Surface {
    isOpen(): boolean;
    close(): void;
    destroy(): void;
    fail(message: string): void;
    title(value: string): void;
}
export interface SessionHub {
    connect(mounted: Mount): void;
    open(channel: string, title: string, content: Control, onClose?: () => void, onDispose?: () => void): Surface;
    loading(channel: string, title: string, state: LoadingState, onClose?: () => void): LoadingSession;
    attach(dialog: ApplicationDialog): {
        destroy(): void;
    };
    read(): ApplicationState;
    setAppearance(value: ApplicationState['appearance']): void;
    copy(text: string): Promise<ActionResult>;
    external(url: string): Promise<ActionResult>;
    report(message: string): void;
    destroy(): void;
}
export function createSessionHub(options: ApplicationOptions): SessionHub {
    let mounted: Mount | undefined, destroyed = false, appearance = options.appearance ?? 'system', sequence = 0;
    const channels = new Map<string, Surface>(), openings = new Map<string, number>();
    const report = (message: string) => { if (!destroyed)
        options.onError?.(message); };
    const notify = (callback: (() => void) | undefined) => { try {
        callback?.();
    }
    catch (error) {
        report(error instanceof Error ? error.message : String(error));
    } };
    const read = (): ApplicationState => mounted?.read() ?? { hasModal: false, appearance };
    const closed: Surface = { isOpen: () => false, close() { }, destroy() { }, fail() { }, title() { } };
    const hub: SessionHub = {
        connect(owner) { if (mounted)
            throw new Error('Desk view is already mounted.'); mounted = owner; },
        open(channel, title, content, onClose, onDispose) {
            const opening = ++sequence;
            openings.set(channel, opening);
            channels.get(channel)?.close();
            if (destroyed || openings.get(channel) !== opening) {
                content.destroy();
                notify(onDispose);
                queueMicrotask(() => notify(onClose));
                return closed;
            }
            if (!mounted)
                throw new Error('Mount the Desk view before opening a surface.');
            const error = createNotice({ message: '', tone: 'error' });
            let alive = true, owner: {
                destroy(): void;
            } | undefined, dialog: Dialog;
            const release = () => { if (!alive)
                return; alive = false; if (channels.get(channel) === surface)
                channels.delete(channel); notify(onDispose); owner?.destroy(); notify(onClose); };
            const surface: Surface = { isOpen: () => alive && !destroyed && channels.get(channel) === surface && dialog.isOpen(), close() { if (!alive)
                    return; dialog.close(); release(); }, destroy: () => surface.close(), fail(message) { if (surface.isOpen())
                    error.update({ message, tone: 'error' }); }, title(value) { if (surface.isOpen())
                    dialog.update({ title: value }); } };
            dialog = createDialog({ title, content: createStack({ children: [error, content] }), onClose: release });
            owner = mounted.attach(dialog);
            channels.set(channel, surface);
            dialog.open();
            return surface;
        },
        loading(channel, title, state, onClose) { const status = createCollectionState({ status: state.error ? 'error' : 'loading', message: state.error || 'Loading…' }); const surface = hub.open(channel, title, status, onClose); return { ...surface, fail(message) { if (surface.isOpen())
                status.update({ status: 'error', message }); }, update(next) { if (surface.isOpen())
                status.update({ status: next.error ? 'error' : 'loading', message: next.error || 'Loading…' }); } }; },
        attach(dialog) { if (!mounted || destroyed)
            throw new Error('Desk view is unavailable.'); return mounted.attach(dialog); }, read,
        setAppearance(value) { appearance = value; mounted?.setAppearance(value); },
        copy(text) { return destroyed ? Promise.resolve({ ok: false, error: 'Desk view has been destroyed.' }) : copyNativeText(text, options.host?.copyText); },
        external(value) { return destroyed ? Promise.resolve({ ok: false, error: 'Desk view has been destroyed.' }) : openExternalURL(value, options.host?.openExternal); },
        report, destroy() { if (destroyed)
            return; destroyed = true; for (const surface of [...channels.values()])
            surface.close(); channels.clear(); },
    };
    return hub;
}
