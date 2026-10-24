// Conversation permission picker. Mode metadata comes from `lib/permissions.ts`;
// saving goes through the conversation action layer.
import {ChevronDown, Shield, ShieldAlert, ShieldCheck} from 'lucide-react';
import {cn} from '@/lib/utils';
import {changePermission} from '@/actions/conversations.ts';
import {permissionDescriptions, permissionLabels, permissionModes} from '@/lib/permissions.ts';
import {Button} from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {PermissionMode} from '@/contract.generated.ts';

const icons = {ask: Shield, 'workspace-write': ShieldCheck, 'full-access': ShieldAlert} as const;

export function PermissionControl({mode, disabled}: {mode: PermissionMode; disabled: boolean}) {
  const Icon = icons[mode];
  const label = permissionLabels[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button" variant="ghost" size="sm"
          className={cn('h-8 gap-1.5 rounded-md border border-transparent px-2 text-[12px] text-muted-foreground hover:bg-accent max-[680px]:size-11 max-[680px]:justify-center max-[680px]:px-0', mode === 'full-access' && 'border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning-text)]')}
          aria-label="Conversation permissions"
          title={label}
          disabled={disabled}
        >
          <Icon className="size-3.5" />
          <span data-select-value="" className="hidden min-[681px]:inline">{label}</span>
          <ChevronDown className="size-3 opacity-60 max-[680px]:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Conversation permissions</DropdownMenuLabel>
        {permissionModes.map(value => {
          const Icon = icons[value];
          return (
            <DropdownMenuItem key={value} onSelect={() => {void changePermission(value);}} className="items-start gap-2 py-2">
              <Icon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{permissionLabels[value]}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{permissionDescriptions[value]}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground">Saved for this conversation. Full access has no OS sandbox.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
