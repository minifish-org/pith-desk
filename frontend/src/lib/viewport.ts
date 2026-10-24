/** The on-screen keyboard shrinks the visual viewport without changing the
 * layout viewport. Dialogs, drawers and the composer follow `--desk-vv-*` so
 * their controls stay reachable. */
export function installVisualViewportTracking(): void {
  const sync = () => {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--desk-vv-height', `${height}px`);
    rootStyle.setProperty('--desk-vv-top', `${viewport?.offsetTop || 0}px`);
    document.documentElement.classList.toggle('visual-viewport-short', height < window.innerHeight - 1);
  };
  sync();
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
}
