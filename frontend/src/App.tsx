import {cn} from '@/lib/utils';
import {runtime} from '@/lib/runtime.ts';
import {WorkspaceLayout} from '@/components/workspace-layout';
import {Dialogs} from '@/components/dialogs/registry';
import {Notices} from '@/components/notices';
import {ErrorBanner} from '@/components/error-banner';
import {LoginWatcher} from '@/components/login-watcher';
import {TooltipProvider} from '@/components/ui/tooltip';

/** Application composition: the workspace shell plus page-level overlays. */
export function App() {
  const overlay = runtime.titlebar === 'overlay';
  return (
    <TooltipProvider delayDuration={250}>
      <div className={cn('app-root flex h-dvh w-full flex-col overflow-hidden bg-background', overlay && 'titlebar-overlay')}>
        <WorkspaceLayout />
        <ErrorBanner />
        <Notices />
        <Dialogs />
        <LoginWatcher />
      </div>
    </TooltipProvider>
  );
}
