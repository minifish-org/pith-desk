import type { CustomConnectionSession, LoadingSession } from 'pith-ui/app';
import type { ModelsJsonModel as ModelDefinition } from './contract.generated.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
type API = Pick<SDKFeatureAPI, 'ui' | 'request' | 'settings' | 'mutate' | 'error'>;
export function createCustomUI(api: API) {
    let destroyed = false, generation = 0;
    let loading: LoadingSession | undefined, current: CustomConnectionSession | undefined;
    async function custom(id?: string) {
        if (destroyed) return;
        const sequence = ++generation;
        const pending = api.ui.settings.openConnectionLoading({editing: !!id}); loading = pending;
        let connection;
        try { connection = id ? await api.request('/api/custom-connection', { query: { id } }) : { name: '', baseUrl: '', api: 'openai-completions', models: [{ id: '', contextWindow: 128000, maxTokens: 8192 }] }; }
        catch (error) {if (!destroyed && generation === sequence && pending.isOpen()) pending.fail(String(error)); return;}
        if (destroyed || generation !== sequence || !pending.isOpen())
            return;
        const models = [...(connection.models || [])];
        const editor = api.ui.settings.openCustomConnection({name: connection.name, baseUrl: connection.baseUrl, api: connection.api, editing: !!id, models}, {onSubmit: async draft => {
            for (const field of draft.models) {
                const rates = Object.values(field.prices);
                if (rates.some(Boolean) && rates.some((value) => value === '')) {
                    return {ok:false,error:'Enter all four rates, using 0 for a free or unused category, or leave all four blank for unknown prices.'};
                }
            }
            const definitions = draft.models.map((field) => {
                const model: ModelDefinition = {...models[field.sourceIndex], id: field.id, name: field.name, contextWindow: field.contextWindow, maxTokens: field.maxTokens, reasoning: field.reasoning, input: field.images ? ['text', 'image'] : ['text']};
                if (Object.values(field.prices).some((value) => value !== ''))
                    model.cost = {...model.cost, input: Number(field.prices.input || 0), output: Number(field.prices.output || 0), cacheRead: Number(field.prices.cacheRead || 0), cacheWrite: Number(field.prices.cacheWrite || 0)};
                else delete model.cost;
                return model;
            });
            if (await api.mutate('/api/custom-connection', { id: id || '', name: draft.name, baseUrl: draft.baseUrl, api: draft.api, apiKey: draft.apiKey, models: definitions })) {
                if (destroyed || generation !== sequence || !editor.isOpen()) return {ok:true};
                editor.close();
                api.settings();
                return {ok:true};
            }
            return {ok:false,error:api.error()};
        }});
        current = editor;
    }
    return { custom, destroy() {if (destroyed) return; destroyed = true; generation++; loading?.destroy(); current?.destroy();} };
}
