const compactNumbers = new Intl.NumberFormat('en-US', {notation: 'compact', maximumSignificantDigits: 3});
const currency = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2});
const smallCurrency = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumSignificantDigits: 3});

export const compactNumber = (value: number) => compactNumbers.format(value || 0).replace('K', 'k');

export function money(value: number): string {
  return (value !== 0 && Math.abs(value) < 0.01 ? smallCurrency : currency).format(value);
}

export function formatCost(cost: {unavailable?: boolean; runRequests?: number; requestCount?: number; runUnknownRequests?: number; unknownRequests?: number; runTotal?: number; total?: number} | undefined, latestTask = false): string {
  if (cost?.unavailable) return 'Unavailable';
  const count = latestTask ? cost?.runRequests : cost?.requestCount;
  const unknown = (latestTask ? cost?.runUnknownRequests : cost?.unknownRequests) || 0;
  if (!count) return 'Not recorded';
  if (count === unknown) return 'Unknown';
  return `~${money((latestTask ? cost?.runTotal : cost?.total) || 0)}${unknown ? ' (partial)' : ''}`;
}

export function thinkingLabel(value: string): string {
  if (value === 'xhigh') return 'Extra high';
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

export function clockTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

export function relativeDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Earlier';
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Display a workspace file the way the workspace lists it. Paths arrive from
 * the host in native separators; the browser view is always slash separated. */
export function workspaceRelativePath(root: string, path: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = path.replace(/\\/g, '/');
  if (!base) return normalized;
  if (normalized === base) return normalized.split('/').pop() || normalized;
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  return normalized;
}
