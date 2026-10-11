export type View = { key: string; signature: string; html: () => string; children?: View[] };
type Entry = { element: HTMLElement; signature: string };
let version = 0;
const entries = new WeakMap<HTMLElement, Map<string, Entry>>();

// Reuse unchanged nodes: selection, focus, decoded images, feedback and code
// scrolling belong to the reader, and must survive another message's updates.
export function reconcileViews(parent: HTMLElement, views: View[]): void {
  const previous = entries.get(parent) || new Map<string, Entry>();
  const current = new Map<string, Entry>();
  let cursor = parent.firstElementChild;
  for (const view of views) {
    let entry = previous.get(view.key);
    let scroll: number[] | undefined;
    if (!entry || entry.signature !== view.signature) {
      const template = document.createElement('template');
      template.innerHTML = view.html();
      const element = template.content.firstElementChild as HTMLElement;
      element.dataset.renderVersion = String(++version);
      if (entry && view.children) {
        // Group summaries may change while completed tool results stay intact.
        entry.element.querySelector('summary')!.replaceWith(element.querySelector('summary')!);
        entry.signature = view.signature;
      } else {
        if (entry) {
          const images = new Map(Array.from(entry.element.querySelectorAll<HTMLImageElement>('[data-image-key]'), (image) => [image.dataset.imageKey, image]));
          for (const image of element.querySelectorAll<HTMLImageElement>('[data-image-key]')) {
            const saved = images.get(image.dataset.imageKey);
            if (saved) image.replaceWith(saved);
          }
          scroll = Array.from(entry.element.querySelectorAll('pre'), (pre) => pre.scrollLeft);
          entry.element.replaceWith(element);
          if (cursor === entry.element) cursor = element;
        }
        entry = { element, signature: view.signature };
      }
    }
    if (entry.element !== cursor) parent.insertBefore(entry.element, cursor);
    if (scroll) entry.element.querySelectorAll('pre').forEach((pre, index) => { pre.scrollLeft = scroll![index] || 0; });
    cursor = entry.element.nextElementSibling;
    if (view.children) reconcileViews(entry.element.querySelector<HTMLElement>('[data-view-children]')!, view.children);
    current.set(view.key, entry);
  }
  for (const [key, entry] of previous) if (!current.has(key)) entry.element.remove();
  entries.set(parent, current);
}

export function clearViews(parent: HTMLElement): void { parent.replaceChildren(); entries.delete(parent); }
