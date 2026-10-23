import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Globe, LoaderCircle, RotateCw} from 'lucide-react';
import {request} from '@/actions/core';
import {runtime} from '@/lib/runtime';
import {useDesk} from '@/stores/desk';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';

function reserveTab(): {navigate(url: string): void; close(): void} {
  // Reserve during the user gesture; authorization finishes asynchronously.
  const tab = window.open('about:blank', '_blank');
  if (!tab) throw new Error('Allow new tabs for Pith Desk, then try again.');
  tab.opener = null;
  return {
    navigate(url: string) {tab.location.replace(url);},
    close() {tab.close();},
  };
}

export function WebPreviewView({workspaceId, tabId, active}: {workspaceId: string; tabId: string; active: boolean}) {
  const [address, setAddress] = useState('');
  const [current, setCurrent] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const modalOpen = useDesk(store => store.modals.length > 0);
  const placeholder = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  const sendBounds = (id: string, visible: boolean, attempts = 30) => {
    if (!runtime.nativeBrowser) return;
    const rect = visible ? placeholder.current?.getBoundingClientRect() : undefined;
    if (visible && (!rect || rect.width < 1 || rect.height < 1)) {
      if (attempts > 0) requestAnimationFrame(() => sendBounds(id, visible, attempts - 1));
      return;
    }
    const bounds = rect && rect.width > 0 && rect.height > 0
      ? {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)}
      : null;
    void request('/api/web-preview/view', {id, bounds}).catch(() => {});
  };

  useEffect(() => () => {
    generation.current++;
    if (runtime.nativeBrowser && opened.current) {
      void request('/api/web-preview/view', {id: tabId, bounds: null}).catch(() => {});
      void request('/api/web-preview/close', {id: tabId}).catch(() => {});
    }
  }, [tabId]);

  useEffect(() => {
    if (!runtime.nativeBrowser || !opened.current) return;
    sendBounds(tabId, active && !modalOpen);
    if (!active || modalOpen) return;
    const observer = new ResizeObserver(() => sendBounds(tabId, true));
    if (placeholder.current) observer.observe(placeholder.current);
    const onResize = () => sendBounds(tabId, true);
    window.addEventListener('resize', onResize);
    return () => {observer.disconnect(); window.removeEventListener('resize', onResize);};
  }, [active, modalOpen, tabId]);

  const navigate = async (value: string) => {
    const target = value.trim();
    if (!target || pending) return;
    setAddress(target);
    setPending(true);
    setError('');
    let reserved: ReturnType<typeof reserveTab> | null = null;
    if (!runtime.nativeBrowser) {
      try {reserved = reserveTab();} catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setPending(false);
        return;
      }
    }
    const sequence = ++generation.current;
    try {
      const result = await request('/api/web-preview', {id: tabId, workspaceId, address: target});
      if (sequence !== generation.current) {reserved?.close(); return;}
      if (reserved) reserved.navigate(result.url);
      if (runtime.nativeBrowser) {
        opened.current = true;
        requestAnimationFrame(() => sendBounds(tabId, active));
      }
      setCurrent(target);
    } catch (failure) {
      reserved?.close();
      if (sequence === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (sequence === generation.current) setPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Web address" placeholder="https://localhost:3000" value={address}
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); void navigate(address);}}}
          className="h-7 text-[12px]"
        />
        <Button
          variant="ghost" size="icon-xs" aria-label="Open address" title="Open address"
          disabled={!address.trim() || pending} onClick={() => {void navigate(address);}}
        >
          <ArrowUpRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost" size="icon-xs" aria-label="Refresh" title="Refresh"
          disabled={!current || pending} onClick={() => {void navigate(current);}}
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
        {active ? null : null}
      </div>
    </div>
  );
}
