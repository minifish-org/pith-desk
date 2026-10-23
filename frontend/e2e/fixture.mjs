export function installFixture() {
    window.review = { failState: false, holdModels: false, holdProbe: false, failMutation: '', requests: [], drafts: {} };
    const settings = { provider: 'custom-test', modelName: 'Review fixture', thinkingLevel: 'off', thinkingLevels: ['off'], baseUrl: '', model: 'test', hasApiKey: true, hasConnections: true, appearance: 'light', supportsImages: true, imageUploadLimit: 50000000 };
    const runtime = { phase: '', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { total: 0, runTotal: 0, requestCount: 0, unknownRequests: 0, runRequests: 0, runUnknownRequests: 0 }, timing: { elapsedMs: 0, outputTokens: 0 }, contextTokens: 0, contextWindow: 100000, compactions: 0, toolFailures: 0 };
    window.reviewState = { settings, runtime, workspaces: [{ id: 'w', name: 'Review workspace', path: '/tmp/pith-review' }, { id: 'other', name: 'Other workspace', path: '/tmp/pith-other' }], conversations: ['a','b'].map(id => ({ id, title: 'Conversation ' + id, workspaceId: 'w', updatedAt: '', permissionMode: 'ask' })), activeId: 'a', messages: [{ id: 'user', role: 'user', text: 'Stable historical text to select' }, { id: 'old-answer', role: 'assistant', text: '```js\n' + 'const veryLongIdentifier = 123456789; '.repeat(100) + '\n```', status: 'done' }, { id: 'answer', role: 'assistant', text: 'A streaming answer', status: 'streaming' }], queuedMessages: [], running: false, runs: [] };
    const models = { providers: [{ id: 'custom-test', name: 'Review fixture', hasApiKey: true, hasSavedKey: true, custom: true, baseUrl: '', model: 'test', thinkingLevel: 'off' }], models: [{ id: 'test', provider: 'custom-test', name: 'Fixture', thinkingLevels: ['off'], supportsImages: true, contextWindow: 100000, maxTokens: 10000 }] };
    window.review.models = models;
    let mcp = [{ oauth: false, signedIn: false, name: 'fixture-tools', type: 'http', url: 'http://localhost/mcp', args: [], enabled: false, hasBearerToken: false, status: 'disconnected', toolCount: 0, envKeys: [] }];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const target = new URL(url, location.href), path = target.pathname;
      if (!path.startsWith('/api/')) return originalFetch(url, options);
      window.review.requests.push({ path, query: Object.fromEntries(target.searchParams), method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : undefined });
      if (options?.method === 'POST' && path === window.review.failMutation) return Response.json({ error: 'Fixture action rejected' }, { status: 409 });
      if (path === '/api/conversation-file') {
        if (options?.method === 'POST') {
          const input = JSON.parse(options.body);
          if (window.review.holdSave) await new Promise(resolve => window.releaseSave = resolve);
          return Response.json({ native: !!window.review.nativeDownload, name: input.path.split('/').at(-1) });
        }
        return new Response(new Uint8Array([80, 75, 3, 4, 0, 255]), { headers: { 'Content-Type': 'application/octet-stream' } });
      }
      if (path === '/api/test-provider-connection') { if (window.review.holdProbe) await new Promise(resolve => window.releaseProbe = resolve); return Response.json({ ok: true, message: 'Fixture connected' }); }
      if (path === '/api/resource-content') return Response.json({ content: '# Saved instructions' });
      if (path === '/api/state' && window.review.failState) { window.review.failState = false; return Response.json({ error: 'Snapshot unavailable after successful mutation' }, { status: 503 }); }
      if (path === '/api/models') {
        if (window.review.holdModels) await new Promise(resolve => window.releaseModels = resolve);
        return Response.json(models);
      }
      if (path === '/api/conversations') {
        const id = 'created-' + window.reviewState.conversations.length;
        window.reviewState.conversations.push({ id, title: 'New conversation', workspaceId: 'w', permissionMode: 'ask', updatedAt: '' });
        window.reviewState.activeId = id; window.reviewState.messages = [];
        window.review.failState = true;
        return Response.json({ conversation: window.reviewState.conversations.at(-1) });
      }
      if (path === '/api/open') { window.reviewState.activeId = JSON.parse(options.body).id; return Response.json({ ok: true }); }
      if (path === '/api/permissions' && options?.method === 'POST') {
        const input = JSON.parse(options.body), conversation = window.reviewState.conversations.find(entry => entry.id === input.id);
        if (conversation) conversation.permissionMode = input.mode;
        return Response.json({ ok: true });
      }
      if (path === '/api/draft') {
        if (options?.method === 'POST') { const draft = JSON.parse(options.body); window.review.drafts[draft.id || draft.workspaceId] = draft; return Response.json({}); }
        return Response.json(window.review.drafts[target.searchParams.get('id') || target.searchParams.get('workspaceId')] || { text: '', revision: 0 });
      }
      if (path === '/api/custom-connection') return Response.json({ id: 'custom-test', name: 'Review fixture', baseUrl: 'http://localhost/v1', api: 'openai-completions', models: [{ id: 'test', contextWindow: 100000, maxTokens: 10000 }] });
      if (path === '/api/mcp') return Response.json(mcp);
      if (path === '/api/mcp/remove' && options?.method === 'POST') {
        const name = JSON.parse(options.body).name, before = mcp.length;
        mcp = mcp.filter(entry => entry.name !== name);
        return before === mcp.length ? Response.json({error: 'MCP server not found'}, {status: 404}) : Response.json({});
      }
      if (path === '/api/resources') return Response.json(window.review.resources || { instructions: [], skills: [], templates: [], diagnostics: [] });
      if (path === '/api/update') return Response.json({ version: 'review', enabled: false, phase: 'disabled', availableVersion: '', progress: 0, message: 'Local review fixture' });
      if (path === '/api/artifacts') return Response.json([]);
      return Response.json(path === '/api/state' ? window.reviewState : {});
    };
    window.WebSocket = class { constructor() { window.reviewSocket = this; setTimeout(() => this.onopen?.(), 0); } close() {} };
    window.emitReview = () => window.reviewSocket.onmessage({ data: JSON.stringify(window.reviewState) });
}
