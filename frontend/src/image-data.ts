// Decode locally in small pieces so large previews can yield or be cancelled.
export async function imagePreviewBlob(data: string, mimeType: string, active: () => boolean = () => true): Promise<Blob | null> {
  const parts: BlobPart[] = [];
  const chunkSize = 256 * 1024; // Base64 boundaries must be a multiple of four.
  for (let offset = 0, chunk = 0; offset < data.length; offset += chunkSize, chunk++) {
    if (!active()) return null;
    const decoded = atob(data.slice(offset, offset + chunkSize));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    parts.push(bytes);
    if (chunk % 8 === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return active() ? new Blob(parts, { type: mimeType }) : null;
}
