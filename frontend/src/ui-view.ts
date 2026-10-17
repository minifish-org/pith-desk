import type { Mount } from 'pith-ui';
import type { Application, ApplicationOptions } from './ui-types';
import { createSessionHub } from './ui-sessions';
import { createNativeFileIO, installViewPlatform } from './ui-native-io';
import { createWorkspaceView } from './ui-workspace-view';
import { createSettingsView } from './ui-settings-view';
import { createResourcesView } from './ui-resources-view';
import { createFilesView } from './ui-files-view';
/** Desk owns its pages and business presentation models. Every visible node is a public UI control. */
export function createDeskComposition(options: ApplicationOptions) {
    const brand = options.brand ?? { name: 'Pith', qualifier: 'Desk' }, hub = createSessionHub(options), io = createNativeFileIO(), files = createFilesView(hub), workspace = createWorkspaceView(hub, options.workspace ?? {}, brand, files.header, io), settings = createSettingsView(hub, brand.name + ' ' + (brand.qualifier ?? '')), resources = createResourcesView(hub);
    return { content: workspace.content, connect(mounted: Mount): Application {
            hub.connect(mounted);
            let destroyed = false;
            const platform = installViewPlatform({ find: workspace.api.openFind, modal: () => hub.read().hasModal, appearance: () => hub.read().appearance, brand(dark) { const mark = brand.mark; workspace.brandImage.update({ label: mark?.alt ?? '', source: mark && 'src' in mark ? (dark ? mark.darkSrc ?? mark.src : mark.src) ?? (dark ? '/brand-dark.svg' : '/brand-light.svg') : (dark ? '/brand-dark.svg' : '/brand-light.svg') }); } });
            return { workspace: workspace.api, settings, resources, files: files.api, read: hub.read, setAppearance(value) { hub.setAppearance(value); platform.sync(); }, attachDialog: hub.attach, downloadFile: io.downloadFile, destroy() { if (destroyed)
                    return; destroyed = true; platform.destroy(); hub.destroy(); workspace.api.destroy(); settings.destroy(); resources.destroy(); files.api.destroy(); io.destroy(); mounted.destroy(); } };
        } };
}
