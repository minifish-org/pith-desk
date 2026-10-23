import {useMemo, useState} from 'react';
import {ChevronDown, ChevronRight, FilePen} from 'lucide-react';
import type {Artifact} from '@/contract.generated.ts';
import {desk} from '@/stores/desk.ts';
import {cn} from '@/lib/utils';
import {workspaceRelativePath} from '@/lib/format';

const collapsedRows = 4;

function ChangeCounts({additions, deletions, className}: {additions: number; deletions: number; className?: string}) {
  if (!additions && !deletions) return null;
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 tabular-nums', className)}>
      {additions ? <span className="text-emerald-700 dark:text-emerald-300">+{additions}</span> : null}
      {deletions ? <span className="text-red-700 dark:text-red-300">-{deletions}</span> : null}
    </span>
  );
}

/** The conversation's written and edited files, summarized the way the agent's
 * work reads: how many files changed, line totals and each file's path. */
export function EditedFiles({files, workspacePath, conversationId}: {files: Artifact[]; workspacePath: string; conversationId: string}) {
  const [expanded, setExpanded] = useState(false);
  const totals = useMemo(() => files.reduce((sum, file) => ({
    additions: sum.additions + (file.additions || 0),
    deletions: sum.deletions + (file.deletions || 0),
  }), {additions: 0, deletions: 0}), [files]);
  const shown = expanded ? files : files.slice(0, collapsedRows);
  const title = files.length === 1 ? 'Edited 1 file' : `Edited ${files.length} files`;
  return (
    <section data-edited-files="" aria-label={title} className="mt-6 overflow-hidden rounded-xl border bg-card text-[12px]">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <FilePen className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 data-edited-files-title="" className="truncate text-[14px] font-medium text-foreground">{title}</h2>
          {totals.additions || totals.deletions ? (
            <div data-edit-totals="" className="mt-0.5 text-[12px]">
              <ChangeCounts additions={totals.additions} deletions={totals.deletions} />
            </div>
          ) : null}
        </div>
      </header>
      <ul>
        {shown.map(file => {
          const relative = workspaceRelativePath(workspacePath, file.path);
          return (
            <li key={file.path} className="border-b last:border-b-0">
              <button
                type="button"
                data-edited-file=""
                aria-label={`Preview ${relative}`}
                title={file.path}
                className="group flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                onClick={() => {
                  desk().openModal({kind: 'preview', id: `preview-${file.path}`, owner: {kind: 'artifact', id: conversationId}, path: file.path});
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{relative}</span>
                <ChangeCounts additions={file.additions || 0} deletions={file.deletions || 0} className="text-[12px]" />
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {files.length > collapsedRows ? (
        <button
          type="button"
          data-edited-files-toggle=""
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 border-t px-4 py-2.5 text-left text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Show fewer files' : `Show all ${files.length} files`}
          <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}
