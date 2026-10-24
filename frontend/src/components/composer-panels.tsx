import {useState} from 'react';
import {AlertTriangle, ChevronRight, CircleDashed, ShieldAlert} from 'lucide-react';
import {cn} from '@/lib/utils';
import {useDesk} from '@/stores/desk.ts';
import {approve, queueAction, workspaceAction} from '@/actions/conversations.ts';
import {blockingWorkspaceRun, selectedWorkspace} from '@/lib/derive.ts';
import {Button} from '@/components/ui/button';
import {DiffView} from '@/components/diff';
import type {Approval, Failure, QueuedMessage} from '@/contract.generated.ts';

/** Inline surfaces between the transcript and the composer: approvals, task
 * failures and messages waiting for the running task. */
export function ComposerPanels() {
  const approval = useDesk(store => store.state.pendingApproval);
  const failure = useDesk(store => store.state.failure);
  const running = useDesk(store => store.state.running);
  const queue = useDesk(store => store.state.queuedMessages);
  const busy = useDesk(store => store.activity.busy);
  return (
    <div className="conversation-column">
      {approval ? <ApprovalCard approval={approval} disabled={busy} /> : null}
      {failure && !running ? <FailureCard failure={failure} disabled={busy} /> : null}
      {queue.length ? <PendingMessages items={queue} running={running} busy={busy} /> : null}
    </div>
  );
}

function ApprovalCard({approval, disabled}: {approval: Approval; disabled: boolean}) {
  const [showArguments, setShowArguments] = useState(false);
  const argsText = typeof approval.args === 'string' ? approval.args : JSON.stringify(approval.args, null, 2);
  const warning = approval.warning || (approval.toolName === 'run_command' ? 'This command runs with your normal computer permissions. It may access or change files outside this workspace.' : '');
  const canAlwaysAllow = approval.toolName === 'write_file' || approval.toolName === 'edit_file';
  const preview = approval.preview;
  const title = canAlwaysAllow ? 'Review file change' : approval.toolName === 'run_command' ? 'Review command' : 'Review tool request';
  return (
    <section aria-label="Tool approval" data-approval-card="" className="mb-2 overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <ShieldAlert className="size-4 shrink-0 text-[var(--warning)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{approval.toolName}</p>
        </div>
      </header>
      {warning ? (
        <p className="flex gap-2 border-b bg-[var(--warning)]/10 px-3 py-2 text-[12px] leading-snug text-[var(--warning-foreground)] dark:text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{warning}
        </p>
      ) : null}
      {preview ? (
        <div className="border-b px-3 py-2">
          <p data-approval-file="" className="truncate font-mono text-[11px] text-muted-foreground"><code>{preview.path}</code></p>
          {preview.diff ? <DiffView diff={preview.diff} truncated={preview.truncated} truncatedMessage="The diff was truncated. Approving refreshes the complete change." /> : preview.error ? <p className="mt-1 text-[12px] text-destructive">{preview.error}</p> : <p className="mt-1 text-[12px] text-muted-foreground">This change is too large or not text; review the tool arguments before allowing it.</p>}
        </div>
      ) : null}
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowArguments(value => !value)} aria-expanded={showArguments}>
        <ChevronRight className={cn('size-3 transition-transform', showArguments && 'rotate-90')} />Tool arguments
      </button>
      {showArguments ? <pre className="max-h-56 overflow-auto border-t bg-[var(--code-surface)] px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-words">{argsText}</pre> : null}
      <footer className="flex flex-wrap items-center justify-end gap-1.5 border-t bg-muted/20 px-3 py-2">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {void approve(approval.id, 'deny');}}>Deny</Button>
        {canAlwaysAllow ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => {void approve(approval.id, 'always');}}>Always allow workspace changes</Button> : null}
        <Button size="sm" disabled={disabled} onClick={() => {void approve(approval.id, 'allow');}}>Allow this action</Button>
      </footer>
    </section>
  );
}

function PendingMessages({items, running, busy}: {items: QueuedMessage[]; running: boolean; busy: boolean}) {
  return (
    <section aria-label="Pending messages" className="mb-2 rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-1.5 text-[12px] font-medium">
        <CircleDashed className="size-3.5 text-muted-foreground" />
        Pending messages
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">{items.length}</span>
      </header>
      <ul className="divide-y">
        {items.map(entry => (
          <li key={entry.id} className="flex items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[12.5px] whitespace-pre-wrap">{entry.text || '(images only)'}</p>
              {entry.imageCount ? <span className="text-[11px] text-muted-foreground">{entry.imageCount} attached image{entry.imageCount === 1 ? '' : 's'}</span> : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {running ? <Button variant="ghost" size="xs" aria-label="Steer pending message" disabled={busy} onClick={() => {void queueAction('steer', entry.id);}}>Steer</Button> : null}
              <Button variant="ghost" size="xs" aria-label="Edit pending message" disabled={busy} onClick={() => {void queueAction('edit', entry.id);}}>Edit</Button>
              <Button variant="ghost" size="xs" aria-label="Delete pending message" disabled={busy} onClick={() => {void queueAction('delete', entry.id);}}>Delete</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FailureCard({failure, disabled}: {failure: Failure; disabled: boolean}) {
  const blocked = useDesk(store => {
    const workspace = selectedWorkspace(store.state, store.selectedWorkspaceId);
    return blockingWorkspaceRun(store.state, workspace?.id)?.conversationId;
  });
  return (
    <section aria-label="Task failure" data-task-failure="" className="mb-2 rounded-xl border bg-card px-3 py-2.5">
      <p className="flex items-center gap-2 text-[13px] font-medium"><AlertTriangle className="size-4 text-destructive" />The task needs attention</p>
      <p className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-wrap">{failure.message}</p>
      {failure.advice ? <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{failure.advice}</p> : null}
      <div className="mt-2 flex gap-1.5">
        {failure.canContinue ? <Button size="sm" disabled={disabled || !!blocked} onClick={() => {void workspaceAction('continue');}}>Review and continue</Button> : null}
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => {void workspaceAction('diagnostics');}}>Save diagnostics</Button>
      </div>
    </section>
  );
}
