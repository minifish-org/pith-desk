// Use a browser download so the host/browser owns the destination prompt.
// Cancellation is a native action and never triggers an automatic retry.
export async function saveBlob(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  // Keep the object URL and anchor alive long enough for the browser to start
  // the download; removing synchronously can cancel it on mobile engines.
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}
