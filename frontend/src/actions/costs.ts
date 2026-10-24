import {request} from './core.ts';
import type {CostReport} from '@/contract.generated.ts';

export function loadCostReport(conversationId: string, signal: AbortSignal): Promise<CostReport> {
  return request('/api/costs', {query: {id: conversationId}, signal});
}
