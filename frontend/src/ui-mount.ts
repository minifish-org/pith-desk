import {createApplication, type ApplicationOptions} from 'pith-ui/app';

export function mountApplication(options: ApplicationOptions) {
  const root = document.getElementById('app');
  if (!(root instanceof HTMLElement)) throw new Error('The application mount is missing.');
  return createApplication(root, options);
}
