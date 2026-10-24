import {useDesk} from '@/stores/desk.ts';
import {ConfirmDialog, FullAccessDialog, RenameDialog} from './confirm.tsx';
import {WorkspaceDialog} from './workspace.tsx';
import {EditorDialog, RecoveredDialog} from './editor.tsx';
import {ServerDialog} from './server.tsx';
import {ImageDialog} from './image.tsx';
import {SettingsDialog} from './settings.tsx';
import {ConnectionsDialog} from './connections.tsx';
import {CustomConnectionDialog} from './custom-connection.tsx';
import {ProviderLoginDialog} from './provider-login.tsx';
import {ResourcesDialog, ResourceEditorDialog} from './resources.tsx';
import {HistoryDialog} from './history.tsx';
import {PreviewDialog} from './preview.tsx';

/** Renders the modal stack. Store order is paint order, so a dialog opened from
 * another dialog sits above it. */
export function Dialogs() {
  const modals = useDesk(store => store.modals);
  return (
    <>
      {modals.map(modal => {
        switch (modal.kind) {
          case 'confirm': return <ConfirmDialog key={modal.id} modal={modal} />;
          case 'rename': return <RenameDialog key={modal.id} modal={modal} />;
          case 'workspace': return <WorkspaceDialog key={modal.id} modal={modal} />;
          case 'full-access': return <FullAccessDialog key={modal.id} modal={modal} />;
          case 'editor': return <EditorDialog key={modal.id} modal={modal} />;
          case 'image': return <ImageDialog key={modal.id} modal={modal} />;
          case 'server': return <ServerDialog key={modal.id} modal={modal} />;
          case 'recovered': return <RecoveredDialog key={modal.id} modal={modal} />;
          case 'settings': return <SettingsDialog key={modal.id} modal={modal} />;
          case 'connections': return <ConnectionsDialog key={modal.id} modal={modal} />;
          case 'custom-connection': return <CustomConnectionDialog key={modal.id} modal={modal} />;
          case 'provider-login': return <ProviderLoginDialog key={modal.id} modal={modal} />;
          case 'resources': return <ResourcesDialog key={modal.id} modal={modal} />;
          case 'resource-editor': return <ResourceEditorDialog key={modal.id} modal={modal} />;
          case 'preview': return <PreviewDialog key={modal.id} modal={modal} />;
          case 'history': return <HistoryDialog key={modal.id} modal={modal} />;
          default: return null;
        }
      })}
    </>
  );
}
