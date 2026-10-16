/** Native-node operations used by the update adapter's business-state tests.
 * Browser tests cover rendering, keyboard behavior and actual DOM identity.
 * This fixture stays local to each test and never changes browser globals.
 */
class UpdateTestElement extends EventTarget {
  textContent = '';
  disabled = false;
  hidden = false;
  value = 0;
  title = '';
  readonly dataset: Record<string, string | undefined> = {};
  readonly children: readonly HTMLElement[] = [];
  readonly childNodes: readonly ChildNode[] = [];
  private readonly attributes = new Map<string, string>();

  querySelector(): null { return null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
}

export function updateElements(): {
  root: HTMLElement;
  nodes: Record<string, UpdateTestElement>;
} {
  const nodes = Object.fromEntries([
    '[data-update-version]', '[data-update-message]', '[data-update-check]', '[data-update-install]', 'progress',
  ].map(selector => [selector, new UpdateTestElement()]));
  const root = {
    querySelector: (selector: string) => nodes[selector] ?? null,
    contains: (node: unknown) => Object.values(nodes).includes(node as UpdateTestElement),
  } as unknown as HTMLElement;
  return { root, nodes };
}
