import {resolve} from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

// Keep the test/dev HMR socket behind the shared authenticated Host origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {alias: {'@': resolve(import.meta.dirname, './src')}},
  server: {hmr: {path: '/__desk_hmr'}},
});
