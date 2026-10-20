import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';

export function localUIArguments(args: readonly string[]) {
  const remaining: string[] = [];
  let uiSource: string | undefined;
  for (let index = 0;index < args.length;index++) {
    const argument = args[index];
    if (argument !== '--ui-source' && !argument.startsWith('--ui-source=')) {remaining.push(argument);continue;}
    const value = argument === '--ui-source' ? args[++index] : argument.slice('--ui-source='.length);
    if (uiSource !== undefined || !value || value.startsWith('--')) throw new Error('Use --ui-source PATH once, with the Pith UI checkout directory.');
    uiSource = value;
  }
  return {uiSource,args: remaining};
}

/** Explicit development input; never modifies the registry install or lockfile. */
export async function readLocalUI(directory: string | undefined) {
  if (directory === undefined) return;
  const root = await realpath(path.resolve(directory));
  const metadata = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  if (metadata.name !== 'pith-ui') throw new Error('--ui-source must point to a Pith UI checkout.');
  const entries = {
    'pith-ui': path.join(root,'src/index.ts'),
    'pith-ui/recipes': path.join(root,'src/recipes/index.ts'),
    'pith-ui/styles.css': path.join(root,'src/styles.css'),
  };
  for (const file of Object.values(entries)) if (!(await stat(file)).isFile()) throw new Error(`Missing Pith UI source entry: ${file}`);
  return {root,entries};
}
export type LocalUI = NonNullable<Awaited<ReturnType<typeof readLocalUI>>>;

export function localUIResolution(source: LocalUI | undefined) {
  return source ? {
    alias: Object.entries(source.entries).map(([entry,replacement]) => ({find: new RegExp('^' + entry.replaceAll('.','\\.') + '$'),replacement})),
  } : undefined;
}
