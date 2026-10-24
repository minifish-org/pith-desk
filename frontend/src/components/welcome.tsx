import {FolderOpen, MessageSquare, Plus, ShieldCheck} from 'lucide-react';
import {useDesk} from '@/stores/desk.ts';
import {selectedWorkspace} from '@/lib/derive.ts';
import {openWorkspace} from '@/actions/conversations.ts';
import {openSettings} from '@/actions/settings.ts';
import {setComposerText} from '@/actions/composer.ts';
import {emitAppEvent} from '@/lib/events.ts';
import {BrandMark} from '@/components/brand';
import {Button} from '@/components/ui/button';

const suggestions = [
  {icon: FolderOpen, label: 'Explore my workspace', prompt: 'Explore this workspace and give me a concise overview of its files.'},
  {icon: MessageSquare, label: 'Think through a task', prompt: 'Help me plan a task. Start by asking what I want to accomplish.'},
  {icon: Plus, label: 'Create something', prompt: "I'd like help creating a document in this workspace. Ask me what it should cover."},
];

/** The empty-transcript surface: what the product is, where it will work and
 * a few starting points. */
export function Welcome() {
  const state = useDesk(store => store.state);
  const selectedId = useDesk(store => store.selectedWorkspaceId);
  const workspace = selectedWorkspace(state, selectedId);
  const ready = state.settings.hasApiKey;
  return (
    <div className="mx-auto flex max-w-[560px] flex-col items-center py-12 text-center">
      <div className="mb-5 grid size-16 place-items-center rounded-[18px] border bg-card shadow-sm">
        <BrandMark className="size-8" />
      </div>
      <p className="text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">Your local work companion</p>
      <h1 className="mt-2 text-[24px] font-semibold tracking-tight">What are we working on?</h1>
      <p className="mt-2 max-w-[440px] text-[13.5px] leading-6 text-muted-foreground">An agent that works with your files and the tools you choose.</p>
      {workspace ? (
        <div className="mt-4 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <FolderOpen className="size-3.5" />
          <span>Working in <strong className="font-medium text-foreground">{workspace.name}</strong></span>
          <Button type="button" variant="ghost" size="xs" className="h-6 px-1 text-[12px] font-normal text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground" onClick={openWorkspace}>Change</Button>
        </div>
      ) : <p className="mt-4 text-[12px] text-muted-foreground">Choose a workspace to start a conversation.</p>}
      {!ready ? (
        <div className="mt-6 w-full rounded-xl border bg-card p-4 text-left">
          <p className="text-[13px] font-medium">Connect a model to get started</p>
          <p className="mt-1 text-[12px] text-muted-foreground">Add a provider key or sign in with your provider account in Settings. Credentials stay in Pith Desk’s private local data.</p>
          <Button size="sm" className="mt-3" onClick={openSettings}>Open settings</Button>
        </div>
      ) : null}
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        {suggestions.map(({icon: Icon, label, prompt}) => (
          <button
            key={label}
            type="button"
            className="flex items-center gap-2 rounded-full border bg-card px-3.5 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => {
              setComposerText(prompt);
              emitAppEvent('focusComposer');
            }}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="size-3.5" />
        Local workspace. Your choice of model.
      </div>
    </div>
  );
}
