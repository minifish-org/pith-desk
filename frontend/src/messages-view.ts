import type { Message } from './contract.generated.ts';
import { escape, icon } from './ui.ts';
import { renderMarkdown } from './previews.ts';
import { reconcileViews, clearViews, type View } from './views.ts';

export function createMessageView(container: HTMLElement) {
  let activeId = '';
  function update(id: string, messages: Message[], running: boolean, folds: Map<string, boolean>, showWorking = running): void {
    if (id !== activeId) { clearViews(container); activeId = id; }
    const views: View[] = [];
    // A saved final message can arrive before the run settles. Keep historical
    // response actions, but wait for completion before exposing the current turn.
    const currentTurnStart = messages.map((message) => message.role).lastIndexOf('user');
    const messageView = (message: Message, key = message.id, foldKey = '', showActions = false): View => ({
      key, signature: JSON.stringify([message, showActions]), html: () => renderMessage(id, message, folds.get(foldKey), foldKey, showActions),
    });
    let groupIndex = 0;
    for (let index = 0; index < messages.length;) {
      if (messages[index].role !== 'tool') {
        const message = messages[index];
        const showActions = message.role === 'assistant' && !!message.branchNodeId && message.status !== 'streaming' && message.status !== 'error' && !(running && index > currentTurnStart);
        views.push(messageView(message, message.id, '', showActions));
        index++;
        continue;
      }
      const start = index;
      while (index < messages.length && messages[index].role === 'tool') index++;
      const tools = messages.slice(start, index), key = `group-${groupIndex++}`;
      const runningTools = tools.filter((tool) => tool.status === 'running').length;
      const failed = tools.filter((tool) => tool.status === 'error').length;
      const label = toolGroupLabel(tools);
      views.push({ key, signature: JSON.stringify([label, tools.length, failed, runningTools]),
        html: () => `<details class="tool-group" data-tool-fold="${key}" ${folds.get(key) ? 'open' : ''}><summary>${icon('terminal')}<span class="tool-group-label">${label}</span><span class="tool-group-count">${tools.length} ${tools.length === 1 ? 'call' : 'calls'}</span>${failed ? `<span class="tool-group-failed">${failed} failed</span>` : ''}${runningTools ? `<span class="tool-group-running">${runningTools} running</span>` : ''}${icon('down')}</summary><div class="tool-group-content" data-view-children></div></details>`,
        children: tools.map((tool) => { const toolKey = `${key}-tool-${tool.toolCallId || tool.id}`; return messageView(tool, toolKey, toolKey); }),
      });
    }
    if (showWorking) views.push({ key: 'working', signature: 'working', html: () => '<div class="agent-working" role="status"><span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Working…</span></div>' });
    reconcileViews(container, views);
  }
  return { update };
}

function toolGroupLabel(tools: Message[]): string {
  if (tools.length === 1) return ({ list_files: 'Listed files', read_file: 'Read a file', run_command: 'Ran a command', write_file: 'Wrote a file', edit_file: 'Edited a file', tool_search: 'Searched tools', codemode: 'Ran code' } as Record<string, string>)[tools[0].toolName || ''] || 'Used a tool';
  const hasCommands = tools.some((tool) => tool.toolName === 'run_command');
  const exploredFiles = tools.every((tool) => ['list_files', 'read_file', 'grep', 'find', 'ls', 'run_command'].includes(tool.toolName || ''));
  if (tools.every((tool) => tool.toolName === 'run_command')) return 'Ran commands';
  if (exploredFiles) return hasCommands ? 'Ran commands and explored files' : 'Explored files';
  return 'Used tools';
}

function renderMessage(conversationId: string, message: Message, expanded = false, foldKey = '', showActions = false): string {
  const text = message.text ?? '';
  const images = (message.images || []).map((image) => `<img class="history-image" data-image-key="${escape(`${conversationId}/${message.id}/${image.index}`)}" data-message-id="${escape(message.id)}" data-image-index="${image.index}" alt="Image ${image.index + 1}" role="button" tabindex="0" title="Click to enlarge" loading="lazy" />`).join('');
  const gallery = images ? `<div class="message-images">${images}</div>` : '';
  const copy = showActions && text ? `<button type="button" class="quiet-icon message-action" data-copy-message="${escape(message.id)}" title="Copy response" aria-label="Copy response">${icon('copy')}</button>` : '';
  const branch = showActions ? `<button type="button" class="quiet-icon message-action" data-sdk="branch" data-sdk-idle data-node="${escape(message.branchNodeId!)}" title="Branch from this message" aria-label="Branch from this message">${icon('branch')}</button>` : '';
  const actions = copy || branch ? `<div class="message-actions">${copy}${branch}</div>` : '';
  if (message.role === 'tool') {
    const command = message.command;
    const details = command ? `<div class="command-details"><span class="tool-field-label">Command</span><pre class="command-text">${escape(command.text)}</pre><div class="command-directory"><span class="tool-field-label">Directory</span><code>${escape(command.cwd)}</code></div></div>` : '';
    const status = command ? ({ running: 'Running', done: 'Completed', error: 'Failed' } as Record<string, string>)[message.status || ''] || message.status || 'Result' : message.status || 'Result';
    const exit = command?.exitCode !== undefined ? ` · Exit ${command.exitCode}` : '';
    const output = command ? `<div class="command-output"><span class="tool-field-label">Output</span><pre>${escape(text)}</pre></div>` : `<pre>${escape(text)}</pre>`;
    return `<details class="tool-message" data-reading-id="${escape(message.id)}" data-tool-fold="${escape(foldKey)}" ${expanded ? 'open' : ''}><summary>${icon('terminal')}<span>${command ? 'Command' : escape(message.toolName || 'Tool result')}</span><span class="tool-status">${escape(status + exit)}</span>${icon('down')}</summary>${details}${output}${gallery}</details>`;
  }
  if (message.role === 'user') return `<article class="message user-message" data-reading-id="${escape(message.id)}" aria-label="Your message"><div class="message-content">${gallery}${text ? `<div class="user-text">${escape(text)}</div>` : ''}</div></article>`;
  if (message.role === 'system') return `<div class="system-message" data-reading-id="${escape(message.id)}">${escape(text)}</div>`;
  return `<article class="message assistant-message" data-reading-id="${escape(message.id)}" aria-label="Agent response"><div class="message-content"><div class="markdown">${renderMarkdown(text, conversationId)}</div>${message.status === 'error' ? '<span class="message-error-label">Response interrupted</span>' : ''}${actions}</div></article>`;
}
