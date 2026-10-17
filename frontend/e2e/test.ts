import { test as base, expect, selectors } from '@playwright/test';
import { controlQueries } from './queries';
await selectors.register('ui', controlQueries);
export const test = base.extend<{
    semanticQueries: void;
}>({ semanticQueries: [async ({ page }, use) => { await page.addInitScript(`{const queries=(${controlQueries.toString()})();window.uiQuery=selector=>queries.query(document,selector);window.uiQueryAll=selector=>queries.queryAll(document,selector);}`); await use(); }, { auto: true }] });
export { expect };
