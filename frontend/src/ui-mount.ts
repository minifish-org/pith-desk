import {mountDesk} from './ui-assemblies/desk.ts';
import type {ApplicationOptions} from './ui-contract.ts';

export function mountApplication(options: ApplicationOptions) {
  const root = document.getElementById('app');
  if (!(root instanceof HTMLElement)) throw new Error('The application mount is missing.');
  return mountDesk(root, options);
}
