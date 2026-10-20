import {defineConfig} from 'vite';

// Keep the test/dev HMR socket behind the shared authenticated Host origin.
export default defineConfig({server: {hmr: {path: '/__desk_hmr'}}});
