import {mount} from 'pith-ui';
import type {ApplicationOptions} from './ui-types';
import {createDeskComposition} from './ui-view';

export function mountApplication(options: ApplicationOptions = {}) {
  const root = document.getElementById('app');
  if (!(root instanceof HTMLElement)) throw new Error('The application mount is missing.');
  const composition = createDeskComposition(options);
  const mounted = mount(root, composition.content, {appearance: options.appearance, viewport: 'window', onStateChange: options.onUIStateChange});
  return composition.connect(mounted);
}
