import type { ModelsJsonModel as ModelDefinition } from './contract.generated.ts';
import type { SDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { escape } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type API = Pick<SDKFeatureAPI, 'request' | 'settings'>;
export function createCustomUI(api: API, dialog: SDKDialog) {
    const { open, act, fail } = dialog;
    async function custom(id?: string) {
        const seq = open(id ? 'Edit model connection' : 'Add model connection', '<p>Loading…</p>');
        const connection = id ? await api.request('/api/custom-connection', { query: { id } }) : { name: '', baseUrl: '', api: 'openai-completions', models: [{ id: '', contextWindow: 128000, maxTokens: 8192 }] };
        if (!dialog.current(seq))
            return;
        const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'];
        open(id ? 'Edit model connection' : 'Add model connection', `<p class="modal-description">Give this endpoint its own name. It can coexist with official providers and other compatible endpoints.</p><form id="custom-form"><label class="field-label">Connection name<input id="custom-name" required value="${escape(connection.name)}" /></label><label class="field-label">API base URL<input id="custom-url" type="url" required value="${escape(connection.baseUrl)}" placeholder="https://example.com/v1" /></label><label class="field-label">API protocol<select id="custom-api" class="feature-select">${protocols.map((p) => `<option ${connection.api === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label class="field-label">API key<input id="custom-key" type="password" autocomplete="new-password" placeholder="${id ? 'Leave blank to keep the key at the same endpoint' : 'API key (optional for local endpoints)'}" /></label><div id="custom-models"></div><button type="button" class="secondary-button" id="add-custom-model">Add model</button><p class="field-hint">Limits and capabilities are provided by you. Prices are USD per million tokens. Fill all four rates (0 for free/unused), or leave all four blank for unknown prices.</p><div class="modal-footer"><button type="button" class="secondary-button" data-close="sdk-dialog">Cancel</button><button class="primary-button" type="submit">Save connection</button></div></form>`);
        const models = [...(connection.models || [])];
        const row = (model: ModelDefinition, index: number) => `<fieldset class="custom-model" data-model-index="${index}"><legend>Model ${index + 1}</legend><label>Model ID<input name="id" required value="${escape(model.id)}" /></label><label>Display name<input name="name" value="${escape(model.name || '')}" /></label><div class="sdk-grid"><label>Context tokens<input name="contextWindow" type="number" min="1" required value="${model.contextWindow}" /></label><label>Max output tokens<input name="maxTokens" type="number" min="1" required value="${model.maxTokens}" /></label></div><div class="sdk-grid"><label class="checkbox-field"><input name="reasoning" type="checkbox" ${model.reasoning ? 'checked' : ''} />Thinking effort</label><label class="checkbox-field"><input name="images" type="checkbox" ${model.input?.includes('image') ? 'checked' : ''} />Images</label></div><details class="provider-advanced"><summary>Price estimate (optional)</summary><div class="sdk-grid">${(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((rate) => `<label>${({ input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" } as Record<string, string>)[rate]}<input name="price-${rate}" type="number" min="0" step="any" value="${model.cost?.[rate] ?? ''}" /></label>`).join('')}</div></details><button type="button" class="secondary-button destructive-button" data-remove-model>Remove model</button></fieldset>`;
        $('custom-models').innerHTML = models.map(row).join('');
        $('add-custom-model').onclick = () => { const i = models.length; const m = { id: '', contextWindow: 128000, maxTokens: 8192 }; models.push(m); $('custom-models').insertAdjacentHTML('beforeend', row(m, i)); };
        $('custom-models').onclick = (event) => { (event.target as HTMLElement).closest('[data-remove-model]')?.closest('fieldset')?.remove(); };
        $('custom-form').onsubmit = async (event) => {
            event.preventDefault();
            const fields = Array.from(document.querySelectorAll<HTMLFieldSetElement>('#custom-models fieldset'));
            for (const field of fields) {
                const rates = Array.from(field.querySelectorAll<HTMLInputElement>('[name^="price-"]')).map((input) => input.value);
                if (rates.some(Boolean) && rates.some((value) => value === '')) {
                    fail('Enter all four rates, using 0 for a free or unused category, or leave all four blank for unknown prices.');
                    return;
                }
            }
            const definitions = fields.map((field) => {
                const value = (name: string) => field.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
                const prices = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
                const model: ModelDefinition = { ...models[Number(field.dataset.modelIndex)], id: value('id').value.trim(), name: value('name').value.trim(), contextWindow: Number(value('contextWindow').value), maxTokens: Number(value('maxTokens').value), reasoning: value('reasoning').checked, input: value('images').checked ? ['text', 'image'] : ['text'] };
                if (prices.some((p) => value(`price-${p}`).value !== ''))
                    model.cost = { ...model.cost, input: Number(value('price-input').value || 0), output: Number(value('price-output').value || 0), cacheRead: Number(value('price-cacheRead').value || 0), cacheWrite: Number(value('price-cacheWrite').value || 0) };
                else
                    delete model.cost;
                return model;
            });
            if (await act('/api/custom-connection', { id: id || '', name: $<HTMLInputElement>('custom-name').value, baseUrl: $<HTMLInputElement>('custom-url').value, api: $<HTMLSelectElement>('custom-api').value, apiKey: $<HTMLInputElement>('custom-key').value, models: definitions })) {
                $<HTMLDialogElement>('sdk-dialog').close();
                api.settings();
            }
        };
    }
    return { custom };
}
