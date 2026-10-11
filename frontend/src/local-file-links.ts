// A local link is a workspace path, never a browser navigation or a remote share.
// The authenticated host validates the path again against its conversation.
export function localFilePath(href: string): string | null {
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  let path: string;
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname && url.hostname !== 'localhost') return null;
      path = url.pathname;
    } catch { return null; }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[#?]/.test(href) || href.startsWith('//') || href.includes('\\')) return null;
    path = href.split(/[?#]/, 1)[0];
  }
  try { path = decodeURIComponent(path); } catch { /* Literal percent signs are valid in filenames. */ }
  return path && !/[\u0000-\u001f\u007f]/.test(path) ? path : null;
}
