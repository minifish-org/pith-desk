import {useEffect, useRef, useState} from 'react';
import {Download, FilePlus2, FileText, LoaderCircle, Pencil, RefreshCw, Sparkles, Trash2} from 'lucide-react';
import {cn} from '@/lib/utils';
import {closeModalId, desk, modalId, useDesk, type ModalOf} from '@/stores/desk.ts';
import {request, mutate} from '@/actions/core.ts';
import {runtime} from '@/lib/runtime.ts';
import {workspaceRun} from '@/lib/derive.ts';
import {selected} from '@/actions/conversations.ts';
import {createInstructions, saveResource} from '@/actions/settings.ts';
import {resourceFileAction} from '@/actions/files.ts';
import {insertReferences} from '@/actions/composer.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import type {ResourceInventory, SkillResource} from '@/contract.generated.ts';

function defaultContent(kind: 'skill' | 'template' | 'instructions'): string {
  if (kind === 'skill') return '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n';
  if (kind === 'template') return '---\ndescription: Describe this prompt.\n---\n\nHelp me with $@.\n';
  return '# Project instructions\n\n';
}

export function ResourcesDialog({modal}: {modal: ModalOf<'resources'>}) {
  const [workspaceId] = useState(() => selected()?.id || '');
  const workspace = useDesk(store => store.state.workspaces.find(entry => entry.id === workspaceId));
  const blocked = useDesk(store => !!workspaceRun(store.state, workspaceId));
  const busy = useDesk(store => store.activity.busy);
  const unavailable = blocked || busy;
  const [inventory, setInventory] = useState<ResourceInventory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => () => {mounted.current = false;}, []);

  const refresh = async () => {
    if (!workspace) return;
    const sequence = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await request('/api/resources', {query: {workspaceId}});
      if (mounted.current && sequence === generation.current) setInventory(result);
    }
    catch (failure) {
      if (mounted.current && sequence === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
    finally {if (mounted.current && sequence === generation.current) setLoading(false);}
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {mounted.current = false;};
  }, [workspaceId]);

  const hasInstructions = (inventory?.instructions || []).some(entry => entry.path.replace(/\\/g, '/').endsWith('/AGENTS.md') || entry.path === 'AGENTS.md');
  const openEditor = (resourceKind: 'skill' | 'template' | 'instructions', path?: string) => {
    if (!workspace || unavailable) return;
    desk().openModal({kind: 'resource-editor', id: modalId('resource-editor'), workspaceId: workspace.id, resourceKind, path});
  };
  const use = (entry: SkillResource, kind: 'skill' | 'template') => {
    if (!workspace) return;
    insertReferences([]);
    desk().setComposer({text: `${kind === 'skill' ? `/skill:${entry.name}` : `/${entry.name}`} `});
    closeModalId(modal.id);
    window.dispatchEvent(new CustomEvent('pith:focus-composer'));
  };

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Workspace resources</DialogTitle>
          <DialogDescription>{workspace ? `${workspace.name} · ${workspace.path}` : 'Choose a workspace first.'}</DialogDescription>
        </DialogHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => {void refresh();}}>{loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh</Button>
            <Button size="sm" variant="secondary" disabled={unavailable} onClick={() => openEditor('skill')}><FilePlus2 className="size-3.5" />Add skill</Button>
            <Button size="sm" variant="secondary" disabled={unavailable} onClick={() => openEditor('template')}><FilePlus2 className="size-3.5" />Add template</Button>
            {!hasInstructions ? (
              <Button
                size="sm" variant="secondary" disabled={unavailable}
                aria-label="Create AGENTS.md in this workspace"
                onClick={async () => {
                  if (!workspace || unavailable) return;
                  const created = await createInstructions(workspace.id);
                  if (!mounted.current) return;
                  if (created) await refresh();
                  else setError(desk().activity.error);
                }}
              >
                <FilePlus2 className="size-3.5" />Create instructions
              </Button>
            ) : null}
          </div>
          {error ? <p className="mb-2 text-[12px] text-destructive" role="alert">{error}</p> : null}
          {!inventory ? <p className="flex items-center gap-2 py-3 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading resources…</p> : null}
          {inventory ? (
            <div className="space-y-5">
              <ResourceSection title="Instructions" empty="No AGENTS.md in this workspace yet.">
                {(inventory.instructions || []).map(entry => (
                  <ResourceRow
                    key={entry.path}
                    icon={FileText}
                    title={entry.name}
                    detail={entry.path}
                    actions={<>
                      <Button size="xs" variant="ghost" onClick={() => openEditor('instructions', entry.path)}><Pencil className="size-3" />Edit</Button>
                      <Button size="xs" variant="ghost" onClick={() => {void resourceFileAction('reveal', {workspaceId: workspace!.id, path: entry.path});}}><Download className="size-3" />{runtime.server ? 'Copy server path' : 'Reveal'}</Button>
                    </>}
                  />
                ))}
              </ResourceSection>
              <ResourceSection title="Skills" empty="No skills yet. A skill is a Markdown instruction set invoked with /skill:name.">
                {(inventory.skills || []).map(entry => (
                  <ResourceRow
                    key={entry.path} icon={Sparkles} title={entry.name} detail={entry.description || entry.path}
                    actions={<>
                      <Button size="xs" variant="secondary" onClick={() => use(entry, 'skill')}>Use</Button>
                      <Button size="xs" variant="ghost" onClick={() => openEditor('skill', entry.path)}><Pencil className="size-3" />Edit</Button>
                    </>}
                  />
                ))}
              </ResourceSection>
              <ResourceSection title="Templates" empty="No prompt templates yet.">
                {(inventory.templates || []).map(entry => (
                  <ResourceRow
                    key={entry.path} icon={FileText} title={entry.name} detail={entry.description || entry.path}
                    actions={<>
                      <Button size="xs" variant="secondary" onClick={() => use(entry, 'template')}>Use</Button>
                      <Button size="xs" variant="ghost" onClick={() => openEditor('template', entry.path)}><Pencil className="size-3" />Edit</Button>
                    </>}
                  />
                ))}
              </ResourceSection>
              {(inventory.diagnostics || []).length ? (
                <ResourceSection title="Diagnostics" empty="">
                  <ul className="space-y-1">{(inventory.diagnostics || []).map((line, index) => <li key={index} className="text-[11.5px] leading-relaxed break-words text-[var(--warning)]">{line}</li>)}</ul>
                </ResourceSection>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="border-t px-5 py-3"><Button variant="secondary" onClick={() => closeModalId(modal.id)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResourceSection({title, empty, children}: {title: string; empty: string; children?: React.ReactNode}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section>
      <h3 className="mb-1.5 text-[13px] font-semibold">{title}</h3>
      {hasChildren ? <div className="space-y-1">{children}</div> : empty ? <p className="text-[11.5px] text-muted-foreground">{empty}</p> : null}
    </section>
  );
}

function ResourceRow({icon: Icon, title, detail, actions}: {icon: typeof FileText; title: string; detail: string; actions: React.ReactNode}) {
  return (
    <div data-resource-path="" className="flex items-center gap-2 rounded-md border px-2.5 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px]">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
    </div>
  );
}

export function ResourceEditorDialog({modal}: {modal: ModalOf<'resource-editor'>}) {
  const workspace = useDesk(store => store.state.workspaces.find(entry => entry.id === modal.workspaceId));
  const [loading, setLoading] = useState(!!modal.path);
  const [name, setName] = useState('');
  const [content, setContent] = useState(defaultContent(modal.resourceKind));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!modal.path) return;
    let active = true;
    void request('/api/resource-content', {query: {workspaceId: modal.workspaceId, path: modal.path}}).then(result => {
      if (!active) return;
      setContent(result.content);
      setName(modal.path!.split('/').pop()?.replace(/\.md$/, '') || '');
    }).catch(failure => {if (active) setError(failure instanceof Error ? failure.message : String(failure));}).finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [modal.path, modal.workspaceId]);

  const save = async (remove = false) => {
    setError('');
    setBusy(true);
    try {
      let body = content;
      if (!modal.path && modal.resourceKind === 'skill') body = body.replace(/^name: my-skill$/m, `name: ${name}`);
      const ok = await saveResource({workspaceId: modal.workspaceId, kind: modal.resourceKind, path: modal.path || '', name, content: body, remove});
      if (ok) {
        closeModalId(modal.id);
        window.dispatchEvent(new CustomEvent('pith:resources-changed'));
      } else setError(desk().activity.error);
    } finally {setBusy(false);}
  };

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{modal.path ? 'Edit resource' : modal.resourceKind === 'skill' ? 'Create skill' : modal.resourceKind === 'template' ? 'Create template' : 'Project instructions'}</DialogTitle>
          <DialogDescription>{modal.path ? <span data-resource-path="">{modal.path}</span> : 'Saved as Markdown in this workspace.'}</DialogDescription>
          {workspace ? <code data-workspace-path="" className="font-mono text-[11px] text-muted-foreground">{workspace.path}</code> : null}
        </DialogHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {loading ? <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading…</p> : null}
          {modal.resourceKind !== 'instructions' ? (
            <label className="block space-y-1 text-[12px]"><span className="font-medium">Name</span><Input aria-label="Name" value={name} onChange={event => setName(event.target.value)} /></label>
          ) : null}
          <label className="block space-y-1 text-[12px]"><span className="font-medium">Markdown</span><Textarea aria-label="Markdown" value={content} onChange={event => setContent(event.target.value)} className="min-h-72 font-mono text-[12px]" /></label>
          {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter className="border-t px-5 py-3">
          {modal.path ? (
            <Button
              variant="ghost" className="mr-auto text-destructive" disabled={busy}
              onClick={() => {
                const confirmId = modalId('confirm');
                desk().openModal({
                  kind: 'confirm', id: confirmId, title: 'Delete resource?', action: 'Delete resource',
                  description: {before: 'Permanently delete ', subject: modal.path, after: ' from this workspace?'},
                  hint: 'The Markdown file will be removed from your computer.',
                  async run() {
                    const ok = await saveResource({workspaceId: modal.workspaceId, kind: modal.resourceKind, path: modal.path || '', name, content, remove: true});
                    if (!ok) {
                      desk().patchModal(confirmId, {error: desk().activity.error});
                      return false;
                    }
                    closeModalId(modal.id);
                    window.dispatchEvent(new CustomEvent('pith:resources-changed'));
                    return true;
                  },
                });
              }}
            >
              <Trash2 className="size-3.5" />Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => closeModalId(modal.id)}>Cancel</Button>
          <Button disabled={busy || loading || !content.trim()} onClick={() => {void save();}}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Save resource</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
