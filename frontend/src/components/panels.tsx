import {useEffect, useMemo, useState} from 'react';
import {AlertTriangle, ChevronRight, CircleCheck, CircleDashed, FilePen, LoaderCircle, ShieldAlert, TerminalSquare, Wrench, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import {approve, queueAction, workspaceAction} from '@/actions/conversations.ts';
import {request} from '@/actions/core.ts';
import {compactNumber, duration, formatCost, thinkingLabel} from '@/lib/format';
import {taskElapsed, workspaceRun} from '@/lib/derive.ts';
import {Button} from '@/components/ui/button';
import type {Approval, CostReport, RuntimeStatus} from '@/contract.generated.ts';

export function ComposerPanels() {
  const approval = useDesk(store => store.state.pendingApproval);
  const failure = useDesk(store => store.state.failure);
  const running = useDesk(store => store.state.running);
  const queue = useDesk(store => store.state.queuedMessages);
  const busy = useDesk(store => store.activity.busy);
  const [notice, setNotice] = useState<Notice[]>([]);
  useEffect(() => {
    const add = (event: Event) => setNotice(value => [...value, (event as CustomEvent<Notice>).detail]);
    window.addEventListener('pith:artifact-added', add);
    return () => window.removeEventListener('pith:artifact-added', add);
  }, []);
  return (
    <div className="mx-auto w-full max-w-[54rem] px-6">
      {approval ? <ApprovalCard approval={approval} disabled={busy} /> : null}
      {failure && !running ? <FailureCard failure={failure} disabled={busy} /> : null}
      {queue.length ? <PendingMessages items={queue} running={running} busy={busy} /> : null}
      {notice.length ? <div className="mb-2 flex flex-col gap-1">{notice.map((item, index) => (
        <div key={index} className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-[12px] text-muted-foreground">
          <FilePen className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">Saved {item.path}</span>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice(value => value.filter((_, position) => position !== index))}><X className="size-3" /></Button>
        </div>
      ))}</div> : null}
    </div>
  );
}

interface Notice {path: string}

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
          {preview.diff ? <DiffView diff={preview.diff} truncated={preview.truncated} /> : preview.error ? <p className="mt-1 text-[12px] text-destructive">{preview.error}</p> : <p className="mt-1 text-[12px] text-muted-foreground">This change is too large or not text; review the tool arguments before allowing it.</p>}
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

function DiffView({diff, truncated}: {diff: string; truncated?: boolean}) {
  const lines = diff.split('\n');
  return (
    <div className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-[var(--code-surface)]">
      <pre className="font-mono text-[11.5px] leading-[1.55]">
        {lines.map((line, index) => {
          const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
          return (
            <div
              key={index}
              data-diff={kind}
              className={cn(
                'px-2 whitespace-pre-wrap break-words',
                kind === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                kind === 'remove' && 'bg-red-500/10 text-red-700 dark:text-red-300',
                kind === 'hunk' && 'bg-muted text-muted-foreground',
                kind === 'context' && 'text-muted-foreground',
              )}
            >
              {line || ' '}
            </div>
          );
        })}
      </pre>
      {truncated ? <p className="border-t px-2 py-1 text-[11px] text-muted-foreground">The diff was truncated. Approving refreshes the complete change.</p> : null}
    </div>
  );
}

function PendingMessages({items, running, busy}: {items: NonNullable<ReturnType<typeof useDesk.getState>['state']['queuedMessages']>; running: boolean; busy: boolean}) {
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

function FailureCard({failure, disabled}: {failure: NonNullable<ReturnType<typeof useDesk.getState>['state']['failure']>; disabled: boolean}) {
  const blocked = useDesk(store => {
    const conversation = store.state.conversations.find(entry => entry.id === store.state.activeId);
    const workspace = store.state.workspaces.find(entry => entry.id === (conversation?.workspaceId || store.selectedWorkspaceId)) ?? store.state.workspaces[0];
    return workspaceRun(store.state, workspace?.id)?.conversationId;
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

export function RuntimeBar() {
  const runtime = useDesk(store => store.state.runtime);
  const running = useDesk(store => store.state.running);
  const approval = useDesk(store => store.state.pendingApproval);
  const receivedAt = useDesk(store => store.receivedAt);
  const activeId = useDesk(store => store.state.activeId);
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!runtime?.model) return null;
  const elapsed = taskElapsed(useDesk.getState().state, receivedAt);
  const time = runtime.timing?.startedAt ? `${runtime.timing.partial ? '≥' : ''}${duration(elapsed)}` : 'Not recorded';
  const speed = runtime.timing?.startedAt && !runtime.timing.partial && runtime.timing.outputTokens > 0 && elapsed > 0
    ? `${compactNumber(runtime.timing.outputTokens * 1000 / elapsed)} tok/s` : '— tok/s';
  const phases: Record<string, string> = {starting: 'Starting', working: 'Working', tool: 'Using a tool', retrying: 'Retrying model request', compacting: 'Summarizing context', complete: 'Finished', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Needs attention'};
  const summary = `${approval ? 'Waiting for approval' : phases[runtime.phase] || 'Ready'}${runtime.timing?.startedAt ? ` · ${time} · ${speed}` : ''} · ${compactNumber(runtime.usage.total)} tok · ${formatCost(runtime.cost)}`;
  return (
    <div className="mx-auto w-full max-w-[54rem] px-6">
      <div className="mb-1">
        <button
          type="button"
          aria-expanded={open}
          data-runtime-summary=""
          className="flex w-full items-center gap-1.5 py-1 text-left text-[11.5px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(value => !value)}
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          <span className="truncate">{summary}</span>
        </button>
        {open ? <RuntimeDetails runtime={runtime} activeId={activeId} time={time} speed={speed} /> : null}
      </div>
    </div>
  );
}

function RuntimeDetails({runtime, activeId, time, speed}: {runtime: RuntimeStatus; activeId: string; time: string; speed: string}) {
  const n = compactNumber;
  return (
    <div data-runtime-details="" className="mb-2 max-h-[45dvh] overflow-y-auto rounded-xl border bg-card px-3 py-2.5 text-[12px]">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <Row label="Model" value={`${runtime.model}${runtime.provider ? ` · ${runtime.provider}` : ''}`} />
        {runtime.thinkingLevel ? <Row label="Thinking effort" value={thinkingLabel(runtime.thinkingLevel)} /> : null}
        <Row label="Duration" value={time} />
        <Row label="Average speed" value={speed} />
        <Row label="Input tokens" value={n(runtime.usage.input)} />
        <Row label="Output tokens" value={n(runtime.usage.output)} />
        <Row label="Cache read / write" value={`${n(runtime.usage.cacheRead)} / ${n(runtime.usage.cacheWrite)}`} />
        <Row label="Context" value={`${n(runtime.contextTokens)} / ${n(runtime.contextWindow)}`} />
        <Row label="Context summaries" value={n(runtime.compactions)} />
        <Row label="Tool failures" value={n(runtime.toolFailures)} />
        <Row label="Recorded cost" value={formatCost(runtime.cost)} />
        <Row label="Latest task" value={formatCost(runtime.cost, true)} />
      </dl>
      <CostLedger activeId={activeId} runtime={runtime} />
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">Costs are USD estimates from the bundled model catalog or your custom prices, not your provider bill. Context excludes system instructions and tool schemas.</p>
    </div>
  );
}

function Row({label, value}: {label: string; value: string}) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value}</dd></>;
}

function CostLedger({activeId, runtime}: {activeId: string; runtime: RuntimeStatus}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<CostReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const key = `${activeId}:${runtime.runId}:${runtime.cost.requestCount}`;
  const visible = !!(runtime.cost.requestCount || runtime.cost.unavailable);
  useEffect(() => {setReport(null); setError('');}, [key]);
  useEffect(() => {
    if (!open || !visible || loading || report) return;
    setLoading(true);
    void request('/api/costs', {query: {id: activeId}}).then(value => setReport(value)).catch(() => setError('Request breakdown could not be loaded. Reopen this section to retry.')).finally(() => setLoading(false));
  }, [open, visible, activeId, key]);
  if (!visible) return null;
  let body: React.ReactNode = null;
  if (loading) body = <p className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Loading ledger…</p>;
  else if (error) body = <p className="py-2 text-[11px] text-destructive">{error}</p>;
  else if (report) body = (
    <div className="mt-1 max-h-56 overflow-auto rounded-md border">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
          <tr><th className="px-2 py-1 font-medium">Purpose</th><th className="px-2 py-1 font-medium">Model</th><th className="px-2 py-1 text-right font-medium">In</th><th className="px-2 py-1 text-right font-medium">Out</th><th className="px-2 py-1 font-medium">Status</th></tr>
        </thead>
        <tbody>
          {report.requests?.map(requestEntry => (
            <tr key={requestEntry.id} className="border-t">
              <td className="px-2 py-1">{requestEntry.purpose}</td>
              <td className="px-2 py-1">{requestEntry.modelName || requestEntry.model}</td>
              <td className="px-2 py-1 text-right tabular-nums">{compactNumber(requestEntry.usage.input)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{compactNumber(requestEntry.usage.output)}</td>
              <td className="px-2 py-1">{requestEntry.status}{requestEntry.known ? '' : ' · price unknown'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="mt-2 border-t pt-1.5">
      <button type="button" className="flex w-full items-center gap-1.5 py-1 text-left text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />Request breakdown
      </button>
      {open ? body : null}
    </div>
  );
}

export function ArtifactToast() {
  return null;
}

export {CircleCheck, TerminalSquare, Wrench};
