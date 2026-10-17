// A fixed rendering windowBytes, never a file acceptance cap. Split valid UTF-8 at
// complete lines when practical. This content algorithm deliberately stays in
// the application recipe rather than the formal pagination component.
export const previewPageBytes = 256 * 1024;
export function previewPageRanges(bytes: Uint8Array, windowBytes = previewPageBytes): Array<[number,number]> {
  if (windowBytes < 4) throw new RangeError('A preview windowBytes must fit a UTF-8 character');
  const ranges: Array<[number,number]> = [];
  for (let start = 0;start < bytes.length;) {
    let end = Math.min(start + windowBytes,bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end < bytes.length) for (let index = end - 1;index >= start + windowBytes / 2 - 1;index--) if (bytes[index] === 10) {end = index + 1;break;}
    ranges.push([start,end]);start = end;
  }
  return ranges.length ? ranges : [[0,0]];
}
