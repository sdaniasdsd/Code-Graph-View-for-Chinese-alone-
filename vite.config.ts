import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Electron loads the production renderer from file://, so assets must be relative.
  base: './',
  root: resolve(__dirname),
  build: { outDir: 'dist', emptyOutDir: true },
});
