import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env['RELIEF_API_ORIGIN'] ?? 'http://127.0.0.1:8443';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': api, '/health': api } },
});
