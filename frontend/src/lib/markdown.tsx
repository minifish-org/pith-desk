import {useEffect, useRef} from 'react';
import DOMPurify from 'dompurify';
import {marked} from 'marked';

marked.setOptions({gfm: true, breaks: true});

/** Render model Markdown once per text revision, then sanitize the result.
 * Raw HTML in model output is never trusted. */
function markdownHTML(text: string): string {
  const html = marked.parse(text, {async: false}) as string;
  return DOMPurify.sanitize(html, {USE_PROFILES: {html: true}, FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed', 'img'], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i});
}

const copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

function decorate(container: HTMLElement, onCopyCode: (text: string) => void): void {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('code-block')) continue;
    const code = pre.querySelector('code');
    if (!code) continue;
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice('language-'.length) || '';
    const block = document.createElement('div');
    block.className = 'code-block group/code my-3 overflow-hidden rounded-lg border border-border/70 bg-[var(--code-surface)]';
    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground';
    const label = document.createElement('span');
    label.textContent = language || 'code';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.copyCode = '';
    button.setAttribute('aria-label', 'Copy code');
    button.className = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
    button.innerHTML = `${copyIcon}<span>Copy</span>`;
    button.addEventListener('click', () => {
      const text = code.textContent || '';
      onCopyCode(text);
      button.querySelector('span')!.textContent = 'Copied';
      window.setTimeout(() => {button.querySelector('span')!.textContent = 'Copy';}, 1400);
    });
    toolbar.append(label, button);
    pre.replaceWith(block);
    block.append(toolbar, pre);
    for (const cls of ['m-0', 'rounded-none', 'border-0', 'bg-transparent']) pre.classList.add(cls);
  }
}

function useMarkdown(container: React.RefObject<HTMLDivElement | null>, text: string, onCopyCode: (text: string) => void, resolveLocalFile: (href: string) => string | null, onLocalFile: (path: string) => void): void {
  const handlers = useRef({onCopyCode, resolveLocalFile, onLocalFile});
  handlers.current = {onCopyCode, resolveLocalFile, onLocalFile};
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    element.innerHTML = markdownHTML(text);
    decorate(element, value => handlers.current.onCopyCode(value));
    for (const link of element.querySelectorAll('a')) {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noreferrer noopener');
        continue;
      }
      const path = href ? handlers.current.resolveLocalFile(href) : null;
      if (path) {
        link.classList.add('local-file-link');
        link.setAttribute('data-download-path', path);
        link.setAttribute('aria-disabled', 'false');
      }
    }
  }, [container, text]);

  // One delegated handler survives re-renders and never trusts a forged
  // data attribute: the path always comes from the sanitized href.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a');
      if (!anchor || !element.contains(anchor)) return;
      const href = anchor.getAttribute('href') || '';
      const path = href ? handlers.current.resolveLocalFile(href) : null;
      if (!path) return;
      event.preventDefault();
      handlers.current.onLocalFile(path);
    };
    element.addEventListener('click', onClick);
    return () => element.removeEventListener('click', onClick);
  }, [container]);
}

export function Markdown({text, onCopyCode, resolveLocalFile, onLocalFile, className}: {text: string; onCopyCode: (text: string) => void; resolveLocalFile: (href: string) => string | null; onLocalFile: (path: string) => void; className?: string}) {
  const ref = useRef<HTMLDivElement>(null);
  useMarkdown(ref, text, onCopyCode, resolveLocalFile, onLocalFile);
  return <div ref={ref} className={`markdown ${className || ''}`} />;
}
