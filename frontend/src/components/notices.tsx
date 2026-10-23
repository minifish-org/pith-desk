import {CircleCheck, X} from 'lucide-react';
import {useDesk} from '@/stores/desk.ts';
import {selectConversation} from '@/actions/conversations.ts';
import {dismissNotice} from '@/actions/notices.ts';
import {Button} from '@/components/ui/button';

export function Notices() {
  const notices = useDesk(store => store.notices);
  if (!notices.length) return null;
  return (
    <div className="pointer-events-none fixed top-[calc(var(--frame-header-height)+8px)] right-4 z-30 grid w-[min(340px,calc(100vw-2rem))] gap-1.5">
      {notices.map(notice => (
        <div key={notice.runID} className="pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-card p-3 shadow-lg">
          <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--success)]/15 text-[var(--success)]"><CircleCheck className="size-3.5" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium">{notice.title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{notice.workspace} · finished</p>
            <button
              type="button"
              className="mt-1 text-[11px] underline underline-offset-2 hover:text-foreground"
              onClick={() => {void selectConversation(notice.id); dismissNotice(notice.runID);}}
            >
              Open conversation
            </button>
          </div>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss notification" onClick={() => dismissNotice(notice.runID)}><X className="size-3" /></Button>
        </div>
      ))}
    </div>
  );
}
