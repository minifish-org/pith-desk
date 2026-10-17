import type { ActionResult, HostResult } from './ui-types';
const failure = (error: unknown): ActionResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
export async function copyNativeText(text: string, handler?: ((text: string) => HostResult)): Promise<ActionResult> {
    try {
        if (handler)
            return await handler(text) || { ok: true };
        await navigator.clipboard.writeText(text);
        return { ok: true };
    }
    catch (error) {
        return failure(error);
    }
}
export async function openExternalURL(value: string, handler?: ((url: string) => HostResult)): Promise<ActionResult> {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol))
            return { ok: false, error: 'Unsupported external link.' };
        if (handler)
            return await handler(url.href) || { ok: true };
        window.open(url.href, '_blank', 'noopener,noreferrer');
        return { ok: true };
    }
    catch (error) {
        return failure(error);
    }
}
/** Native capability elements are hidden and never inspect library-generated UI. */
export function createNativeFileIO() {
    let destroyed = false, receive: ((files: File[]) => void) | undefined;
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    picker.multiple = true;
    picker.hidden = true;
    picker.dataset.nativeImagePicker = '';
    const changed = () => { const files = [...picker.files ?? []], callback = receive; receive = undefined; picker.value = ''; if (!destroyed)
        callback?.(files); };
    picker.addEventListener('change', changed);
    document.body.append(picker);
    const downloads = new Map<string, ReturnType<typeof setTimeout>>();
    return {
        pickImages(callback: (files: File[]) => void) { if (destroyed)
            return; receive = callback; picker.click(); },
        async downloadFile({ blob, name }: {
            readonly blob: Blob;
            readonly name: string;
        }): Promise<ActionResult> {
            if (destroyed)
                return { ok: false, error: 'Desk view has been destroyed.' };
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            try {
                link.href = url;
                link.download = name;
                link.hidden = true;
                document.body.append(link);
                link.click();
                return { ok: true };
            }
            catch (error) {
                return failure(error);
            }
            finally {
                link.remove();
                if (destroyed)
                    URL.revokeObjectURL(url);
                else
                    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 30000));
            }
        },
        destroy() { if (destroyed)
            return; destroyed = true; receive = undefined; picker.removeEventListener('change', changed); picker.remove(); for (const [url, timer] of downloads) {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
        } downloads.clear(); },
    };
}
/** Platform appearance and find shortcut data, without inspecting generated UI. */
export function installViewPlatform(options: {
    find(): void;
    modal(): boolean;
    appearance: () => string;
    brand: (dark: boolean) => void;
}) {
    const system = matchMedia('(prefers-color-scheme:dark)');
    const sync = () => options.brand(options.appearance() === 'dark' || options.appearance() === 'system' && system.matches);
    const key = (event: KeyboardEvent) => { if (!event.defaultPrevented && !event.isComposing && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !options.modal()) {
        event.preventDefault();
        options.find();
    } };
    system.addEventListener('change', sync);
    document.addEventListener('keydown', key);
    sync();
    return { sync, destroy() { system.removeEventListener('change', sync); document.removeEventListener('keydown', key); } };
}
