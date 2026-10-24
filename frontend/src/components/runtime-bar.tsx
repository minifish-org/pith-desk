import {useEffect, useState} from 'react';
import {ChevronRight, LoaderCircle} from 'lucide-react';
import {cn} from '@/lib/utils';
import {useDesk} from '@/stores/desk.ts';
import {loadCostReport} from '@/actions/costs.ts';
import {compactNumber, duration, formatCost, thinkingLabel} from '@/lib/format';
import {taskElapsed} from '@/lib/derive.ts';
import type {CostReport, RuntimeStatus} from '@/contract.generated.ts';

const phaseLabels: Record<string, string> = {
  starting: 'Starting',
  working: 'Working',
  tool: 'Using a tool',
  retrying: 'Retrying model request',
  compacting: 'Summarizing context',
  complete: 'Finished',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  error: 'Needs attention',
};

/** A one-line task summary that expands into the runtime ledger. */
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
  const summary = `${approval ? 'Waiting for approval' : phaseLabels[runtime.phase] || 'Ready'}${runtime.timing?.startedAt ? ` · ${time} · ${speed}` : ''} · ${compactNumber(runtime.usage.total)} tok · ${formatCost(runtime.cost)}`;
  return (
    <div className="conversation-column">
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
  if (!(runtime.cost.requestCount || runtime.cost.unavailable)) return null;
  // Keep the disclosure open across snapshots, but scope its cached read to
  // this conversation and ledger revision. A new target gets a fresh reader.
  const revision = JSON.stringify([activeId, runtime.runId, runtime.cost.requestCount, runtime.cost.unavailable]);
  return (
    <div className="mt-2 border-t pt-1.5">
      <button type="button" className="flex w-full items-center gap-1.5 py-1 text-left text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />Request breakdown
      </button>
      <CostLedgerContent key={revision} activeId={activeId} open={open} />
    </div>
  );
}

function CostLedgerContent({activeId, open}: {activeId: string; open: boolean}) {
  const [report, setReport] = useState<CostReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || report) return;
    const controller = new AbortController();
    let active = true;
    setError('');
    setLoading(true);
    void loadCostReport(activeId, controller.signal)
      .then(value => {
        if (!active) return;
        setReport(value);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError('Request breakdown could not be loaded. Reopen this section to retry.');
        setLoading(false);
      });
    return () => {active = false; controller.abort();};
  }, [open, activeId, report]);
  if (!open) return null;
  if (loading) return <p className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Loading ledger…</p>;
  if (error) return <p className="py-2 text-[11px] text-destructive">{error}</p>;
  if (!report) return null;
  return (
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
}
