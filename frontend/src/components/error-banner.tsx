import {AlertTriangle, X} from 'lucide-react';
import {desk, useDesk} from '@/stores/desk.ts';
import {Button} from '@/components/ui/button';

/** The single page-level error surface. Actions write the message to the store;
 * this banner never owns retry policy. */
export function ErrorBanner() {
  const error = useDesk(store => store.activity.error);
  if (!error) return null;
  return (
    <div role="alert" data-inline-error="" className="fixed top-[calc(var(--frame-header-height)+8px)] left-1/2 z-30 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg border border-destructive/30 bg-card px-3 py-2 shadow-lg">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-[12px] leading-relaxed break-words">{error}</p>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={() => desk().setError('')}><X className="size-3" /></Button>
    </div>
  );
}
