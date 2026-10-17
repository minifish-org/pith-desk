export async function verifyScroll(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 500;
    const context = canvas.getContext('2d');
    context.fillStyle = '#5195ac'; context.fillRect(0, 0, 600, 500);
    const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const settings = { provider: 'test', modelName: 'Scroll test', thinkingLevel: 'off', thinkingLevels: ['off'], baseUrl: '', model: 'test', hasApiKey: true, hasConnections: false, appearance: 'light', supportsImages: true, imageUploadLimit: 50000000 };
    const runtime = { phase: 'streaming', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { total: 0, runTotal: 0, requestCount: 0, unknownRequests: 0, runRequests: 0, runUnknownRequests: 0 }, timing: { elapsedMs: 0, outputTokens: 0 }, contextTokens: 0, contextWindow: 100000, compactions: 0, toolFailures: 0 };
    window.scrollState = { settings, runtime, workspaces: [{ id: 'w', name: 'Scroll verification', path: '/tmp/pith-scroll' }], conversations: ['a', 'b'].map(id => ({ id, title: 'Image scrolling ' + id, workspaceId: 'w', updatedAt: '', permissionMode: 'read-only' })), activeId: 'a', messages: [], queuedMessages: [], running: true, runs: [] };
    const fetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname;
      if (!path.startsWith('/api/')) return fetch(url, options);
      if (path === '/api/image') { await new Promise(resolve => setTimeout(resolve, 120)); return new Response(png, { headers: { 'Content-Type': 'image/png' } }); }
      return Response.json(path === '/api/state' ? window.scrollState : path === '/api/draft' ? { text: '', revision: 0, images: [] } : path === '/api/artifacts' ? [] : {});
    };
    window.WebSocket = class {
      constructor() { window.scrollSocket = this; setTimeout(() => this.onopen?.(), 0); }
      close() {}
    };
    window.emitScrollState = () => window.scrollSocket.onmessage({ data: JSON.stringify(window.scrollState) });
  });
  await page.goto('/');
  await page.waitForFunction(() => window.scrollSocket?.onmessage);
  const results = await page.evaluate(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const pause = async ms => {
      await new Promise(resolve => setTimeout(resolve, ms));
      // Read positions after paint and its ResizeObserver follow-up. A fixed
      // 65 ms timer can run before WebKit paints on a slower CI machine.
      await frame(); await frame();
    };
    const scroll = document.querySelector('.pui-chat-scroll');
    const gap = () => Math.round(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
    const messages = withImages => Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', text: ('Message ' + i + ' with enough text to wrap. ').repeat(8), ...(withImages && i === 10 ? { images: [{ index: 0, mimeType: 'image/png' }] } : {}) }));
    const emit = () => window.emitScrollState();
    let imageNodesReused = true;
    async function stream(withImages) {
      window.scrollState.messages = messages(withImages); emit(); await pause(400);
      document.querySelector('.pui-back-to-latest').click(); await pause(80);
      const initialImage = document.querySelector('.pui-history-image');
      const gaps = [];
      for (let i = 0; i < 12; i++) {
        window.scrollState.messages.at(-1).text += '\nNew streaming line ' + i + '. '.repeat(20); emit(); await pause(65); gaps.push(gap());
        if (withImages) imageNodesReused &&= initialImage === document.querySelector('.pui-history-image');
      }
      await pause(300); gaps.push(gap());
      return gaps;
    }
    const text = await stream(false);
    const image = await stream(true);
    window.scrollState.messages = messages(true); emit(); await pause(350);
    const changingImage = document.querySelector('.pui-history-image');
    changingImage.style.height = '24px'; await pause(100);
    document.querySelector('.pui-back-to-latest').click(); await pause(100);
    // Decoding changes layout just before the next stream snapshot arrives.
    changingImage.style.height = '250px';
    window.scrollState.messages.at(-1).text += '\nConcurrent image decode and stream update.';
    emit(); await pause(250);
    const imageRenderRaceGap = gap();
    document.querySelector('.pui-back-to-latest').click(); await pause(100);
    scroll.scrollTop -= 450; await pause(100);
    const anchor = [...document.querySelectorAll('[data-reading-id]')].find(el => el.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
    const before = anchor.getBoundingClientRect().top;
    window.scrollState.messages.at(-1).text += '\nOutput while reading history. '.repeat(30); emit(); await pause(350);
    const after = document.querySelector('[data-reading-id="' + anchor.dataset.readingId + '"]').getBoundingClientRect().top;
    const reading = { drift: Math.round(after - before), gap: gap(), latestVisible: !document.querySelector('.pui-back-to-latest').hidden };
    const savedTop = scroll.scrollTop, savedMessages = window.scrollState.messages;
    window.scrollState.activeId = 'b'; window.scrollState.messages = messages(true); emit(); await pause(300);
    const switchedGap = gap();
    window.scrollState.activeId = 'a'; window.scrollState.messages = savedMessages; emit(); await pause(300);
    const switchedReadingDrift = Math.round(scroll.scrollTop - savedTop);
    document.querySelector('.pui-back-to-latest').click(); await pause(100);
    const resumedGap = gap();
    document.querySelector('textarea[aria-label="Message Pith"]').value = 'A multi-line draft\n'.repeat(8);
    document.querySelector('textarea[aria-label="Message Pith"]').dispatchEvent(new Event('input', { bubbles: true }));
    await pause(100);
    return { text, image, imageNodesReused, imageRenderRaceGap, reading, switchedGap, switchedReadingDrift, resumedGap, resizedComposerGap: gap() };
  });
  return results;
}
