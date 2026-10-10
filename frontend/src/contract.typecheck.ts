// Compile-only assertions: widening the client back to string/unknown makes
// these @ts-expect-error checks fail in the regular frontend typecheck.
import type { ApiRequest, ApiDownload } from './api';
import type { StreamContracts } from './contract.generated';

export function contractTypeChecks(request: ApiRequest, download: ApiDownload): void {
  void request('/api/open', { id: 'conversation' });
  void request('/api/history', { query: { id: 'conversation' } }).then((nodes) => nodes?.[0]?.parentId);
  void request('/api/workspaces', { path: '/workspace' }).then((result) => result.workspace.id);
  void download('/api/image', { id: 'conversation', message: 'message', index: 0 });
  // @ts-expect-error Unknown routes must be registered in Go first.
  void request('/api/typo', {});
  // @ts-expect-error Mutation inputs are selected by the path.
  void request('/api/open', { workspaceId: 'workspace' });
  // @ts-expect-error A required query cannot be omitted.
  void request('/api/history');
  // @ts-expect-error Query field types come from Go.
  void request('/api/history', { query: { id: 123 } });
  // @ts-expect-error Empty mutations do not accept invented fields.
  void request('/api/mcp/disconnect', { invented: true });
  // @ts-expect-error Response fields cannot be invented by a caller-supplied T.
  void request('/api/state').then((state) => state.invented);
  // @ts-expect-error Binary paths have their own typed query.
  void download('/api/image', { id: 'conversation', message: 'message', index: 'zero' });
}

export function streamTypeChecks(state: StreamContracts['/api/socket']): void {
  const needsApproval: boolean | undefined = state.runs?.[0]?.needsApproval;
  void needsApproval;
  // @ts-expect-error Stream State comes from the same Go type as HTTP State.
  const drift: number = state.running;
  void drift;
}
