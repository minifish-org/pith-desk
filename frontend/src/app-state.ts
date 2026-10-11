import type { State as WireState, Workspace, Conversation, QueuedMessage } from './contract.generated';
export type { ProviderChoice } from './contract.generated';

// The Go snapshot normalizes these collections; retain a defensive boundary
// for an interrupted connection while using the generated wire State type.
export type State = Omit<WireState, 'workspaces' | 'conversations' | 'messages' | 'queuedMessages' | 'runs'> & {
  workspaces: Workspace[];
  conversations: Conversation[];
  messages: NonNullable<WireState['messages']>;
  queuedMessages: QueuedMessage[];
  runs: NonNullable<WireState['runs']>;
};
