import {useEffect, useRef} from 'react';
import {ArrowUpRight, Globe, LoaderCircle, RotateCw} from 'lucide-react';
import {navigateWebPreview, placeWebPreview, updateWebPreview} from '@/actions/web-preview';
import {runtime} from '@/lib/runtime';
import {useDesk} from '@/stores/desk';
import {emptyWebPreview, useWorkspaceTools} from '@/stores/workspace-tools';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';

export function WebPreviewView({workspaceId, tabId, active}: {workspaceId: string; tabId: string; active: boolean}) {
  const {address, current, pending, error, opened} = useWorkspaceTools(store => store.previews[tabId] || emptyWebPreview);
  const closing = useWorkspaceTools(store => store.workspaces[workspaceId]?.closing === tabId);
  const modalOpen = useDesk(store => store.modals.length > 0);
  const placeholder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runtime.nativeBrowser || !opened) return;
    let frame = 0;
    let attempts = 30;
    const visible = active && !modalOpen;
    const sendBounds = () => {
      const rect = visible ? placeholder.current?.getBoundingClientRect() : undefined;
      if (visible && (!rect || rect.width < 1 || rect.height < 1) && attempts-- > 0) {
        frame = requestAnimationFrame(sendBounds);
        return;
      }
      placeWebPreview(tabId, rect && rect.width > 0 && rect.height > 0
        ? {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)} : null);
    };
    sendBounds();
    const observer = new ResizeObserver(sendBounds);
    if (visible && placeholder.current) observer.observe(placeholder.current);
    if (visible) window.addEventListener('resize', sendBounds);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', sendBounds);
      placeWebPreview(tabId, null);
    };
  }, [active, modalOpen, opened, tabId]);

  const navigate = (value: string) => navigateWebPreview(workspaceId, tabId, value);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Web address" placeholder="https://localhost:3000" value={address}
          disabled={closing}
          onChange={event => updateWebPreview(tabId, {address: event.target.value})}
          onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); void navigate(address);}}}
          className="h-7 text-[12px]"
        />
        <Button
          variant="ghost" size="icon-xs" aria-label="Open address" title="Open address"
          disabled={!address.trim() || pending || closing} onClick={() => {void navigate(address);}}
        >
          <ArrowUpRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost" size="icon-xs" aria-label="Refresh" title="Refresh"
          disabled={!current || pending || closing} onClick={() => {void navigate(current);}}
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        </Button>
      </div>
      <div ref={placeholder} className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {runtime.nativeBrowser ? <p className="mb-2 text-[11px] text-muted-foreground">The page is shown in a native view above this panel.</p> : null}
        {error ? <p role="alert" className="text-[12px] leading-relaxed text-destructive">{error}</p> : null}
        {current ? (
          <div className="space-y-1 text-[12px] text-muted-foreground">
            <p className="break-all">Opened <strong className="font-medium text-foreground">{current}</strong></p>
            <p>{runtime.nativeBrowser ? 'The page opens in a separate native browser view.' : 'The page opens in its own browser tab, isolated from Pith Desk credentials.'}</p>
          </div>
        ) : !error ? (
          <p className="text-[12px] text-muted-foreground">Enter a local project address. The page opens in its own tab.</p>
        ) : null}
      </div>
    </div>
  );
}
