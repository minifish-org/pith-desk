import {useCallback, useEffect, useRef, useState} from 'react';
import {Group, Panel, Separator, usePanelRef} from 'react-resizable-panels';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import {request} from '@/actions/core.ts';
import {useMediaQuery} from '@/hooks/use-media';
import {Header} from '@/components/header';
import {Sidebar} from '@/components/sidebar';
import {Conversation} from '@/components/conversation';
import {Composer} from '@/components/composer';
import {ComposerPanels} from '@/components/composer-panels';
import {RuntimeBar} from '@/components/runtime-bar';
import {ToolsRail} from '@/components/tools-rail';

type Rail = 'navigation' | 'tools';

// The grab gutter shares the rail's surface, so the colour edge alone divides
// the rail; hovering and dragging only change the cursor.
const railSeparator = 'w-[9px] shrink-0';

/** Desktop rails and narrow-screen drawers. Panel widths and collapse state are
 * view state, persisted to the host only after a user drag settles. */
export function WorkspaceLayout() {
  const desktop = useMediaQuery('(min-width: 900px)');
  const width = useDesk(store => store.navigationWidth);
  const toolsWidth = useDesk(store => store.toolsWidth);
  const navRef = usePanelRef();
  const toolsRef = usePanelRef();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(true);
  const navCollapsedRef = useRef(false);
  const toolsCollapsedRef = useRef(true);
  const toolsIntent = useRef(false);
  const [drawer, setDrawer] = useState<Rail | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const drawerPanel = useRef<HTMLDivElement>(null);
  const sizes = useRef({navigation: width, tools: toolsWidth});
  const saveTimer = useRef<number | undefined>(undefined);
  const measured = useRef(false);
  const restored = useRef(false);

  const closeDrawer = useCallback(() => {
    const trigger = drawerTrigger.current;
    setDrawer(null);
    // When navigation opens a dialog, that dialog owns focus.
    requestAnimationFrame(() => {if (!document.querySelector('[role="dialog"]')) trigger?.focus();});
  }, []);

  useEffect(() => {
    if (desktop || !drawer) return;
    const frame = requestAnimationFrame(() => drawerPanel.current?.querySelector<HTMLButtonElement>(`[aria-label="Close ${drawer}"]`)?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      if (document.activeElement?.closest('.xterm')) return;
      event.preventDefault();
      closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => {cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey);};
  }, [desktop, drawer, closeDrawer]);

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
    // Closing a rail retires any pending attempt to restore its width.
    if (!panel || !target || panel.isCollapsed()) return;
    panel.resize(target);
    if (attempts > 0 && Math.abs(panel.getSize().inPixels - target) > 2) {
      requestAnimationFrame(() => applyWidth(ref, target, attempts - 1));
    }
  };
  const openDrawer = (which: Rail, trigger?: HTMLElement) => {
    drawerTrigger.current = trigger ?? (document.activeElement as HTMLElement | null);
    setDrawer(which);
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
  const closeRail = (which: Rail) => {
    if (which === 'tools') toolsIntent.current = false;
    (which === 'navigation' ? navRef : toolsRef).current?.collapse();
    focusWhenAvailable(`[aria-label="Toggle ${which}"]`);
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
    <>
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
          <Separator aria-label="Resize navigation" className={cn(railSeparator, navCollapsed ? 'bg-transparent after:hidden' : 'bg-sidebar')} />
          <Panel id="main" minSize={320}>{main}</Panel>
          <Separator aria-label="Resize tools" className={cn(railSeparator, toolsCollapsed ? 'bg-transparent after:hidden' : 'bg-sidebar')} />
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
      {!desktop && drawer ? (
        <div className="fixed inset-0 z-40">
          <button type="button" aria-label={`Close ${drawer} overlay`} className="absolute inset-0 bg-black/25" onClick={closeDrawer} />
          <div ref={drawerPanel} data-drawer-panel="" className={`absolute inset-y-0 shadow-xl ${drawer === 'navigation' ? 'left-0 bg-sidebar' : 'right-0 w-[min(340px,90vw)]'}`}>
            {drawer === 'navigation'
              ? <Sidebar overlay onCollapse={closeDrawer} onNavigate={closeDrawer} />
              : <ToolsRail onClose={closeDrawer} overlay />}
          </div>
        </div>
      ) : null}
    </>
  );
}
