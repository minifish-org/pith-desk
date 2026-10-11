const paths: Record<string, string> = {
  steer: '<path d="M4 5v7a3 3 0 0 0 3 3h13m-5-5 5 5-5 5"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  branch: '<path d="M4 12h7M11 12l9-9M14 3h6v6M11 12l9 9M14 21h6v-6"/>',
  compress: '<path d="M7 3h10M12 3v6m-3-3 3 3 3-3M5 12h14M12 21v-6m-3 3 3-3 3 3M7 21h10"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  settings: '<path d="m9.5 3-.7 2.2-2.1 1.2-2.3-.5-2.5 4.2 1.6 1.7v2.4l-1.6 1.7 2.5 4.2 2.3-.5 2.1 1.2.7 2.2h5l.7-2.2 2.1-1.2 2.3.5 2.5-4.2-1.6-1.7v-2.4l1.6-1.7-2.5-4.2-2.3.5-2.1-1.2-.7-2.2Z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z"/><path d="m8 12 3 3 5-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  terminal: '<path d="m4 7 5 5-5 5M12 17h8"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5-10 10-5 1 1-5Z"/>',
  plug: '<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-6 6v4M8 8V5M16 8V5"/>',
};
export const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.chat}</svg>`;
export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function dialogHeading(title: string, id: string, dialogId: string, eyebrow = ''): string {
  return `<div class="modal-heading"><div>${eyebrow ? `<span class="eyebrow">${escape(eyebrow)}</span>` : ''}<h2 id="${id}">${escape(title)}</h2></div><button type="button" class="quiet-icon" data-close="${dialogId}" aria-label="Close ${escape(title.toLowerCase())}">${icon('close')}</button></div>`;
}

export function showDialogError(owner: HTMLElement, message: string): void {
  const error = owner.querySelector<HTMLElement>('[data-dialog-error], .form-error[role="alert"]');
  if (error) { error.textContent = message; error.scrollIntoView({ block: 'nearest' }); }
}
