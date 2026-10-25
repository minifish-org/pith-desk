import type {Message} from '@/contract.generated.ts';

/** True when two wire messages project the same UI. Used to keep unchanged
 * transcript rows and snapshots on their previous references while streaming. */
export function sameMessage(a: Message, b: Message): boolean {
  return a.id === b.id
    && a.role === b.role
    && a.text === b.text
    && a.status === b.status
    && a.timestamp === b.timestamp
    && a.toolName === b.toolName
    && a.toolCallId === b.toolCallId
    && a.branchNodeId === b.branchNodeId
    && sameCommand(a.command, b.command)
    && sameImages(a.images, b.images);
}

export function sameMessages(a: readonly Message[], b: readonly Message[]): boolean {
  return a === b || a.length === b.length && a.every((message, index) => sameMessage(message, b[index]));
}

function sameCommand(a: Message['command'], b: Message['command']): boolean {
  return a === b || !!(a && b && a.text === b.text && a.cwd === b.cwd && a.exitCode === b.exitCode);
}

function sameImages(a: Message['images'], b: Message['images']): boolean {
  return a === b || !!(a && b && a.length === b.length && a.every((image, index) => image.index === b[index].index && image.mimeType === b[index].mimeType));
}
