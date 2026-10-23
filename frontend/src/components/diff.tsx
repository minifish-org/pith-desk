import {cn} from '@/lib/utils';

/** Unified patch lines with the approval and preview views' shared colors.
 * The caller chooses whether the block is height bounded (approval) or grows
 * with its surrounding dialog scroll area (file preview). */
export function DiffView({diff, truncated, truncatedMessage = 'This diff was truncated.', className = 'mt-1.5 max-h-64 rounded-md border bg-[var(--code-surface)]'}: {
  diff: string;
  truncated?: boolean;
  truncatedMessage?: string;
  className?: string;
}) {
  const lines = diff.split('\n');
  return (
    <div data-diff-view="" className={cn('overflow-auto', className)}>
      <pre className="font-mono text-[11.5px] leading-[1.55]">
        {lines.map((line, index) => {
          const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
          return (
            <div
              key={index}
              data-diff={kind}
              className={cn(
                'px-2 whitespace-pre-wrap break-words',
                kind === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                kind === 'remove' && 'bg-red-500/10 text-red-700 dark:text-red-300',
                kind === 'meta' && 'text-muted-foreground',
                kind === 'hunk' && 'bg-muted text-muted-foreground',
                kind === 'context' && 'text-muted-foreground',
              )}
            >
              {line || ' '}
            </div>
          );
        })}
      </pre>
      {truncated ? <p className="border-t px-2 py-1 text-[11px] text-muted-foreground">{truncatedMessage}</p> : null}
    </div>
  );
}
