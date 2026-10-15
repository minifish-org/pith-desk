import { renderMarkdown as renderContentMarkdown } from 'pith-ui';
import { localFilePath } from './local-file-links.ts';

export { renderDiff } from 'pith-ui';
export { escape as escapeHTML } from './ui.ts';

// File identity and permissions belong to the host; content rendering belongs to the library.
export function renderMarkdown(value: string, conversationId = ''): string {
  return renderContentMarkdown(value, {
    resolveLocalLink: conversationId ? (href) => {
      const path = localFilePath(href);
      return path ? { path, conversationId } : null;
    } : undefined,
  });
}
