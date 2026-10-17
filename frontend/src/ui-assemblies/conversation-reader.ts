/** Internal reading composition. The host owns conversation snapshots and actions. */
import {
  createButtonPart,createInputPart,createMetadataPart,createReadingRegionPart,createReadingViewportPart,createSearchToolbarPart,
  type AnnouncementPart,type LayoutPart,type Part,type ReadingViewportPart,type SearchToolbarPart,
} from 'pith-ui';
import {composeConversationBody,type ConversationBodyCallbacks,type ConversationBodyState,type ConversationHostAvailability} from './conversation-body.js';

export interface ConversationReaderComposition {
  readonly find: SearchToolbarPart;readonly region: LayoutPart;readonly announcement: AnnouncementPart;
  update(state: Readonly<ConversationBodyState>): void;openFind(): void;closeFind(): void;
  followLatest(): void;prune(ids: readonly string[]): void;destroy(): void;
  updateHostAvailability(state: Readonly<ConversationHostAvailability>): void;
  updateAvailability(state: Readonly<Partial<Record<'copy'|'edit'|'branch',boolean>>>): void;
}
/** A search row and reading region are separate caller-assembled siblings. */
export function composeConversationReader(initial: Readonly<ConversationBodyState>,callbacks: ConversationBodyCallbacks = {},content: {before?: readonly Part[]} = {}): ConversationReaderComposition {
  const body = composeConversationBody(initial,callbacks);let viewport: ReadingViewportPart;
  const field = createInputPart({kind: 'search',label: 'Find in this conversation',placeholder: 'Find in this conversation',autocomplete: 'off',onInput(query) {viewport.search(query);},onEnter(direction) {viewport.moveMatch(direction);}});
  const count = createMetadataPart({purpose: 'search-count',text: ''});
  const previous = createButtonPart({variant: 'previous-match',icon: 'down',label: 'Previous match',title: 'Previous match (Shift+Enter)',disabled: true,onAction() {viewport.moveMatch('previous');}});
  const next = createButtonPart({variant: 'quiet-icon',icon: 'down',label: 'Next match',title: 'Next match (Enter)',disabled: true,onAction() {viewport.moveMatch('next');}});
  const close = createButtonPart({variant: 'quiet-icon',icon: 'close',label: 'Close search',title: 'Close (Esc)',onAction() {viewport.closeSearch();}});
  const find = createSearchToolbarPart({children: [field,count,previous,next,close],hidden: true});
  const latest = createButtonPart({variant: 'latest',icon: 'down',label: 'Back to latest',hidden: true,onAction() {viewport.followLatest();}});
  viewport = createReadingViewportPart({reading: body.part,children: [...content.before ?? [],body.part],
    onSearchState(state) {
      find.update({hidden: !state.open});if (field.read() !== state.query) field.reset(state.query);count.update({text: state.label});
      previous.update({variant: 'previous-match',icon: 'down',label: 'Previous match',title: 'Previous match (Shift+Enter)',disabled: !state.total});
      next.update({variant: 'quiet-icon',icon: 'down',label: 'Next match',title: 'Next match (Enter)',disabled: !state.total});
    },
    onLatestChange(visible) {latest.update({variant: 'latest',icon: 'down',label: 'Back to latest',hidden: !visible});},
    onSearchIntent(intent) {if (intent === 'open') {field.focus();field.selectAll();}},
  });
  const region = createReadingRegionPart({children: [viewport,latest]});
  const update = (state: Readonly<ConversationBodyState>) => {viewport.beforeUpdate(state.id);body.update(state);viewport.afterUpdate();};update(initial);
  return {find,region,announcement: body.announcement,update,openFind() {viewport.openSearch();},closeFind() {viewport.closeSearch();},followLatest() {viewport.followLatest();},prune(ids) {body.prune(ids);viewport.prune(ids);},
    updateAvailability: body.updateAvailability,updateHostAvailability: body.updateHostAvailability,
    destroy() {find.destroy();region.destroy();body.announcement.destroy();}};
}
