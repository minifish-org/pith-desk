/** Internal executable composition. All prose/count/grouping remains here;
 * the formal parts create only small native structures. */
import {
  createCompoundDisclosurePart,createDisclosureBodyPart,createIconPart,createTextPart,createMetadataPart,
  createCodePropertyPart,createPreformattedPart,
  type CompoundDisclosurePart,type Part,type PreformattedPart,type CodePropertyPart,type LayoutPart,
} from 'pith-ui';
import type {ImageReference,ImageGalleryComposition} from './conversation-images.js';

export interface ToolMessage {id: string;role: string;text: string;toolName?: string;toolCallId?: string;status?: string;command?: {text: string;cwd: string;exitCode?: number};images?: readonly ImageReference[]}
export interface ToolGroupComposition {readonly part: CompoundDisclosurePart;update(tools: readonly ToolMessage[],folds: ReadonlyMap<string,boolean>): void;folds(): ReadonlyMap<string,boolean>}
interface ResultEntry {part: CompoundDisclosurePart;key: string;update(message: ToolMessage,folds: ReadonlyMap<string,boolean>): void}

function groupLabel(tools: readonly ToolMessage[]): string {
  if (tools.length === 1) return ({list_files: 'Listed files',read_file: 'Read a file',run_command: 'Ran a command',write_file: 'Wrote a file',edit_file: 'Edited a file',tool_search: 'Searched tools',codemode: 'Ran code'} as Record<string,string>)[tools[0]!.toolName || ''] || 'Used a tool';
  const commands = tools.some(tool => tool.toolName === 'run_command');
  if (tools.every(tool => tool.toolName === 'run_command')) return 'Ran commands';
  if (tools.every(tool => ['list_files','read_file','grep','find','ls','run_command'].includes(tool.toolName || ''))) return commands ? 'Ran commands and explored files' : 'Explored files';
  return 'Used tools';
}

export function composeToolGroup(key: string,legacyKey: string,initial: readonly ToolMessage[],folds: ReadonlyMap<string,boolean>,makeGallery?: (messageId: string,images: readonly ImageReference[]) => ImageGalleryComposition): ToolGroupComposition {
  const entries = new Map<string,ResultEntry>();
  const icon = createIconPart({name: 'terminal'}),label = createMetadataPart({purpose: 'summary-label',text: ''}),count = createMetadataPart({purpose: 'count',text: ''}),chevron = createIconPart({name: 'down'});
  let failed: ReturnType<typeof createMetadataPart>|undefined,running: ReturnType<typeof createMetadataPart>|undefined;
  const content = createDisclosureBodyPart({purpose: 'group',children: []});
  const part = createCompoundDisclosurePart({purpose: 'group',foldKey: key,summary: [icon,label,count,chevron],children: [content],open: folds.get(key) ?? folds.get(legacyKey) ?? false});
  function makeResult(message: ToolMessage): ResultEntry {
    const foldKey = `${key}-tool-${message.toolCallId || message.id}`;
    const terminal = createIconPart({name: 'terminal'}),caption = createTextPart({text: ''}),status = createMetadataPart({purpose: 'trailing-state',text: ''}),down = createIconPart({name: 'down'});
    const result = createCompoundDisclosurePart({purpose: 'result',readingKey: message.id,foldKey,summary: [terminal,caption,status,down],children: [],open: folds.get(foldKey) ?? folds.get(`${legacyKey}-tool-${message.toolCallId || message.id}`) ?? false});
    let isCommand: boolean|undefined,output: PreformattedPart,command: PreformattedPart|undefined,directory: CodePropertyPart|undefined,commandDetails: LayoutPart|undefined,outputBody: LayoutPart|undefined,gallery: ImageGalleryComposition|undefined;
    const update = (next: ToolMessage,currentFolds: ReadonlyMap<string,boolean>) => {
      if (isCommand !== !!next.command) {
        result.replace([]);gallery = undefined;isCommand = !!next.command;
        output = createPreformattedPart({text: next.text});
        if (isCommand) {
          command = createPreformattedPart({kind: 'command',text: next.command!.text});directory = createCodePropertyPart({label: 'Directory',value: next.command!.cwd});
          commandDetails = createDisclosureBodyPart({purpose: 'details',children: [createMetadataPart({purpose: 'field-label',text: 'Command'}),command,directory]});
          outputBody = createDisclosureBodyPart({purpose: 'output',children: [createMetadataPart({purpose: 'field-label',text: 'Output'}),output]});
          result.replace([commandDetails,outputBody]);
        } else {command = undefined;directory = undefined;commandDetails = undefined;outputBody = undefined;result.replace([output]);}
      }
      caption.update({text: next.command ? 'Command' : next.toolName || 'Tool result'});
      const state = next.command ? ({running: 'Running',done: 'Completed',error: 'Failed'} as Record<string,string>)[next.status || ''] || next.status || 'Result' : next.status || 'Result';
      status.update({text: state+(next.command?.exitCode !== undefined ? ` · Exit ${next.command.exitCode}` : ''),tone: next.status === 'error' ? 'error' : 'neutral'});
      output.update({text: next.text});command?.update({text: next.command!.text});directory?.update({label: 'Directory',value: next.command!.cwd});
      if (next.images?.length && makeGallery) {if (!gallery) gallery = makeGallery(next.id,next.images);else gallery.update(next.images);}else {gallery?.part.destroy();gallery = undefined;}
      result.replace([...(commandDetails ? [commandDetails,outputBody!] : [output]),...(gallery ? [gallery.part] : [])]);
      const expanded = currentFolds.get(foldKey) ?? currentFolds.get(`${legacyKey}-tool-${next.toolCallId || next.id}`);if (expanded !== undefined) result.setOpen(expanded);
    };
    update(message,folds);return {part: result,key: foldKey,update};
  }
  const update = (tools: readonly ToolMessage[],currentFolds: ReadonlyMap<string,boolean>) => {
    label.update({text: groupLabel(tools)});count.update({text: `${tools.length} ${tools.length === 1 ? 'call' : 'calls'}`});
    const failures = tools.filter(tool => tool.status === 'error').length,active = tools.filter(tool => tool.status === 'running').length;
    if (failures) {failed ??= createMetadataPart({purpose: 'state',tone: 'error',text: ''});failed.update({text: `${failures} failed`,tone: 'error'});} else {failed?.destroy();failed = undefined;}
    if (active) {running ??= createMetadataPart({purpose: 'state',tone: 'active',text: ''});running.update({text: `${active} running`,tone: 'active'});} else {running?.destroy();running = undefined;}
    part.replaceSummary([icon,label,count,...(failed ? [failed] : []),...(running ? [running] : []),chevron]);
    const keep = new Set(tools.map(tool => tool.id));for (const [id,entry] of entries) if (!keep.has(id)) {entry.part.destroy();entries.delete(id);}
    const children: Part[] = [];
    for (const tool of tools) {
      let entry = entries.get(tool.id);
      if (entry && entry.key !== `${key}-tool-${tool.toolCallId || tool.id}`) {entry.part.destroy();entries.delete(tool.id);entry = undefined;}
      if (!entry) {entry = makeResult(tool);entries.set(tool.id,entry);}else entry.update(tool,currentFolds);children.push(entry.part);
    }
    content.replace(children);
    const expanded = currentFolds.get(key) ?? currentFolds.get(legacyKey);if (expanded !== undefined) part.setOpen(expanded);
  };
  update(initial,folds);
  return {part,update,folds() {return new Map([[key,part.isOpen()],...[...entries.values()].map(entry => [entry.key,entry.part.isOpen()] as const)]);}};
}
