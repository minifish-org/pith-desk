import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from '../frontend/node_modules/typescript/lib/typescript.js';

const root = fileURLToPath(new URL('../',import.meta.url));

/** Type-check the frontend without bundling or running Go tests. */
export async function checkUI(): Promise<void> {
  const frontend = path.join(root,'frontend');
  const config = ts.readConfigFile(path.join(frontend,'tsconfig.json'),ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config,ts.sys,frontend);
  const diagnostics = [...parsed.errors,...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options))];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory: () => root,getCanonicalFileName: name => name,getNewLine: () => '\n'}));
  console.log(`UI types: passed (${parsed.fileNames.length} files).`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await checkUI();
}
