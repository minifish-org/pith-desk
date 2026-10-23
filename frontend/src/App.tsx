import {useEffect, useRef, useState} from 'react';
import {Group, Panel, Separator, usePanelRef} from 'react-resizable-panels';
import {AlertTriangle, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import {Sidebar, SidebarDrawer} from '@/components/sidebar.tsx';
import {Header} from '@/components/header.tsx';
import {Conversation} from '@/components/message.tsx';
import {Composer} from '@/components/composer.tsx';
import {ComposerPanels, RuntimeBar} from '@/components/panels.tsx';
import {Dialogs} from '@/components/dialogs/host.tsx';
import {Notices} from '@/components/notices.tsx';
import {ToolsRail, WorkspaceToolsDrawer} from '@/components/tools.tsx';
import {TooltipProvider} from '@/components/ui/tooltip';
import {Button} from '@/components/ui/button';
import {useMediaQuery} from '@/hooks/use-media';
import {runtime} from '@/lib/runtime.ts';
import {request} from '@/actions/core.ts';

export function App() {
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 900px)').matches);
  const width = useDesk(store => store.navigationWidth);
  const toolsWidth = useDesk(store => store.toolsWidth);
  const navRef = usePanelRef();
  const toolsRef = usePanelRef();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(true);
  const navCollapsedRef = useRef(false);
  const toolsCollapsedRef = useRef(true);
  const toolsIntent = useRef(false);
  const [drawer, setDrawer] = useState<'navigation' | 'tools' | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const sizes = useRef({navigation: width, tools: toolsWidth});
  const saveTimer = useRef<number | undefined>(undefined);
  const measured = useRef(false);
  const restored = useRef(false);
  const overlay = runtime.titlebar === 'overlay';

  useEffect(() => {
    const media = matchMedia('(min-width: 900px)');
    const listener = () => setDesktop(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const firstLayout = useRef(true);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      measured.current = true;
      if (firstLayout.current) {
        firstLayout.current = false;
        setToolsCollapsed(true);
        toolsRef.current?.collapse();
      } else if (toolsIntent.current) {
        toolsRef.current?.expand();
        toolsRef.current?.resize(sizes.current.tools);
      }
      if (!navCollapsed) navRef.current?.resize(sizes.current.navigation);
    });
    return () => cancelAnimationFrame(frame);
  }, [desktop]);

  const persist = () => {
    desk().setWidths({navigation: sizes.current.navigation, tools: sizes.current.tools});
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (!desk().loaded) return;
      void request('/api/sidebar-widths', {navigation: Math.round(sizes.current.navigation), tools: Math.round(sizes.current.tools)}, {keepalive: true}).catch(error => {
        desk().setError(error instanceof Error ? error.message : String(error));
      });
    }, 250);
  };

  // Stored preferences apply after the first snapshot. A collapsed rail keeps
  // its preference and receives it when it expands.
  useEffect(() => {
    if (!desk().loaded || restored.current) return;
    restored.current = true;
    sizes.current = {navigation: width, tools: toolsWidth};
    const nav = navRef.current;
    if (nav && Math.abs(nav.getSize().inPixels - width) > 1) nav.resize(width);
    // The tools rail starts collapsed; its saved width is applied on expansion.
  }, [width, toolsWidth]);

  const focusWhenAvailable = (selector: string, attempts = 40) => {
    const tick = () => {
      const element = document.querySelector<HTMLButtonElement>(selector);
      if (element) {element.focus(); return;}
      if (attempts-- > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const focusRailClose = (label: 'Close navigation' | 'Close tools') => {
    focusWhenAvailable(`[aria-label="${label}"]`);
  };
  const applyWidth = (ref: typeof navRef, target: number, attempts = 30) => {
    const panel = ref.current;
    if (!panel || !target) return;
    panel.resize(target);
    if (attempts > 0 && Math.abs(panel.getSize().inPixels - target) > 2) {
      requestAnimationFrame(() => applyWidth(ref, target, attempts - 1));
    }
  };
  const openNavigation = (trigger?: HTMLElement) => {
    if (!desktop) {openDrawer('navigation', trigger); return;}
    navRef.current?.expand();
    applyWidth(navRef, sizes.current.navigation);
    focusRailClose('Close navigation');
  };
  const openTools = (trigger?: HTMLElement) => {
    if (!desktop) {openDrawer('tools', trigger); return;}
    toolsIntent.current = true;
    toolsRef.current?.expand();
    applyWidth(toolsRef, sizes.current.tools);
    focusRailClose('Close tools');
  };
  const closeRail = (which: 'navigation' | 'tools') => {
    if (which === 'tools') toolsIntent.current = false;
    (which === 'navigation' ? navRef : toolsRef).current?.collapse();
    focusWhenAvailable(`[aria-label="Toggle ${which}"]`);
  };
  const openDrawer = (which: 'navigation' | 'tools', trigger?: HTMLElement) => {
    drawerTrigger.current = trigger ?? (document.activeElement as HTMLElement | null);
    setDrawer(which);
  };
  const closeDrawer = () => {
    const trigger = drawerTrigger.current;
    setDrawer(null);
    requestAnimationFrame(() => trigger?.focus());
  };

  const main = (
    <main className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <Header
        showNavigationToggle={!desktop || navCollapsed}
        showToolsToggle={!desktop || toolsCollapsed}
        onOpenNavigation={openNavigation}
        onOpenTools={openTools}
      />
      <Conversation />
      <div className="min-h-0 shrink overflow-hidden">
        <div data-composer-panels="" className="scrollbar-quiet max-h-[38dvh] overflow-y-auto pt-2">
          <ComposerPanels />
          <RuntimeBar />
        </div>
      </div>
      <div className="shrink-0 pb-3">
        <Composer />
      </div>
    </main>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <div className={cn('app-root flex h-dvh w-full flex-col overflow-hidden bg-background', overlay && 'titlebar-overlay')}>
        {desktop ? (
          <Group
            orientation="horizontal"
            className="min-h-0 flex-1"
            onLayoutChanged={(_layout, meta) => {if (meta.isUserInteraction && measured.current) persist();}}
          >
            <Panel
              id="navigation" panelRef={navRef} defaultSize={width} minSize={210} maxSize={480} collapsible collapsedSize={0}
              onResize={size => {
                const collapsed = size.inPixels === 0;
                if (navCollapsedRef.current !== collapsed) {navCollapsedRef.current = collapsed; setNavCollapsed(collapsed);}
                if (!collapsed) sizes.current.navigation = size.inPixels;
              }}
            >
              <Sidebar onCollapse={() => closeRail('navigation')} />
            </Panel>
            <Separator aria-label="Resize navigation" className="group relative w-[9px] shrink-0 bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border hover:after:bg-foreground/30 data-[resize-handle-state=drag]:after:bg-foreground/40" />
            <Panel id="main" minSize={320}>
              {main}
            </Panel>
            <Separator aria-label="Resize tools" className="group relative w-[9px] shrink-0 bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border hover:after:bg-foreground/30 data-[resize-handle-state=drag]:after:bg-foreground/40" />
            <Panel
              id="tools" panelRef={toolsRef} defaultSize={toolsWidth} minSize={260} maxSize={800} collapsible collapsedSize={0}
              onResize={size => {
                const collapsed = size.inPixels === 0;
                if (toolsCollapsedRef.current !== collapsed) {toolsCollapsedRef.current = collapsed; setToolsCollapsed(collapsed);}
                if (!collapsed) sizes.current.tools = size.inPixels;
              }}
            >
              <ToolsRail visible={!toolsCollapsed} onClose={() => closeRail('tools')} />
            </Panel>
          </Group>
        ) : main}
        {!desktop ? <SidebarDrawer open={drawer === 'navigation'} onClose={closeDrawer} /> : null}
        {!desktop ? <WorkspaceToolsDrawer open={drawer === 'tools'} onClose={closeDrawer} /> : null}
        <ErrorBanner />
        <Notices />
        <Dialogs />
        <LoginWatcher />
      </div>
    </TooltipProvider>
  );
}

function ErrorBanner() {
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

function LoginWatcher() {
  const login = useDesk(store => store.state.login);
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    if (!login || dismissed.current.has(login.id)) return;
    if (desk().modals.some(modal => modal.kind === 'provider-login')) return;
    // Completion is reflected by the provider form; prompts and failures need
    // an explicit surface of their own.
    if (login.phase === 'complete') return;
    desk().openModal({kind: 'provider-login', id: `login-${login.id}`, provider: login.provider});
  }, [login]);
  return null;
}
