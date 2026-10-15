import { createCustomConnectionEditor, createFeatureStatus } from 'pith-ui';
import type { ModelsJsonModel as ModelDefinition } from './contract.generated.ts';
import type { SDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type API = Pick<SDKFeatureAPI, 'request' | 'settings'>;
export function createCustomUI(api: API, dialog: SDKDialog) {
    const { open, act, fail } = dialog;
    async function custom(id?: string) {
        const seq = open(id ? 'Edit model connection' : 'Add model connection', createFeatureStatus({message: 'Loading…'}));
        const connection = id ? await api.request('/api/custom-connection', { query: { id } }) : { name: '', baseUrl: '', api: 'openai-completions', models: [{ id: '', contextWindow: 128000, maxTokens: 8192 }] };
        if (!dialog.current(seq))
            return;
        const models = [...(connection.models || [])];
        const editor = createCustomConnectionEditor({name: connection.name, baseUrl: connection.baseUrl, api: connection.api, editing: !!id, models}, {idPrefix: ''});
        open(id ? 'Edit model connection' : 'Add model connection', editor);
        $('custom-form').onsubmit = async (event) => {
            event.preventDefault();
            const draft = editor.read();
            for (const field of draft.models) {
                const rates = Object.values(field.prices);
                if (rates.some(Boolean) && rates.some((value) => value === '')) {
                    fail('Enter all four rates, using 0 for a free or unused category, or leave all four blank for unknown prices.');
                    return;
                }
            }
            const definitions = draft.models.map((field) => {
                const model: ModelDefinition = {...models[field.sourceIndex], id: field.id, name: field.name, contextWindow: field.contextWindow, maxTokens: field.maxTokens, reasoning: field.reasoning, input: field.images ? ['text', 'image'] : ['text']};
                if (Object.values(field.prices).some((value) => value !== ''))
                    model.cost = {...model.cost, input: Number(field.prices.input || 0), output: Number(field.prices.output || 0), cacheRead: Number(field.prices.cacheRead || 0), cacheWrite: Number(field.prices.cacheWrite || 0)};
                else delete model.cost;
                return model;
            });
            if (await act('/api/custom-connection', { id: id || '', name: draft.name, baseUrl: draft.baseUrl, api: draft.api, apiKey: draft.apiKey, models: definitions })) {
                $<HTMLDialogElement>('sdk-dialog').close();
                api.settings();
            }
        };
    }
    return { custom };
}
