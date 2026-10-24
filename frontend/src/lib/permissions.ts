import type {Conversation, PermissionMode} from '@/contract.generated.ts';

// One source of truth for permission modes and their user-facing copy. The
// transport contract owns the values; this module owns how the interface
// names and explains them.
export const permissionModes: readonly PermissionMode[] = ['ask', 'workspace-write', 'full-access'];

export const permissionLabels: Record<PermissionMode, string> = {
  ask: 'Ask before changes',
  'workspace-write': 'Allow workspace changes',
  'full-access': 'Full access',
};

export const permissionDescriptions: Record<PermissionMode, string> = {
  ask: 'Reads run freely. File changes, commands and external tools need approval.',
  'workspace-write': 'Workspace files may change. Commands still need approval.',
  'full-access': 'Every enabled tool runs without asking. Use with care.',
};

export function permissionModeOf(conversation: Conversation | undefined): PermissionMode {
  const mode = conversation?.permissionMode;
  return mode === 'workspace-write' || mode === 'full-access' ? mode : 'ask';
}
