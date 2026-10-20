import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from '../frontend/node_modules/typescript/lib/typescript.js';
import {checkUIConsumption,readConsumptionInput} from './ui-consumption.ts';
import {localUIArguments,readLocalUI,type LocalUI} from './local-ui.ts';

const root = fileURLToPath(new URL('../',import.meta.url));

/** The same public boundary and type checks, without bundling or Go tests. */
export async function checkUI(source?: LocalUI): Promise<void> {
  const issues = checkUIConsumption(await readConsumptionInput(root));
  if (issues.length) throw new Error(issues.map(issue => `${issue.file}:${issue.line}:${issue.column} [${issue.code}] ${issue.message}`).join('\n'));
  const frontend = path.join(root,'frontend');
  const config = ts.readConfigFile(path.join(frontend,'tsconfig.json'),ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config,ts.sys,frontend);
  const options = source ? {...parsed.options,baseUrl: frontend,paths: Object.fromEntries(Object.entries(source.entries).map(([entry,file]) => [entry,[file]]))} : parsed.options;
  const diagnostics = [...parsed.errors,...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,options))];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory: () => root,getCanonicalFileName: name => name,getNewLine: () => '\n'}));
  console.log(`UI boundary and types: passed (${source ? 'local source: ' + source.root : 'locked npm package'}).`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const {uiSource,args} = localUIArguments(process.argv.slice(2));
  if (args.length) throw new Error('Usage: npm run check:ui -- [--ui-source PATH]');
  await checkUI(await readLocalUI(uiSource));
}
