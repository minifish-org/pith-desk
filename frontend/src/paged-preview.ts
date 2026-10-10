import { renderDiff, renderMarkdown } from './previews.ts';

// A rendering window, not a file acceptance cap. Large Markdown is shown as
// original text so page boundaries cannot change the meaning of fenced code.
export const previewPageBytes = 256 * 1024;

export function previewPageRanges(bytes: Uint8Array, window = previewPageBytes): Array<[number, number]> {
  if (window < 4) throw new RangeError('A preview window must fit a UTF-8 character');
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + window, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end < bytes.length) {
      // Prefer complete lines without turning a long line into tiny pages.
      for (let i = end - 1; i >= start + window / 2 - 1; i--) {
        if (bytes[i] === 10) { end = i + 1; break; }
      }
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges.length ? ranges : [[0, 0]];
}

export function mountPagedPreview(container: HTMLElement, text: string, kind: 'text' | 'markdown' | 'diff'): void {
  const bytes = new TextEncoder().encode(text);
  const ranges = previewPageRanges(bytes);
  const content = document.createElement(kind === 'markdown' && ranges.length === 1 ? 'div' : 'pre');
  content.className = kind === 'diff' ? 'approval-diff' : content.tagName === 'DIV' ? 'markdown' : 'file-preview-text';
  if (kind === 'diff') content.setAttribute('aria-label', 'Proposed file changes');
  const toolbar = document.createElement('div');
  toolbar.className = 'feature-toolbar preview-pagination';
  const previous = document.createElement('button');
  const next = document.createElement('button');
  const status = document.createElement('span');
  status.setAttribute('aria-live', 'polite');
  for (const button of [previous, next]) { button.type = 'button'; button.className = 'secondary-button'; }
  previous.textContent = 'Previous'; next.textContent = 'Next';
  toolbar.append(previous, status, next);
  let page = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const render = () => {
    const [start, end] = ranges[page];
    const value = decoder.decode(bytes.subarray(start, end));
    if (kind === 'markdown' && ranges.length === 1) content.innerHTML = renderMarkdown(value);
    else if (kind === 'diff') content.innerHTML = renderDiff(value);
    else content.textContent = value;
    previous.disabled = page === 0; next.disabled = page === ranges.length - 1;
    status.textContent = `${page + 1} / ${ranges.length}${kind === 'markdown' && ranges.length > 1 ? ' · Plain text preview' : ''}`;
    content.scrollTop = 0;
  };
  previous.onclick = () => { page--; render(); };
  next.onclick = () => { page++; render(); };
  container.replaceChildren(...(ranges.length > 1 ? [toolbar, content] : [content]));
  render();
}
