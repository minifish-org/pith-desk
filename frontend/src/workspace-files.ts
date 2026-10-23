const imageExtension = /\.(?:png|jpe?g|gif|webp)$/i;

export function isImagePath(path: string): boolean {
  try { if (/^file:/i.test(path)) path = new URL(path).pathname; } catch { return false; }
  return imageExtension.test(path);
}

// File.name and webkitRelativePath do not establish a local file's identity.
// Desktop browser harnesses may resolve complete URIs; Server must never infer
// server identity from a browser-local path, even when the same path exists.
export function localFileURIs(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || line.startsWith('#')) return false;
    try {
      const url = new URL(line);
      return url.protocol === 'file:' && !url.username && !url.password && (!url.host || url.host === 'localhost') && !url.search && !url.hash;
    } catch { return false; }
  });
}
