import DOMPurify from 'dompurify';
import { marked } from 'marked';

export const escapeHTML = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

// Replies and file previews share the same rendering policy. Local HTML, SVG,
// remote images and scripts are never executed inside the trusted UI.
export function renderMarkdown(value: string): string {
  const html = marked.parse(value, { async: false, breaks: true }) as string;
  const safe = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'svg', 'math', 'style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'src', 'srcset'],
    ALLOW_DATA_ATTR: false,
  });
  const container = document.createElement('div');
  container.innerHTML = safe;
  for (const link of container.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) link.removeAttribute('href');
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const code of container.querySelectorAll('pre > code')) {
    const pre = code.parentElement!;
    const block = document.createElement('div');
    block.className = 'code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    toolbar.dataset.findIgnore = '';
    const language = document.createElement('span');
    language.textContent = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) || 'Code';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary-button code-copy';
    copy.dataset.copyCode = '';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    toolbar.append(language, copy);
    pre.replaceWith(block);
    block.append(toolbar, pre);
  }
  return container.innerHTML;
}

export function renderDiff(diff: string): string {
  return diff.split('\n').map((line) => {
    const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
    return `<span class="diff-line diff-${kind}">${escapeHTML(line) || ' '}</span>`;
  }).join('');
}
