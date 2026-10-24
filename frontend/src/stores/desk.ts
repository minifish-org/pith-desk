import {create} from 'zustand';
import {initialState, type ConnectionStatus, type State} from '@/app-state.ts';
import type {AppearanceMode, Artifact, DraftScope} from '@/contract.generated.ts';

export type {ConnectionStatus};

export interface DraftImage {
  id: string;
  type: 'image';
  data: string;
  mimeType: string;
  name: string;
  size: number;
  url: string;
}

export interface Notice {
  id: string;
  runID: string;
  title: string;
  workspace: string;
}

export interface Description {
  before: string;
  subject?: string;
  after?: string;
}

export type ServerPhase = 'login' | 'blocked' | 'offline';

export type Modal =
  | {
      kind: 'confirm'; id: string; title: string; action: string; description: Description; hint?: string;
      error?: string; disabled?: boolean; run: () => Promise<boolean>; onClose?: () => void;
    }
  | {kind: 'rename'; id: string; conversationId: string; title: string; disabled?: boolean; error?: string}
  | {kind: 'workspace'; id: string; error?: string}
  | {kind: 'full-access'; id: string; conversationId: string; title: string; disabled?: boolean; error?: string}
  | {
      kind: 'editor'; id: string; slot: 'message' | 'queue'; targetId: string; title: string; submitLabel: string;
      value: string; note?: string; error?: string; disabled?: boolean;
      conversationId?: string; expectedLastMessageId?: string;
    }
  | {kind: 'image'; id: string; src: string; alt: string; onClose?: () => void}
  | {kind: 'server'; id: string; phase: ServerPhase; error?: string; recoveryText?: string}
  | {kind: 'recovered'; id: string; text: string}
  | {kind: 'settings'; id: string}
  | {kind: 'connections'; id: string}
  | {kind: 'resources'; id: string}
  | {kind: 'custom-connection'; id: string; connectionId?: string}
  | {kind: 'provider-login'; id: string; provider: string}
  | {kind: 'history'; id: string}
  | {kind: 'preview'; id: string; owner: {kind: 'workspace' | 'artifact'; id: string}; path: string}
  | {kind: 'resource-editor'; id: string; workspaceId: string; resourceKind: 'skill' | 'template' | 'instructions'; path?: string};

export type ModalOf<Kind extends Modal['kind']> = Extract<Modal, {kind: Kind}>;

// The store has two layers: `state` is the latest host snapshot, while the
// remaining fields are page-local UI state. Actions mutate it; components read.
interface DeskStore {
  state: State;
  loaded: boolean;
  connection: ConnectionStatus;
  receivedAt: number;
  activity: {busy: boolean; error: string};
  appearance: AppearanceMode;
  selectedWorkspaceId: string;
  search: string;
  navigationWidth: number;
  toolsWidth: number;
  modals: Modal[];
  composer: {
    text: string;
    images: DraftImage[];
    loading: boolean;
    reading: boolean;
    resolving: boolean;
    dropPending: boolean;
    generation: number;
  };
  artifacts: {files: Artifact[]; loading: boolean; error: string};
  notices: Notice[];

  setSnapshot(next: State, connection: ConnectionStatus, receivedAt: number): void;
  setConnection(connection: ConnectionStatus): void;
  setLoaded(loaded: boolean): void;
  setBusy(busy: boolean): void;
  setError(error: string): void;
  setAppearance(appearance: AppearanceMode): void;
  selectWorkspaceId(id: string): void;
  setSearch(search: string): void;
  setWidths(widths: {navigation?: number; tools?: number}): void;
  setComposer(patch: Partial<DeskStore['composer']>): void;
  setArtifacts(patch: Partial<DeskStore['artifacts']>): void;
  setNotices(notices: Notice[]): void;
  openModal(modal: Modal): void;
  closeModal(id: string): void;
  patchModal(id: string, patch: Record<string, unknown>): void;
}

export const useDesk = create<DeskStore>((set) => ({
  state: initialState('system'),
  loaded: false,
  connection: 'connecting',
  receivedAt: performance.now(),
  activity: {busy: false, error: ''},
  appearance: 'system',
  selectedWorkspaceId: '',
  search: '',
  navigationWidth: 260,
  toolsWidth: 300,
  modals: [],
  composer: {text: '', images: [], loading: false, reading: false, resolving: false, dropPending: false, generation: 0},
  artifacts: {files: [], loading: false, error: ''},
  notices: [],
  setSnapshot: (state, connection, receivedAt) => set({state, connection, receivedAt, loaded: true}),
  setConnection: connection => set({connection}),
  setLoaded: loaded => set({loaded}),
  setBusy: busy => set(previous => ({activity: {...previous.activity, busy}})),
  setError: error => set(previous => ({activity: {...previous.activity, error}})),
  setAppearance: appearance => set({appearance}),
  selectWorkspaceId: selectedWorkspaceId => set({selectedWorkspaceId}),
  setSearch: search => set({search}),
  setWidths: widths => set(previous => ({
    navigationWidth: widths.navigation ?? previous.navigationWidth,
    toolsWidth: widths.tools ?? previous.toolsWidth,
  })),
  setComposer: patch => set(previous => ({composer: {...previous.composer, ...patch}})),
  setArtifacts: patch => set(previous => ({artifacts: {...previous.artifacts, ...patch}})),
  setNotices: notices => set({notices}),
  openModal: modal => set(previous => ({modals: [...previous.modals.filter(entry => entry.id !== modal.id), modal]})),
  closeModal: id => set(previous => ({modals: previous.modals.filter(entry => entry.id !== id)})),
  patchModal: (id, patch) => set(previous => ({modals: previous.modals.map(entry => entry.id === id ? {...entry, ...patch} as Modal : entry)})),
}));

export const desk = () => useDesk.getState();

export function modalId(kind: Modal['kind']): string {
  return `${kind}-${Math.random().toString(36).slice(2, 9)}`;
}

export function closeModalId(id: string): void {
  const modal = useDesk.getState().modals.find(entry => entry.id === id);
  if (modal && 'onClose' in modal) modal.onClose?.();
  useDesk.getState().closeModal(id);
}

export function newDraftScope(state: State, selectedWorkspaceId: string): DraftScope {
  return state.activeId ? {id: state.activeId} : {workspaceId: selectedWorkspaceId};
}
