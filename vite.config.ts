import { defineConfig } from 'vite';
import { csp } from './build/vite-plugins.ts';
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 4000 },
  server: { port: 5173 },
  plugins: [csp()],
});
