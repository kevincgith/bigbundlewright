import { defineConfig } from 'vite';
import { csp } from './build/vite-plugins.ts';
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // Never inline assets as data: URLs (fonts must load as files under the CSP's font-src 'self').
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 6000, assetsInlineLimit: 0 },
  server: { port: 5173 },
  plugins: [csp()],
});
